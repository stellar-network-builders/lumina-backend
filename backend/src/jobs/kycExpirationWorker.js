'use strict';

const logger = require('../utils/logger');
const { KycStatus } = require('../models');
const { sequelize } = require('../database/connection');
const { Op } = require('sequelize');
const emailService = require('../services/emailService');
const auditLogger = require('../services/auditLogger');

class KycStatusExpirationWorker {
  constructor() {
    this.isRunning = false;
    this.checkInterval = 60 * 60 * 1000; // 1 hour in milliseconds
    this.expirationThresholdDays = 7; // Alert for KYC expiring within 7 days
    this.criticalThresholdDays = 3; // Critical alert for KYC expiring within 3 days
    this.maxRetries = 3;
    this.retryDelay = 5000; // 5 seconds
  }

  /**
   * Start the KYC expiration monitoring worker
   */
  async start() {
    if (this.isRunning) {
      logger.info('KYC expiration worker is already running');
      return;
    }

    try {
      logger.info('🔍 Starting KYC Status Expiration Worker...');
      this.isRunning = true;

      // Run initial check
      await this.checkExpiringStatuses();

      // Start periodic monitoring
      this.startPeriodicCheck();

      logger.info('✅ KYC expiration worker started successfully');
    } catch (error) {
      logger.error('Failed to start KYC expiration worker:', error);
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the KYC expiration monitoring worker
   */
  async stop() {
    this.isRunning = false;
    logger.info('🛑 KYC expiration worker stopped');

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Start periodic checking for expiring KYC statuses
   */
  startPeriodicCheck() {
    this.intervalId = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        await this.checkExpiringStatuses();
      } catch (error) {
        logger.error('Error in periodic KYC expiration check:', error);
        await auditLogger.log({
          action: 'kyc_expiration_worker_error',
          error: error.message,
          timestamp: new Date()
        });
      }
    }, this.checkInterval);
  }

  /**
   * Check for expiring KYC statuses and take appropriate actions
   */
  async checkExpiringStatuses() {
    try {
      logger.info('🔍 Checking for expiring KYC statuses...');

      // Find KYC statuses expiring within threshold periods
      const criticalExpiring = await this.findExpiringStatuses(this.criticalThresholdDays);
      const soonExpiring = await this.findExpiringStatuses(this.expirationThresholdDays);
      const expired = await this.findExpiredStatuses();

      logger.info(`📊 KYC Status Summary:
        - Critical (≤${this.criticalThresholdDays} days): ${criticalExpiring.length}
        - Expiring Soon (≤${this.expirationThresholdDays} days): ${soonExpiring.length}
        - Expired: ${expired.length}`);

      // Process critical expirations first
      if (criticalExpiring.length > 0) {
        await this.processCriticalExpirations(criticalExpiring);
      }

      // Process soon expirations
      if (soonExpiring.length > 0) {
        await this.processSoonExpirations(soonExpiring);
      }

      // Process expired statuses
      if (expired.length > 0) {
        await this.processExpiredStatuses(expired);
      }

      // Update statistics and send summary report
      await this.sendDailySummary();

    } catch (error) {
      logger.error('Error checking expiring KYC statuses:', error);
      await auditLogger.log({
        action: 'kyc_expiration_check_error',
        error: error.message,
        timestamp: new Date()
      });
    }
  }

  /**
   * Find KYC statuses expiring within specified days
   * @param {number} daysThreshold - Days threshold
   * @returns {Promise<Array>} Array of expiring KYC statuses
   */
  async findExpiringStatuses(daysThreshold) {
    const thresholdDate = new Date();
    thresholdDate.setDate(thresholdDate.getDate() - daysThreshold);
    thresholdDate.setHours(0, 0, 0, 0);

    const expiringStatuses = await KycStatus.findAll({
      where: {
        expiration_date: {
          [Op.lte]: thresholdDate,
          [Op.gt]: new Date()
        },
        is_active: true,
        kyc_status: {
          [Op.notIn]: ['EXPIRED', 'SOFT_LOCKED']
        }
      },
      include: [
        {
          model: require('../models').User,
          as: 'user',
          required: false,
          attributes: ['address', 'email']
        }
      ],
      order: [['expiration_date', 'ASC']]
    });

    return expiringStatuses;
  }

