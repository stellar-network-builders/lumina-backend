const logger = require('../utils/logger');
const axios = require('axios');
const idempotencyKeyService = require('./idempotencyKeyService');

class SlackWebhookService {
  constructor() {
    this.webhookUrl = process.env.SLACK_WEBHOOK_URL;
    this.threshold = 10000; // $10,000 USD threshold
  }

  /**
   * Calculate USD value of a claim
   * @param {string|number} amount - Token amount claimed
   * @param {string|number} priceUsd - Token price in USD
   * @returns {number} USD value
   */
  calculateClaimValue(amount, priceUsd) {
    const amountNum = parseFloat(amount);
    const priceNum = parseFloat(priceUsd);
    
    if (isNaN(amountNum) || isNaN(priceNum)) {
      return 0;
    }
    
    return amountNum * priceNum;
  }

  /**
   * Format currency value for display
   * @param {number} value - USD value
   * @returns {string} Formatted currency string
   */
  formatCurrency(value) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
  }

  /**
   * Format address for display (truncate middle)
   * @param {string} address - Wallet address
   * @returns {string} Formatted address
   */
  formatAddress(address) {
    if (!address || address.length < 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  /**
   * Check if claim exceeds threshold
   * @param {number} usdValue - USD value of claim
   * @returns {boolean} True if exceeds threshold
   */
  isLargeClaim(usdValue) {
    return usdValue > this.threshold;
  }

  /**
   * Send large claim alert to Slack
   * @param {Object} claimData - Claim data
   * @param {number} usdValue - USD value of claim
   * @returns {Promise<boolean>} Success status
   */
  async sendLargeClaimAlert(claimData, usdValue) {
    try {
      if (!this.webhookUrl) {
        logger.warn('SLACK_WEBHOOK_URL not set, skipping Slack notification');
        return false;
      }

      const {
        user_address,
        token_address,
        amount_claimed,
        transaction_hash,
        block_number,
        price_at_claim_usd
      } = claimData;

      const payload = {
        text: '🚨 Large Claim Alert',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '🚨 Large Claim Alert',
              emoji: true
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*User:*\n${this.formatAddress(user_address)}`
              },
              {
                type: 'mrkdwn',
                text: `*Amount:*\n${this.formatCurrency(usdValue)}`
              },
              {
                type: 'mrkdwn',
                text: `*Tokens Claimed:*\n${parseFloat(amount_claimed).toLocaleString()}`
              },
              {
                type: 'mrkdwn',
                text: `*Token Price:*\n$${parseFloat(price_at_claim_usd).toFixed(4)}`
              }
            ]
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Token Address:*\n\`${token_address}\``
              },
              {
                type: 'mrkdwn',
                text: `*Block Number:*\n${block_number}`
              }
            ]
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Transaction:*\n<https://etherscan.io/tx/${transaction_hash}|View on Etherscan>`
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Threshold: ${this.formatCurrency(this.threshold)} | Claim exceeds threshold by ${this.formatCurrency(usdValue - this.threshold)}`
              }
            ]
          }
        ]
      };

      // Generate idempotency key for this Slack notification
      const idempotencyKey = idempotencyKeyService.generateIdempotencyKey(
        'slack',
        this.webhookUrl,
        payload,
        `large_claim_${transaction_hash}_${user_address}`
      );

      // Execute Slack webhook with idempotency protection
      const result = await idempotencyKeyService.executeWithIdempotency(
        'slack',
        this.webhookUrl,
        payload,
        async () => {
          const response = await axios.post(this.webhookUrl, payload, {
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': idempotencyKey,
            },
            timeout: 5000 // 5 second timeout
          });

          if (response.status === 200) {
            return {
              success: true,
              responseStatus: response.status,
              responseBody: 'Slack notification sent successfully',
            };
          }

          throw new Error(`Slack webhook failed with status ${response.status}`);
        }
      );

      if (result.success) {
        logger.info(`Slack alert sent for large claim: ${transaction_hash}${result.fromCache ? ' (from cache)' : ''}`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Error sending Slack webhook:', error.message);
      return false;
    }
  }

  /**
   * Format a millisecond duration as a short human-readable string.
   * @param {number|null} ms - Duration in milliseconds
   * @returns {string}
   */
  formatDuration(ms) {
    if (ms === null || ms === undefined || isNaN(ms)) return 'n/a';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  /**
   * Send a circuit-breaker state-change alert to Slack.
   * @param {Object} event - Circuit breaker event
   * @param {string} event.service - Service / dependency name
   * @param {string} event.state - New state ('open' | 'closed' | 'half-open')
   * @param {number} [event.failureCount] - Consecutive failures at trip time
   * @param {number} [event.recoveryLatencyMs] - Time spent open before recovery
   * @param {number} [event.trips] - Total trips observed for this service
   * @returns {Promise<boolean>} Success status
   */
  async sendCircuitBreakerAlert(event) {
    try {
      if (!this.webhookUrl) {
        logger.warn('SLACK_WEBHOOK_URL not set, skipping circuit-breaker Slack notification');
        return false;
      }

      const { service, state, failureCount, recoveryLatencyMs, trips } = event;
      const isOpen = String(state).toLowerCase() === 'open';
      const headline = isOpen
        ? `🔴 Circuit OPEN — ${service}`
        : `🟢 Circuit CLOSED — ${service}`;

      const fields = [
        { type: 'mrkdwn', text: `*Service:*\n${service}` },
        { type: 'mrkdwn', text: `*State:*\n${String(state).toUpperCase()}` }
      ];
      if (isOpen) {
        fields.push({ type: 'mrkdwn', text: `*Failures:*\n${failureCount ?? 'n/a'}` });
        if (trips !== undefined) {
          fields.push({ type: 'mrkdwn', text: `*Total trips:*\n${trips}` });
        }
      } else {
        fields.push({ type: 'mrkdwn', text: `*Recovery time:*\n${this.formatDuration(recoveryLatencyMs)}` });
      }

      const payload = {
        text: headline,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: headline, emoji: true } },
          { type: 'section', fields },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `Circuit breaker • ${new Date().toISOString()}` }]
          }
        ]
      };

      const response = await axios.post(this.webhookUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000
      });

      if (response.status === 200) {
        logger.info(`Slack circuit-breaker alert sent for ${service} (${state})`);
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Error sending circuit-breaker Slack alert:', error.message);
      return false;
    }
  }

  /**
   * Send a daily digest summarising circuit-breaker activity.
   * @param {Array<Object>} summaries - Per-service activity rows
   *   ({ service, state, trips, failureCount })
   * @returns {Promise<boolean>} Success status
   */
  async sendCircuitBreakerDigest(summaries = []) {
    try {
      if (!this.webhookUrl) {
        logger.warn('SLACK_WEBHOOK_URL not set, skipping circuit-breaker digest');
        return false;
      }

      const lines = summaries.length
        ? summaries.map(s => `• *${s.service}* — ${String(s.state).toUpperCase()} | trips: ${s.trips ?? 0} | failures: ${s.failureCount ?? 0}`)
        : ['• No circuit breakers registered'];

      const payload = {
        text: '📊 Circuit Breaker Daily Digest',
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '📊 Circuit Breaker Daily Digest', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: new Date().toISOString() }] }
        ]
      };

      const response = await axios.post(this.webhookUrl, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000
      });
      return response.status === 200;
    } catch (error) {
      logger.error('Error sending circuit-breaker digest:', error.message);
      return false;
    }
  }

  /**
   * Process claim and send alert if it's a large claim
   * @param {Object} claimData - Claim data from database
   * @returns {Promise<boolean>} True if alert was sent
   */
  async processClaimAlert(claimData) {
    try {
      const { amount_claimed, price_at_claim_usd } = claimData;

      // Skip if no price data available
      if (!price_at_claim_usd) {
        return false;
      }

      const usdValue = this.calculateClaimValue(amount_claimed, price_at_claim_usd);

      // Check if claim exceeds threshold
      if (this.isLargeClaim(usdValue)) {
        return await this.sendLargeClaimAlert(claimData, usdValue);
      }

      return false;
    } catch (error) {
      logger.error('Error processing claim alert:', error);
      return false;
    }
  }
}

module.exports = new SlackWebhookService();
