const logger = require('../utils/logger');
const crypto = require('crypto');
const { IdempotencyKey } = require('../models');
const { Op } = require('sequelize');

class IdempotencyKeyService {
  constructor() {
    this.defaultExpirationHours = 24; // Default expiration time
  }

  /**
   * Generate a unique idempotency key
   * @param {string} webhookType - Type of webhook (claim, slack, milestone, email)
   * @param {string} targetEndpoint - Target URL or email
   * @param {Object} payload - The payload object
   * @param {string} [providedKey] - Optional provided idempotency key
   * @returns {string} Generated idempotency key
   */
  generateIdempotencyKey(webhookType, targetEndpoint, payload, providedKey = null) {
    if (providedKey) {
      return providedKey;
    }

    const keyData = {
      webhookType,
      targetEndpoint,
      payload: this.createPayloadHash(payload),
      timestamp: Date.now(),
    };

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(keyData))
      .digest('hex');
  }

  /**
   * Create a hash of the payload for content verification
   * @param {Object} payload - The payload object
   * @returns {string} SHA-256 hash of the payload
   */
  createPayloadHash(payload) {
    const normalizedPayload = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto.createHash('sha256').update(normalizedPayload).digest('hex');
  }

  /**
   * Check if an idempotency key exists and is valid
   * @param {string} key - The idempotency key to check
   * @returns {Promise<Object|null>} Existing record or null
   */
  async checkIdempotencyKey(key) {
    try {
      const record = await IdempotencyKey.findOne({
        where: {
          key,
          expires_at: {
            [Op.gt]: new Date(),
          },
        },
      });

      return record;
    } catch (error) {
      logger.error('Error checking idempotency key:', error);
      throw error;
    }
  }

  /**
   * Create a new idempotency key record
   * @param {string} key - The idempotency key
   * @param {string} webhookType - Type of webhook
   * @param {string} targetEndpoint - Target URL or email
   * @param {Object} payload - The payload object
   * @param {number} [expirationHours] - Custom expiration time in hours
   * @returns {Promise<IdempotencyKey>} Created record
   */
  async createIdempotencyKey(key, webhookType, targetEndpoint, payload, expirationHours = null) {
    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + (expirationHours || this.defaultExpirationHours));

      const payloadHash = this.createPayloadHash(payload);

      const [record, created] = await IdempotencyKey.findOrCreate({
        where: { key },
        defaults: {
          key,
          webhook_type: webhookType,
          target_endpoint: targetEndpoint,
          payload_hash: payloadHash,
          status: 'pending',
          expires_at: expiresAt,
        },
      });

      if (!created) {
        // If record already exists, verify payload matches
        if (record.payload_hash !== payloadHash) {
          throw new Error('Idempotency key exists but payload does not match');
        }
      }

      return record;
    } catch (error) {
      logger.error('Error creating idempotency key:', error);
      throw error;
    }
  }

  /**
   * Update idempotency key status to processing
   * @param {string} key - The idempotency key
   * @returns {Promise<boolean>} Success status
   */
  async markAsProcessing(key) {
    try {
      const [affectedCount] = await IdempotencyKey.update(
        {
          status: 'processing',
          last_attempt_at: new Date(),
          attempt_count: sequelize.literal('attempt_count + 1'),
        },
        {
          where: {
            key,
            status: 'pending',
          },
        }
      );

      return affectedCount > 0;
    } catch (error) {
      logger.error('Error marking idempotency key as processing:', error);
      throw error;
    }
  }

  /**
   * Mark idempotency key as completed successfully
   * @param {string} key - The idempotency key
   * @param {number} [responseStatus] - HTTP status code for webhooks
   * @param {string} [responseBody] - Response body for webhooks
   * @returns {Promise<boolean>} Success status
   */
  async markAsCompleted(key, responseStatus = null, responseBody = null) {
    try {
      const [affectedCount] = await IdempotencyKey.update(
        {
          status: 'completed',
          response_status: responseStatus,
          response_body: responseBody ? responseBody.slice(0, 4000) : null, // Limit response size
          last_attempt_at: new Date(),
        },
        {
          where: { key },
        }
      );

      return affectedCount > 0;
    } catch (error) {
      logger.error('Error marking idempotency key as completed:', error);
      throw error;
    }
  }

  /**
   * Mark idempotency key as failed
   * @param {string} key - The idempotency key
   * @param {string} errorMessage - Error message
   * @returns {Promise<boolean>} Success status
   */
  async markAsFailed(key, errorMessage) {
    try {
      const [affectedCount] = await IdempotencyKey.update(
        {
          status: 'failed',
          error_message: errorMessage ? errorMessage.slice(0, 2000) : null, // Limit error size
          last_attempt_at: new Date(),
        },
        {
          where: { key },
        }
      );

      return affectedCount > 0;
    } catch (error) {
      logger.error('Error marking idempotency key as failed:', error);
      throw error;
    }
  }

  /**
   * Cleanup expired idempotency keys
   * @returns {Promise<number>} Number of deleted records
   */
  async cleanupExpiredKeys() {
    try {
      const deletedCount = await IdempotencyKey.destroy({
        where: {
          expires_at: {
            [Op.lte]: new Date(),
          },
        },
      });

      if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} expired idempotency keys`);
      }

      return deletedCount;
    } catch (error) {
      logger.error('Error cleaning up expired idempotency keys:', error);
      throw error;
    }
  }

  /**
   * Get statistics about idempotency keys
   * @returns {Promise<Object>} Statistics object
   */
  async getStatistics() {
    try {
      const stats = await IdempotencyKey.findAll({
        attributes: [
          'status',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
        ],
        group: ['status'],
        raw: true,
      });

      const total = await IdempotencyKey.count();
      const expired = await IdempotencyKey.count({
        where: {
          expires_at: {
            [Op.lte]: new Date(),
          },
        },
      });

      return {
        total,
        expired,
        byStatus: stats.reduce((acc, stat) => {
          acc[stat.status] = parseInt(stat.count);
          return acc;
        }, {}),
      };
    } catch (error) {
      logger.error('Error getting idempotency key statistics:', error);
      throw error;
    }
  }

  /**
   * Wrapper function to handle idempotency for webhook operations
   * @param {string} webhookType - Type of webhook
   * @param {string} targetEndpoint - Target URL or email
   * @param {Object} payload - The payload object
   * @param {Function} operation - The operation to execute if not already processed
   * @param {string} [providedKey] - Optional provided idempotency key
   * @returns {Promise<Object>} Result of the operation or cached result
   */
  async executeWithIdempotency(webhookType, targetEndpoint, payload, operation, providedKey = null) {
    try {
      const key = this.generateIdempotencyKey(webhookType, targetEndpoint, payload, providedKey);
      
      // Check if already processed
      const existing = await this.checkIdempotencyKey(key);
      
      if (existing) {
        if (existing.status === 'completed') {
          return {
            success: true,
            fromCache: true,
            responseStatus: existing.response_status,
            responseBody: existing.response_body,
            message: 'Operation already completed successfully',
          };
        }
        
        if (existing.status === 'processing') {
          return {
            success: false,
            fromCache: true,
            message: 'Operation currently in progress',
            status: existing.status,
          };
        }
        
        if (existing.status === 'failed') {
          return {
            success: false,
            fromCache: true,
            message: 'Operation previously failed',
            error: existing.error_message,
            status: existing.status,
          };
        }
      }

      // Create new record or use existing
      await this.createIdempotencyKey(key, webhookType, targetEndpoint, payload);
      
      // Mark as processing
      await this.markAsProcessing(key);
      
      try {
        // Execute the operation
        const result = await operation();
        
        // Mark as completed
        await this.markAsCompleted(
          key,
          result.responseStatus,
          result.responseBody
        );
        
        return {
          success: true,
          fromCache: false,
          ...result,
        };
      } catch (error) {
        // Mark as failed
        await this.markAsFailed(key, error.message);
        
        throw error;
      }
    } catch (error) {
      logger.error('Error executing with idempotency:', error);
      throw error;
    }
  }
}

module.exports = new IdempotencyKeyService();
module.exports.IdempotencyKeyService = IdempotencyKeyService;