  /**
   * Find expired KYC statuses
   * @returns {Promise<Array>} Array of expired KYC statuses
   */
  async findExpiredStatuses() {
    const expiredStatuses = await KycStatus.findAll({
      where: {
        expiration_date: {
          [Op.lte]: new Date()
        },
        is_active: true,
        kyc_status: 'EXPIRED'
      },
      include: [
        {
          model: require('../models').User,
          as: 'user',
          required: false,
          attributes: ['address', 'email']
        }
      ],
      order: [['expiration_date', 'ASC']]
    });

    return expiredStatuses;
  }

  /**
   * Process critical KYC expirations (≤3 days)
   * @param {Array} criticalExpiring - Array of critical expiring KYC statuses
   */
  async processCriticalExpirations(criticalExpiring) {
    logger.info(`🚨 Processing ${criticalExpiring.length} critical KYC expirations...`);

    for (const kycStatus of criticalExpiring) {
      try {
        // Apply immediate soft-lock
        await kycStatus.applySoftLock('CRITICAL: KYC expires in 3 days or less');

        // Send immediate email alert
        await this.sendImmediateAlert(kycStatus, 'critical');

        // Create high-priority notification
        await this.createHighPriorityNotification(kycStatus, {
          type: 'kyc_critical_expiration',
          urgency: 'CRITICAL',
          message: `KYC verification expires in ${kycStatus.days_until_expiration} days`,
          actionRequired: true
        });

        // Log critical event
        await auditLogger.log({
          action: 'kyc_critical_expiration_processed',
          user_address: kycStatus.user_address,
          kyc_status_id: kycStatus.id,
          days_until_expiration: kycStatus.days_until_expiration,
          risk_score: kycStatus.risk_score,
          timestamp: new Date()
        });

      } catch (error) {
        logger.error(`Error processing critical KYC expiration for ${kycStatus.user_address}:`, error);
      }
    }

    logger.info(`✅ Processed ${criticalExpiring.length} critical KYC expirations`);
  }

  /**
   * Process soon expiring KYC statuses (≤7 days)
   * @param {Array} soonExpiring - Array of soon expiring KYC statuses
   */
  async processSoonExpirations(soonExpiring) {
    logger.info(`⚠️ Processing ${soonExpiring.length} soon expiring KYC statuses...`);

    for (const kycStatus of soonExpiring) {
      try {
        // Send warning email alert
        await this.sendWarningAlert(kycStatus);

        // Create medium-priority notification
        await this.createNotification(kycStatus, {
          type: 'kyc_expiration_warning',
          urgency: 'HIGH',
          message: `KYC verification expires in ${kycStatus.days_until_expiration} days`,
          actionRequired: true
        });

        // Log warning event
        await auditLogger.log({
          action: 'kyc_expiration_warning_processed',
          user_address: kycStatus.user_address,
          kyc_status_id: kycStatus.id,
          days_until_expiration: kycStatus.days_until_expiration,
          risk_score: kycStatus.risk_score,
          timestamp: new Date()
        });

      } catch (error) {
        logger.error(`Error processing soon KYC expiration for ${kycStatus.user_address}:`, error);
      }
    }

    logger.info(`✅ Processed ${soonExpiring.length} soon expiring KYC statuses`);
  }

  /**
   * Process expired KYC statuses
   * @param {Array} expired - Array of expired KYC statuses
   */
  async processExpiredStatuses(expired) {
    logger.info(`❌ Processing ${expired.length} expired KYC statuses...`);

    for (const kycStatus of expired) {
      try {
        // Ensure soft-lock is applied
        if (!kycStatus.soft_lock_enabled) {
          await kycStatus.applySoftLock('EXPIRED: KYC verification has expired');
        }

        // Send critical email alert
        await this.sendExpiredAlert(kycStatus);

        // Create critical notification for immediate action
        await this.createHighPriorityNotification(kycStatus, {
          type: 'kyc_expired',
          urgency: 'CRITICAL',
          message: 'KYC verification has expired - immediate re-verification required',
          actionRequired: true
        });

        // Log expired event
        await auditLogger.log({
          action: 'kyc_expired_processed',
          user_address: kycStatus.user_address,
          kyc_status_id: kycStatus.id,
          days_until_expiration: kycStatus.days_until_expiration,
          risk_score: kycStatus.risk_score,
          timestamp: new Date()
        });

        // Update risk score for expired KYC
        await this.updateRiskScore(kycStatus.id, 1.0); // Maximum risk for expired

      } catch (error) {
        logger.error(`Error processing expired KYC for ${kycStatus.user_address}:`, error);
      }
    }

    logger.info(`✅ Processed ${expired.length} expired KYC statuses`);
  }

