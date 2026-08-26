const logger = require('../utils/logger');
const axios = require('axios');
const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  OrganizationWebhook,
  ClaimWebhookDelivery,
  Beneficiary,
  Vault,
} = require('../models');
const idempotencyKeyService = require('./idempotencyKeyService');

class ClaimWebhookDispatcherService {
  constructor() {
    this.retryLimit = this.parsePositiveInt(
      process.env.CLAIM_WEBHOOK_RETRY_LIMIT,
      3
    );
    this.timeoutMs = this.parsePositiveInt(
      process.env.CLAIM_WEBHOOK_TIMEOUT_MS,
      5000
    );
    this.initialBackoffMs = this.parsePositiveInt(
      process.env.CLAIM_WEBHOOK_INITIAL_BACKOFF_MS,
      1000
    );
    this.maxBackoffMs = this.parsePositiveInt(
      process.env.CLAIM_WEBHOOK_MAX_BACKOFF_MS,
      30000
    );
    this.signingSecret = process.env.CLAIM_WEBHOOK_SIGNING_SECRET || '';
    this.allowInsecureHttp = process.env.CLAIM_WEBHOOK_ALLOW_INSECURE_HTTP === 'true';
    this.processingDeliveries = new Set();
    this.resumeTimer = null;
  }

  async enqueueTokensClaimedEvent(claimEvent) {
    const payload = this.normalizePayload(claimEvent);
    const organizationIds = await this.resolveOrganizationIds(payload);

    if (organizationIds.length === 0) {
      this.log('warn', 'claim_webhook_no_organizations', {
        eventId: payload.event_id,
        transactionHash: payload.data.transaction_hash,
        beneficiaryAddress: payload.data.beneficiary_address,
      });
      return { endpoints: 0, queued: 0 };
    }

    const webhooks = await OrganizationWebhook.findAll({
      where: {
        organization_id: {
          [Op.in]: organizationIds,
        },
      },
    });

    if (webhooks.length === 0) {
      this.log('warn', 'claim_webhook_no_endpoints', {
        eventId: payload.event_id,
        organizationIds,
      });
      return { endpoints: 0, queued: 0 };
    }

    let queued = 0;

    for (const webhook of webhooks) {
      const validation = this.validateEndpoint(webhook.webhook_url);
      const payloadSignature = this.signPayload(payload);

      const [delivery, created] = await ClaimWebhookDelivery.findOrCreate({
        where: {
          organization_webhook_id: webhook.id,
          event_key: payload.event_id,
        },
        defaults: {
          organization_webhook_id: webhook.id,
          organization_id: webhook.organization_id,
          event_type: payload.event,
          event_key: payload.event_id,
          transaction_hash: payload.data.transaction_hash,
          beneficiary_address: payload.data.beneficiary_address,
          target_url: webhook.webhook_url,
          payload,
          payload_signature: payloadSignature,
          delivery_status: validation.valid ? 'pending' : 'skipped',
          last_error_message: validation.valid ? null : validation.error,
        },
      });

      if (!created) {
        if (delivery.delivery_status === 'success' || delivery.delivery_status === 'skipped') {
          this.log('info', 'claim_webhook_duplicate_skipped', {
            deliveryId: delivery.id,
            eventId: payload.event_id,
            status: delivery.delivery_status,
          });
          continue;
        }
      }

      if (!validation.valid) {
        await delivery.update({
          delivery_status: 'skipped',
          last_error_message: validation.error,
          payload_signature: payloadSignature,
          target_url: webhook.webhook_url,
        });
        this.log('warn', 'claim_webhook_invalid_endpoint', {
          deliveryId: delivery.id,
          eventId: payload.event_id,
          targetUrl: webhook.webhook_url,
          error: validation.error,
        });
        continue;
      }

      await delivery.update({
        payload,
        payload_signature: payloadSignature,
        target_url: webhook.webhook_url,
        last_error_message: null,
        next_attempt_at: new Date(),
      });

      queued += 1;
      this.scheduleDelivery(delivery.id);
    }

    return { endpoints: webhooks.length, queued };
  }

