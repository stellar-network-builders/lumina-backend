const logger = require('../utils/logger');
const { KycStatus, KycNotification } = require('../models');
const { Op } = require('sequelize');

class GDPRComplianceService {
  constructor() {
    this.retentionPeriodYears = 5; // GDPR retention period
  }

  /**
   * Run nightly GDPR compliance check and data deletion
   * @returns {Promise<Object>} Deletion statistics
   */
  async runGDPRComplianceCheck() {
    logger.info('🔍 Starting GDPR compliance check...');

    const results = {
      deletedUsers: 0,
      scrubbedRecords: 0,
      errors: []
    };

    try {
      // 1. Find users who have requested account deletion
      const deletionRequestedUsers = await KycStatus.findAll({
        where: {
          deletion_requested: true,
          is_active: true
        }
      });

      for (const user of deletionRequestedUsers) {
        try {
          await this.scrubUserPII(user);
          results.deletedUsers++;
          logger.info(`✅ Scrubbed PII for deletion-requested user: ${user.user_address}`);
        } catch (error) {
          logger.error(`❌ Failed to scrub user ${user.user_address}:`, error);
          results.errors.push({
            userAddress: user.user_address,
            error: error.message
          });
        }
      }

      // 2. Find users whose KYC data has expired beyond retention period
      const retentionCutoffDate = new Date();
      retentionCutoffDate.setFullYear(retentionCutoffDate.getFullYear() - this.retentionPeriodYears);

      const expiredRetentionUsers = await KycStatus.findAll({
        where: {
          expiration_date: {
            [Op.lt]: retentionCutoffDate
          },
          kyc_status: 'EXPIRED',
          is_active: true,
          deletion_requested: false // Don't double-process
        }
      });

      for (const user of expiredRetentionUsers) {
        try {
          await this.scrubUserPII(user);
          results.scrubbedRecords++;
          logger.info(`✅ Scrubbed PII for expired retention user: ${user.user_address}`);
        } catch (error) {
          logger.error(`❌ Failed to scrub user ${user.user_address}:`, error);
          results.errors.push({
            userAddress: user.user_address,
            error: error.message
          });
        }
      }

      logger.info(`🎉 GDPR compliance check completed. Deleted: ${results.deletedUsers}, Scrubbed: ${results.scrubbedRecords}, Errors: ${results.errors.length}`);

      // Send notification if there were errors
      if (results.errors.length > 0) {
        await this.sendComplianceNotification(results);
      }

      return results;

    } catch (error) {
      logger.error('❌ GDPR compliance check failed:', error);
      throw error;
    }
  }

  /**
   * Scrub Personally Identifiable Information for a user
   * @param {Object} user - KycStatus model instance
   * @returns {Promise<void>}
   */
  async scrubUserPII(user) {
    const scrubbedData = {
      first_name: '[REDACTED]',
      last_name: '[REDACTED]',
      email: '[REDACTED]',
      phone: '[REDACTED]',
      birth_date: null,
      tax_id: '[REDACTED]',
      address_line_1: '[REDACTED]',
      address_line_2: '[REDACTED]',
      city: '[REDACTED]',
      state: '[REDACTED]',
      postal_code: '[REDACTED]',
      country: '[REDACTED]',
      id_document_number: '[REDACTED]',
      id_document_type: '[REDACTED]',
      id_document_issuer: '[REDACTED]',
      id_document_expiry: null,
      ip_address: '[REDACTED]',
      user_agent: '[REDACTED]',
      // Keep non-PII data
      // kyc_status, risk_level, expiration_date, etc. remain for compliance tracking
      scrubbed_at: new Date(),
      is_active: false // Mark as inactive
    };

    await user.update(scrubbedData);

    // Also scrub any associated notifications
    await KycNotification.update(
      {
        message: '[REDACTED - GDPR COMPLIANCE]',
        notification_type: 'GDPR_SCRUBBED'
      },
      {
        where: { kyc_id: user.id }
      }
    );

    // Log the scrubbing action for audit purposes
    logger.info(`🔒 GDPR PII scrubbing completed for user ${user.user_address} at ${new Date().toISOString()}`);
  }

  /**
   * Send compliance notification for GDPR processing results
   * @param {Object} results - Processing results
   * @returns {Promise<void>}
   */
  async sendComplianceNotification(results) {
    try {
      const notificationService = require('./notificationService');

      const message = `GDPR Compliance Check Completed:
- Users deleted by request: ${results.deletedUsers}
- Records scrubbed (expired retention): ${results.scrubbedRecords}
- Processing errors: ${results.errors.length}

${results.errors.length > 0 ? `Errors encountered: ${results.errors.map(e => `${e.userAddress}: ${e.error}`).join(', ')}` : 'No errors encountered.'}`;

      await notificationService.sendSlackNotification(
        'compliance-alerts',
        'GDPR Compliance Report',
        message,
        'warning'
      );
    } catch (error) {
      logger.error('Failed to send GDPR compliance notification:', error);
    }
  }

  /**
   * Get GDPR compliance statistics
   * @returns {Promise<Object>} Compliance statistics
   */
  async getComplianceStats() {
    const retentionCutoffDate = new Date();
    retentionCutoffDate.setFullYear(retentionCutoffDate.getFullYear() - this.retentionPeriodYears);

    const [
      pendingDeletionUsers,
      expiredRetentionUsers,
      recentlyScrubbedUsers
    ] = await Promise.all([
      KycStatus.count({
        where: {
          deletion_requested: true,
          is_active: true
        }
      }),
      KycStatus.count({
        where: {
          expiration_date: {
            [Op.lt]: retentionCutoffDate
          },
          kyc_status: 'EXPIRED',
          is_active: true,
          deletion_requested: false
        }
      }),
      KycStatus.count({
        where: {
          scrubbed_at: {
            [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
          }
        }
      })
    ]);

    return {
      retentionPeriodYears: this.retentionPeriodYears,
      pendingDeletionUsers,
      expiredRetentionUsers,
      recentlyScrubbedUsers,
      nextScheduledRun: this.getNextScheduledRun()
    };
  }

  /**
   * Get next scheduled run time (for display purposes)
   * @returns {Date} Next run time
   */
  getNextScheduledRun() {
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setDate(nextRun.getDate() + 1); // Tomorrow
    nextRun.setHours(2, 0, 0, 0); // 2 AM
    return nextRun;
  }
}

module.exports = GDPRComplianceService;