  /**
   * Send immediate alert for critical situations
   * @param {Object} kycStatus - KYC status record
   * @param {string} alertType - Type of alert
   */
  async sendImmediateAlert(kycStatus, alertType) {
    try {
      const subject = `🚨 CRITICAL: KYC Status Alert - ${kycStatus.user_address}`;
      const message = this.generateCriticalAlertMessage(kycStatus, alertType);

      await emailService.sendEmail({
        to: await this.getUserEmail(kycStatus.user_address),
        subject,
        message,
        priority: 'high'
      });

      logger.info(`📧 Sent immediate alert to ${kycStatus.user_address}: ${subject}`);

    } catch (error) {
      logger.error(`Error sending immediate alert for ${kycStatus.user_address}:`, error);
    }
  }

  /**
   * Send warning alert for soon expiring KYC
   * @param {Object} kycStatus - KYC status record
   */
  async sendWarningAlert(kycStatus) {
    try {
      const subject = `⚠️ KYC Status Expiration Warning - ${kycStatus.user_address}`;
      const message = this.generateWarningAlertMessage(kycStatus);

      await emailService.sendEmail({
        to: await this.getUserEmail(kycStatus.user_address),
        subject,
        message,
        priority: 'medium'
      });

      logger.info(`📧 Sent warning alert to ${kycStatus.user_address}: ${subject}`);

    } catch (error) {
      logger.error(`Error sending warning alert for ${kycStatus.user_address}:`, error);
    }
  }

  /**
   * Send alert for expired KYC
   * @param {Object} kycStatus - KYC status record
   */
  async sendExpiredAlert(kycStatus) {
    try {
      const subject = `❌ KYC Status Expired - ${kycStatus.user_address}`;
      const message = this.generateExpiredAlertMessage(kycStatus);

      await emailService.sendEmail({
        to: await this.getUserEmail(kycStatus.user_address),
        subject,
        message,
        priority: 'high'
      });

      logger.info(`📧 Sent expired alert to ${kycStatus.user_address}: ${subject}`);

    } catch (error) {
      logger.error(`Error sending expired alert for ${kycStatus.user_address}:`, error);
    }
  }

  /**
   * Generate critical alert message
   * @param {Object} kycStatus - KYC status record
   * @param {string} alertType - Type of alert
   * @returns {string} Alert message
   */
  generateCriticalAlertMessage(kycStatus, alertType) {
    const daysUntil = kycStatus.days_until_expiration;
    const riskLevel = kycStatus.risk_level;
    
    let message = `CRITICAL KYC STATUS ALERT\n\n`;
    message += `User Address: ${kycStatus.user_address}\n`;
    message += `KYC Status: ${kycStatus.kyc_status}\n`;
    message += `Days Until Expiration: ${daysUntil}\n`;
    message += `Risk Level: ${riskLevel}\n`;
    message += `Risk Score: ${kycStatus.risk_score}\n`;
    message += `Verification Provider: ${kycStatus.verification_provider || 'N/A'}\n`;
    message += `Last Verification: ${kycStatus.verification_date || 'N/A'}\n`;
    message += `Expiration Date: ${kycStatus.expiration_date}\n`;
    
    if (alertType === 'kyc_critical_expiration') {
      message += `\nIMMEDIATE ACTION REQUIRED:\n`;
      message += `• User must complete re-verification immediately\n`;
      message += `• All claiming functions will be temporarily disabled\n`;
      message += `• Account may be subject to additional restrictions\n`;
    } else if (alertType === 'kyc_expired') {
      message += `\nACCOUNT ACCESS RESTRICTED:\n`;
      message += `• KYC verification has expired\n`;
      message += `• Cannot claim tokens until re-verification is complete\n`;
      message += `• Contact support immediately to restore access\n`;
    }

    message += `\nPlease contact support if you believe this is an error.`;
    
    return message;
  }