  async processDelivery(deliveryId) {
    if (this.processingDeliveries.has(deliveryId)) {
      return;
    }

    this.processingDeliveries.add(deliveryId);

    try {
      const delivery = await ClaimWebhookDelivery.findByPk(deliveryId);
      if (!delivery) {
        return;
      }

      if (delivery.delivery_status === 'success' || delivery.delivery_status === 'skipped') {
        return;
      }

      const attemptNumber = Number(delivery.attempt_count || 0) + 1;
      const payload = delivery.payload || {};
      const headers = this.buildHeaders(payload, delivery.payload_signature);

      // Generate idempotency key for this delivery
      const idempotencyKey = idempotencyKeyService.generateIdempotencyKey(
        'claim',
        delivery.target_url,
        payload,
        delivery.event_key // Use event_key as the idempotency key
      );

      this.log('info', 'claim_webhook_delivery_attempt', {
        deliveryId,
        eventId: delivery.event_key,
        attempt: attemptNumber,
        targetUrl: delivery.target_url,
        idempotencyKey,
      });

      try {
        // Execute webhook with idempotency protection
        const result = await idempotencyKeyService.executeWithIdempotency(
          'claim',
          delivery.target_url,
          payload,
          async () => {
            const response = await axios.post(delivery.target_url, payload, {
              headers: {
                ...headers,
                'Idempotency-Key': idempotencyKey,
              },
              timeout: this.timeoutMs,
              maxRedirects: 3,
              validateStatus: () => true,
            });

            if (response.status >= 200 && response.status < 300) {
              return {
                success: true,
                responseStatus: response.status,
                responseBody: this.serializeResponseBody(response.data),
              };
            }

            throw this.buildHttpError(response.status, response.data);
          }
        );

        if (result.success) {
          await delivery.update({
            delivery_status: 'success',
            attempt_count: attemptNumber,
            last_attempt_at: new Date(),
            next_attempt_at: null,
            last_http_status: result.responseStatus,
            last_response_body: result.responseBody,
            last_error_message: null,
          });

          this.log('info', 'claim_webhook_delivery_success', {
            deliveryId,
            eventId: delivery.event_key,
            attempt: attemptNumber,
            statusCode: result.responseStatus,
            fromCache: result.fromCache,
          });
          return;
        } else {
          // Handle case where operation was already processed but failed
          throw new Error(result.message || 'Webhook operation failed');
        }
      } catch (error) {
        const shouldRetry = attemptNumber < this.retryLimit && !error.fromCache;
        const nextAttemptAt = shouldRetry
          ? new Date(Date.now() + this.calculateBackoffMs(attemptNumber))
          : null;

        await delivery.update({
          delivery_status: shouldRetry ? 'retrying' : 'failed',
          attempt_count: attemptNumber,
          last_attempt_at: new Date(),
          next_attempt_at: nextAttemptAt,
          last_http_status: error.statusCode || null,
          last_response_body: error.responseBody || null,
          last_error_message: error.message,
        });

        this.log(shouldRetry ? 'warn' : 'error', 'claim_webhook_delivery_failure', {
          deliveryId,
          eventId: delivery.event_key,
          attempt: attemptNumber,
          retrying: shouldRetry,
          error: error.message,
          fromCache: error.fromCache || false,
          nextAttemptAt: nextAttemptAt ? nextAttemptAt.toISOString() : null,
        });

        if (shouldRetry) {
          this.scheduleDelivery(delivery.id, this.calculateBackoffMs(attemptNumber));
        }
      }
    } finally {
      this.processingDeliveries.delete(deliveryId);
    }
  }

  start() {
    if (this.resumeTimer) {
      this.log('info', 'claim_webhook_dispatcher_already_started', {});
      return;
    }

    this.resumePendingDeliveries().catch((error) => {
      this.log('error', 'claim_webhook_resume_failed', { error: error.message });
    });

    this.resumeTimer = setInterval(() => {
      this.resumePendingDeliveries().catch((error) => {
        this.log('error', 'claim_webhook_resume_failed', { error: error.message });
      });
    }, 60000);
  }