  /**
   * Generate warning alert message
   * @param {Object} kycStatus - KYC status record
   * @returns {string} Warning message
   */
  generateWarningAlertMessage(kycStatus) {
    const daysUntil = kycStatus.days_until_expiration;
    const kycLevel = kycStatus.kyc_level;
    
    let message = `KYC STATUS EXPIRATION WARNING\n\n`;
    message += `User Address: ${kycStatus.user_address}\n`;
    message += `Current KYC Status: ${kycStatus.kyc_status}\n`;
    message += `Days Until Expiration: ${daysUntil}\n`;
    message += `Risk Level: ${kycLevel}\n`;
    message += `Risk Score: ${kycStatus.risk_score}\n`;
    message += `Verification Provider: ${kycStatus.verification_provider || 'N/A'}\n`;
    message += `Last Verification: ${kycStatus.verification_date || 'N/A'}\n`;
    message += `Expiration Date: ${kycStatus.expiration_date}\n`;
    
    message += `\nRECOMMENDED ACTIONS:\n`;
    if (daysUntil <= 3) {
      message += `• Complete re-verification within 3 days to avoid service interruption\n`;
    } else {
      message += `• Schedule re-verification before expiration date\n`;
    }
    message += `• Ensure all required documentation is ready\n`;
    message += `• Contact support if you need assistance with the verification process\n`;

    return message;
  }

  /**
   * Generate expired alert message
   * @param {Object} kycStatus - KYC status record
   * @returns {string} Expired message
   */
  generateExpiredAlertMessage(kycStatus) {
    const daysExpired = Math.abs(kycStatus.days_until_expiration) || 0;
    const kycLevel = kycStatus.kyc_level;
    
    let message = `KYC STATUS EXPIRED\n\n`;
    message += `User Address: ${kycStatus.user_address}\n`;
    message += `Current KYC Status: ${kycStatus.kyc_status}\n`;
    message += `Days Expired: ${daysExpired}\n`;
    message += `Risk Level: ${kycLevel}\n`;
    message += `Risk Score: ${kycStatus.risk_score}\n`;
    message += `Verification Provider: ${kycStatus.verification_provider || 'N/A'}\n`;
    message += `Last Verification: ${kycStatus.verification_date || 'N/A'}\n`;
    message += `Expiration Date: ${kycStatus.expiration_date}\n`;
    
    message += `\nIMMEDIATE ACTION REQUIRED:\n`;
    message += `• Complete re-verification immediately to restore account access\n`;
    message += `• All claiming functions are currently disabled\n`;
    message += `• Account may be subject to temporary restrictions\n`;
    message += `• Additional verification may be required due to expired status\n`;
    message += `• Contact support immediately for assistance\n`;

    return message;
  }

  /**
   * Get user email for notifications
   * @param {string} userAddress - User wallet address
   * @returns {Promise<string>} User email
   */
  async getUserEmail(userAddress) {
    try {
      // Try to get email from KYC status record first
      const kycRecord = await KycStatus.findOne({
        where: { user_address, is_active: true },
        include: [{
          model: require('../models').User,
          as: 'user',
          required: false,
          attributes: ['email']
        }]
      });

      if (kycRecord && kycRecord.user && kycRecord.user.email) {
        return kycRecord.user.email;
      }

      // If no email in KYC record, try to get from user model
      const userRecord = await require('../models').User.findOne({
        where: { address: userAddress },
        attributes: ['email']
      });

      return userRecord ? userRecord.email : null;
    } catch (error) {
      logger.error(`Error getting user email for ${userAddress}:`, error);
      return null;
    }
  }

  /**
   * Create high-priority notification
   * @param {Object} kycStatus - KYC status record
   * @param {Object} notificationData - Notification data
   */
  async createHighPriorityNotification(kycStatus, notificationData) {
    try {
      await require('../models').KycNotification.create({
        user_address: kycStatus.user_address,
        kyc_status_id: kycStatus.id,
        type: notificationData.type,
        urgency: notificationData.urgency,
        message: notificationData.message,
        action_required: notificationData.actionRequired,
        sent_at: new Date()
      });

      logger.info(`🚨 Created high-priority notification for ${kycStatus.user_address}`);
    } catch (error) {
      logger.error(`Error creating notification for ${kycStatus.user_address}:`, error);
    }
  }

  /**
   * Create standard notification
   * @param {Object} kycStatus - KYC status record
   * @param {Object} notificationData - Notification data
   */
  async createNotification(kycStatus, notificationData) {
    try {
      await require('../models').KycNotification.create({
        user_address: kycStatus.user_address,
        kyc_status_id: kycStatus.id,
        type: notificationData.type,
        urgency: notificationData.urgency,
        message: notificationData.message,
        action_required: notificationData.actionRequired || false,
        sent_at: new Date()
      });

      logger.info(`📝 Created notification for ${kycStatus.user_address}: ${notificationData.type}`);
    } catch (error) {
      logger.error(`Error creating notification for ${kycStatus.user_address}:`, error);
    }
  }