  stop() {
    if (this.resumeTimer) {
      clearInterval(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  async resumePendingDeliveries() {
    const pendingDeliveries = await ClaimWebhookDelivery.findAll({
      where: {
        delivery_status: {
          [Op.in]: ['pending', 'retrying'],
        },
        [Op.or]: [
          { next_attempt_at: null },
          { next_attempt_at: { [Op.lte]: new Date() } },
        ],
      },
      limit: 100,
      order: [['created_at', 'ASC']],
    });

    for (const delivery of pendingDeliveries) {
      this.scheduleDelivery(delivery.id);
    }

    if (pendingDeliveries.length > 0) {
      this.log('info', 'claim_webhook_resume_pending', {
        count: pendingDeliveries.length,
      });
    }
  }

  scheduleDelivery(deliveryId, delayMs = 0) {
    const safeDelay = Math.max(0, Number(delayMs) || 0);
    setTimeout(() => {
      this.processDelivery(deliveryId).catch((error) => {
        this.log('error', 'claim_webhook_process_uncaught', {
          deliveryId,
          error: error.message,
        });
      });
    }, safeDelay);
  }

  normalizePayload(claimEvent) {
    const eventId = claimEvent.event_id || this.createEventId(claimEvent);
    const timestamp = claimEvent.claim_timestamp || claimEvent.confirmed_at || new Date().toISOString();

    return {
      event: 'tokens_claimed',
      event_id: eventId,
      source: 'vesting-vault',
      confirmed: true,
      confirmed_at: new Date(timestamp).toISOString(),
      data: {
        beneficiary_address: claimEvent.beneficiary_address || claimEvent.user_address,
        amount: String(claimEvent.amount || claimEvent.amount_claimed || '0'),
        timestamp: new Date(timestamp).toISOString(),
        transaction_hash: claimEvent.transaction_hash,
        block_number: claimEvent.block_number,
        token_address: claimEvent.token_address || null,
        vault_address: claimEvent.vault_address || null,
        organization_id: claimEvent.organization_id || null,
      },
    };
  }

  async resolveOrganizationIds(payload) {
    if (payload.data.organization_id) {
      return [payload.data.organization_id];
    }

    const whereClause = {
      address: payload.data.beneficiary_address,
    };

    const includeVaultWhere = {
      is_active: true,
    };

    if (payload.data.token_address) {
      includeVaultWhere.token_address = payload.data.token_address;
    }

    if (payload.data.vault_address) {
      includeVaultWhere.address = payload.data.vault_address;
    }

    const beneficiaries = await Beneficiary.findAll({
      where: whereClause,
      include: [
        {
          model: Vault,
          as: 'vault',
          required: true,
          attributes: ['id', 'address', 'org_id', 'token_address'],
          where: includeVaultWhere,
        },
      ],
    });

    const organizationIds = beneficiaries
      .map((beneficiary) => beneficiary.vault?.org_id)
      .filter(Boolean);

    return [...new Set(organizationIds)];
  }

  validateEndpoint(endpoint) {
    try {
      const parsed = new URL(endpoint);
      const validProtocols = this.allowInsecureHttp
        ? ['http:', 'https:']
        : ['https:'];

      if (!validProtocols.includes(parsed.protocol)) {
        return {
          valid: false,
          error: `Unsupported webhook protocol: ${parsed.protocol}`,
        };
      }

      return { valid: true };
    } catch (error) {
      return { valid: false, error: 'Invalid webhook URL' };
    }
  }

  buildHeaders(payload, payloadSignature) {
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'VestingVault-ClaimWebhookDispatcher/1.0',
      'X-Vesting-Event': payload.event,
      'X-Vesting-Event-Id': payload.event_id,
      'X-Vesting-Confirmed-At': payload.confirmed_at,
    };

    if (payloadSignature) {
      headers['X-Vesting-Signature'] = payloadSignature;
    }

    return headers;
  }

  signPayload(payload) {
    if (!this.signingSecret) {
      return null;
    }

    return crypto
      .createHmac('sha256', this.signingSecret)
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  createEventId(claimEvent) {
    return crypto
      .createHash('sha256')
      .update(
        [
          claimEvent.transaction_hash,
          claimEvent.user_address || claimEvent.beneficiary_address,
          claimEvent.amount_claimed || claimEvent.amount,
          claimEvent.block_number,
        ].join(':')
      )
      .digest('hex');
  }

  calculateBackoffMs(attemptNumber) {
    const delay = this.initialBackoffMs * (2 ** Math.max(0, attemptNumber - 1));
    return Math.min(delay, this.maxBackoffMs);
  }

  serializeResponseBody(body) {
    if (body === undefined || body === null) {
      return null;
    }

    const value = typeof body === 'string' ? body : JSON.stringify(body);
    return value.slice(0, 4000);
  }

  buildHttpError(statusCode, responseBody) {
    const error = new Error(`Webhook request failed with status ${statusCode}`);
    error.statusCode = statusCode;
    error.responseBody = this.serializeResponseBody(responseBody);
    return error;
  }

  parsePositiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  log(level, event, context) {
    const entry = {
      level,
      event,
      service: 'claim-webhook-dispatcher',
      timestamp: new Date().toISOString(),
      ...context,
    };

    const message = JSON.stringify(entry);
    if (level === 'error') {
      logger.error(message);
      return;
    }

    if (level === 'warn') {
      logger.warn(message);
      return;
    }

    logger.info(message);
  }
}

module.exports = new ClaimWebhookDispatcherService();
module.exports.ClaimWebhookDispatcherService = ClaimWebhookDispatcherService;