  /**
   * Update risk score for KYC status
   * @param {string} kycStatusId - KYC status ID
   * @param {number} riskScore - New risk score
   */
  async updateRiskScore(kycStatusId, riskScore) {
    try {
      await KycStatus.update(
        { risk_score: riskScore },
        { where: { id: kycStatusId } }
      );

      logger.info(`📊 Updated risk score for KYC status ${kycStatusId} to ${riskScore}`);
    } catch (error) {
      logger.error(`Error updating risk score for KYC status ${kycStatusId}:`, error);
    }
  }

  /**
   * Send daily summary report
   */
  async sendDailySummary() {
    try {
      const stats = await this.getDailyStatistics();
      
      const subject = `📊 Daily KYC Status Report - ${new Date().toISOString().split('T')[0]}`;
      
      const message = this.generateDailySummaryMessage(stats);
      
      // Send to admin or compliance team
      await emailService.sendEmail({
        to: process.env.COMPLIANCE_EMAIL || 'compliance@example.com',
        subject,
        message,
        priority: 'low'
      });

      logger.info('📧 Daily KYC status report sent');
    } catch (error) {
      logger.error('Error sending daily summary:', error);
    }
  }

  /**
   * Get daily statistics for reporting
   */
  async getDailyStatistics() {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    
    const [
      totalUsers,
      verifiedUsers,
      pendingUsers,
      expiredUsers,
      criticalExpiring,
      soonExpiring,
      softLocked
    ] = await Promise.all([
        KycStatus.count({ where: { is_active: true } }),
        KycStatus.count({ where: { kyc_status: 'VERIFIED', is_active: true } }),
        KycStatus.count({ where: { kyc_status: 'PENDING', is_active: true } }),
        KycStatus.count({ where: { kyc_status: 'EXPIRED', is_active: true } }),
        this.findExpiringStatuses(1), // Critical (≤1 day)
        this.findExpiringStatuses(3), // Soon expiring (≤3 days)
        KycStatus.count({ where: { soft_lock_enabled: true, is_active: true } })
      ]);

    return {
      reportDate: now,
      totalUsers,
      verifiedUsers,
      pendingUsers,
      expiredUsers,
      criticalExpiring: criticalExpiring.length,
      soonExpiring: soonExpiring.length,
      softLocked,
      complianceRate: totalUsers > 0 ? ((verifiedUsers / totalUsers) * 100).toFixed(2) : '0.00'
    };
  }

  /**
   * Generate daily summary message
   * @param {Object} stats - Daily statistics
   * @returns {string} Summary message
   */
  generateDailySummaryMessage(stats) {
    let message = `DAILY KYC STATUS REPORT\n`;
    message += `Report Date: ${stats.reportDate}\n\n`;
    
    message += `SUMMARY:\n`;
    message += `• Total Active Users: ${stats.totalUsers}\n`;
    message += `• Verified Users: ${stats.verifiedUsers} (${((stats.verifiedUsers / stats.totalUsers) * 100).toFixed(1)}%)\n`;
    message += `• Pending Users: ${stats.pendingUsers} (${((stats.pendingUsers / stats.totalUsers) * 100).toFixed(1)}%)\n`;
    message += `• Expired Users: ${stats.expiredUsers}\n`;
    message += `• Compliance Rate: ${stats.complianceRate}%\n\n`;
    
    message += `EXPIRATIONS REQUIRING ATTENTION:\n`;
    if (stats.criticalExpiring > 0) {
      message += `• Critical (≤1 day): ${stats.criticalExpiring} users\n`;
    }
    if (stats.soonExpiring > 0) {
      message += `• Soon Expiring (≤3 days): ${stats.soonExpiring} users\n`;
    }
    if (stats.softLocked > 0) {
      message += `• Soft Locked: ${stats.softLocked} users\n`;
    }

    message += `\nRECOMMENDATIONS:\n`;
    if (stats.criticalExpiring > 0 || stats.soonExpiring > 0) {
      message += `• Immediate follow-up required for ${stats.criticalExpiring + stats.soonExpiring} users with expiring KYC\n`;
      message += `• Consider temporary restrictions for high-risk addresses\n`;
    }
    if (stats.expiredUsers > 0) {
      message += `• Reactivation outreach needed for ${stats.expiredUsers} users\n`;
      message += `• Review verification process for potential issues\n`;
    }

    return message;
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.checkInterval,
      expirationThresholdDays: this.expirationThresholdDays,
      criticalThresholdDays: this.criticalThresholdDays,
      lastCheck: new Date()
    };
  }
}

module.exports = new KycStatusExpirationWorker();
