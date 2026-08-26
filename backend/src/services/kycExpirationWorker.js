/**
 * KYCExpirationWorker - Service for monitoring KYC status expiration and compliance
 * 
 * This worker monitors the expiration_date of user's SEP-12 KYC status,
 * sends proactive "Re-verify" notifications, and applies soft-locks
 * to claims when necessary for ongoing due diligence compliance.
 */

const logger = require('../utils/logger');
const cron = require('node-cron');
const { KycStatus, KycNotification } = require('../models');
const notificationService = require('./notificationService');
const slackWebhookService = require('./slackWebhookService');
const Sentry = require('@sentry/node');

class KYCExpirationWorker {
  constructor() {
    this.isRunning = false;
    this.lastRunTime = null;
    this.processedUsers = new Set();
    this.notificationTemplates = this.initializeNotificationTemplates();
  }

  /**
   * Start the KYC expiration monitoring worker
   */
  start() {
    logger.info('🔍 Starting KYC Expiration Worker...');
    
    // Run every 6 hours for proactive monitoring
    cron.schedule('0 */6 * * *', async () => {
      await this.runExpirationCheck();
    });

    // Run daily at 9 AM UTC for comprehensive check
    cron.schedule('0 9 * * *', async () => {
      await this.runDailyComplianceCheck();
    });

    // Run hourly for critical expirations (within 24 hours)
    cron.schedule('0 * * * *', async () => {
      await this.runCriticalCheck();
    });

    logger.info('✅ KYC Expiration Worker started successfully');
    logger.info('📅 Schedule: Every 6 hours, daily at 9 AM UTC, and hourly for critical cases');
  }

  /**
   * Main expiration check routine
   */
  async runExpirationCheck() {
    if (this.isRunning) {
      logger.info('⚠️ KYC worker already running, skipping this execution');
      return;
    }

    this.isRunning = true;
    this.lastRunTime = new Date();
    this.processedUsers.clear();

    try {
      logger.info('🔍 Running KYC expiration check...');
      
      const stats = await this.processExpiringUsers();
      
      logger.info('✅ KYC expiration check completed');
      logger.info(`📊 Results: ${stats.totalProcessed} users processed, ${stats.notificationsSent} notifications sent, ${stats.softLocksApplied} soft-locks applied`);
      
      // Send summary to Slack
      await this.sendSlackSummary(stats);
      
    } catch (error) {
      logger.error('❌ Error in KYC expiration check:', error);
      Sentry.captureException(error, {
        tags: { operation: 'kycExpirationCheck' },
        extra: { lastRunTime: this.lastRunTime }
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Daily comprehensive compliance check
   */
  async runDailyComplianceCheck() {
    try {
      logger.info('🔍 Running daily KYC compliance check...');
      
      const stats = await this.processExpiringUsers({ isDailyCheck: true });
      
      // Generate compliance report
      await this.generateComplianceReport(stats);
      
      logger.info('✅ Daily KYC compliance check completed');
      
    } catch (error) {
      logger.error('❌ Error in daily compliance check:', error);
      Sentry.captureException(error, {
        tags: { operation: 'dailyComplianceCheck' }
      });
    }
  }

  /**
   * Critical check for users expiring within 24 hours
   */
  async runCriticalCheck() {
    try {
      const criticalUsers = await KycStatus.findExpiringSoon(1);
      
      if (criticalUsers.length > 0) {
        logger.info(`🚨 Found ${criticalUsers.length} users with KYC expiring within 24 hours`);
        
        for (const user of criticalUsers) {
          if (!this.processedUsers.has(user.user_address)) {
            await this.processCriticalExpiration(user);
            this.processedUsers.add(user.user_address);
          }
        }
      }
      
    } catch (error) {
      logger.error('❌ Error in critical check:', error);
      Sentry.captureException(error, {
        tags: { operation: 'criticalCheck' }
      });
    }
  }

  /**
   * Process users with expiring KYC status
   */
  async processExpiringUsers(options = {}) {
    const { isDailyCheck = false } = options;
    
    const stats = {
      totalProcessed: 0,
      notificationsSent: 0,
      softLocksApplied: 0,
      expiredUsers: 0,
      criticalUsers: 0,
      warningUsers: 0
    };

    // Find users expiring within 7 days
    const expiringUsers = await KycStatus.findExpiringSoon(7);
    
    for (const user of expiringUsers) {
      if (this.processedUsers.has(user.user_address)) {
        continue;
      }

      try {
        await this.processUserExpiration(user, stats);
        this.processedUsers.add(user.user_address);
        stats.totalProcessed++;
      } catch (error) {
        logger.error(`❌ Error processing user ${user.user_address}:`, error);
        Sentry.captureException(error, {
          tags: { operation: 'processUserExpiration' },
          extra: { userAddress: user.user_address }
        });
      }
    }

    // Find already expired users
    const expiredUsers = await KycStatus.findExpired();
    
    for (const user of expiredUsers) {
      if (this.processedUsers.has(user.user_address)) {
        continue;
      }

      try {
        await this.processExpiredUser(user, stats);
        this.processedUsers.add(user.user_address);
        stats.totalProcessed++;
      } catch (error) {
        logger.error(`❌ Error processing expired user ${user.user_address}:`, error);
      }
    }

    return stats;
  }

  /**
   * Process individual user expiration
   */
  async processUserExpiration(user, stats) {
    const daysUntilExpiration = user.days_until_expiration;
    const complianceStatus = user.getComplianceStatus();

    logger.info(`📋 Processing user ${user.user_address}: ${daysUntilExpiration} days until expiration`);

    // Determine urgency and action
    if (daysUntilExpiration <= 1) {
      stats.criticalUsers++;
      await this.processCriticalExpiration(user);
    } else if (daysUntilExpiration <= 3) {
      stats.criticalUsers++;
      await this.processHighPriorityExpiration(user);
    } else if (daysUntilExpiration <= 7) {
      stats.warningUsers++;
      await this.processWarningExpiration(user);
    }

    // Apply soft-lock if within 3 days of expiration
    if (daysUntilExpiration <= 3 && !user.soft_lock_enabled) {
      await user.applySoftLock(`KYC expires in ${daysUntilExpiration} days`);
      stats.softLocksApplied++;
      
      // Send soft-lock notification
      await this.sendNotification(user, 'SOFT_LOCK', 'CRITICAL');
      stats.notificationsSent++;
    }
  }

  /**
   * Process critical expiration (within 24 hours)
   */
  async processCriticalExpiration(user) {
    logger.info(`🚨 CRITICAL: User ${user.user_address} KYC expires in ${user.days_until_expiration} days`);
    
    // Send urgent notification
    await this.sendNotification(user, 'EXPIRATION_WARNING', 'CRITICAL');
    
    // Apply immediate soft-lock if not already applied
    if (!user.soft_lock_enabled) {
      await user.applySoftLock('KYC expiring within 24 hours - immediate action required');
    }
    
    // Send compliance alert
    await this.sendComplianceAlert(user, 'CRITICAL');
  }

  /**
   * Process high priority expiration (within 3 days)
   */
  async processHighPriorityExpiration(user) {
    logger.info(`⚠️ HIGH PRIORITY: User ${user.user_address} KYC expires in ${user.days_until_expiration} days`);
    
    // Send high priority notification
    await this.sendNotification(user, 'EXPIRATION_WARNING', 'HIGH');
    
    // Send compliance alert
    await this.sendComplianceAlert(user, 'HIGH');
  }

  /**
   * Process warning expiration (within 7 days)
   */
  async processWarningExpiration(user) {
    logger.info(`📢 WARNING: User ${user.user_address} KYC expires in ${user.days_until_expiration} days`);
    
    // Send warning notification
    await this.sendNotification(user, 'EXPIRATION_WARNING', 'MEDIUM');
  }

  /**
   * Process expired users
   */
  async processExpiredUser(user, stats) {
    logger.info(`❌ EXPIRED: User ${user.user_address} KYC expired on ${user.expiration_date}`);
    
    stats.expiredUsers++;
    
    // Update status to expired
    await user.updateKycStatus({
      kycStatus: 'EXPIRED'
    });
    
    // Apply soft-lock if not already applied
    if (!user.soft_lock_enabled) {
      await user.applySoftLock('KYC status expired - re-verification required');
      stats.softLocksApplied++;
    }
    
    // Send expired notification
    await this.sendNotification(user, 'EXPIRED', 'CRITICAL');
    stats.notificationsSent++;
    
    // Send critical compliance alert
    await this.sendComplianceAlert(user, 'CRITICAL');
  }

  /**
   * Send notification to user
   */
  async sendNotification(user, notificationType, urgencyLevel) {
    try {
      const template = this.notificationTemplates[notificationType];
      const daysUntilExpiration = user.days_until_expiration;
      
      const notification = await KycNotification.createNotification({
        userAddress: user.user_address,
        kycStatusId: user.id,
        notificationType,
        urgencyLevel,
        title: template.title(user),
        message: template.message(user),
        channels: this.getNotificationChannels(user, urgencyLevel),
        actionRequired: true,
        actionType: 'REVERIFY_KYC',
        actionUrl: `${process.env.FRONTEND_URL}/kyc/reverify`,
        actionDeadline: user.expiration_date,
        daysUntilExpiration,
        kycStatusAtNotification: user.kyc_status,
        expirationDateAtNotification: user.expiration_date,
        templateUsed: notificationType,
        metadata: {
          urgency: urgencyLevel,
          daysUntilExpiration,
          riskLevel: user.risk_level
        }
      });

      // Send notifications through enabled channels
      await this.deliverNotification(notification, user);
      
      // Update user's notification history
      await user.addNotification(notificationType, template.title(user));
      
      logger.info(`📧 Sent ${notificationType} notification to user ${user.user_address}`);
      
    } catch (error) {
      logger.error(`❌ Error sending notification to user ${user.user_address}:`, error);
      Sentry.captureException(error, {
        tags: { operation: 'sendNotification' },
        extra: { userAddress: user.user_address, notificationType }
      });
    }
  }

  /**
   * Deliver notification through various channels
   */
  async deliverNotification(notification, user) {
    const channels = notification.channels || [];
    const deliveryStatus = {};
    
    for (const channel of channels) {
      try {
        if (channel === 'in_app') {
          // In-app notification (always available)
          deliveryStatus[channel] = 'sent';
        } else if (channel === 'email' && user.notification_preferences?.email) {
          // Send email notification
          await this.sendEmailNotification(notification, user);
          deliveryStatus[channel] = 'sent';
        } else if (channel === 'push' && user.notification_preferences?.push) {
          // Send push notification
          await this.sendPushNotification(notification, user);
          deliveryStatus[channel] = 'sent';
        } else if (channel === 'sms' && user.notification_preferences?.sms) {
          // Send SMS notification
          await this.sendSMSNotification(notification, user);
          deliveryStatus[channel] = 'sent';
        } else {
          deliveryStatus[channel] = 'skipped';
        }
      } catch (error) {
        logger.error(`❌ Failed to send ${channel} notification:`, error);
        deliveryStatus[channel] = 'failed';
        notification.updateDeliveryStatus(channel, 'failed', error.message);
      }
    }
    
    // Update delivery status
    await notification.updateDeliveryStatus('all', 'completed');
    notification.delivery_status = deliveryStatus;
    await notification.save();
  }

  /**
   * Send email notification
   */
  async sendEmailNotification(notification, user) {
    // Implementation would depend on your email service
    logger.info(`📧 Sending email notification to ${user.user_address}: ${notification.title}`);
    // await emailService.sendKycNotification(user.user_address, notification);
  }

  /**
   * Send push notification
   */
  async sendPushNotification(notification, user) {
    try {
      await notificationService.sendPushNotification(user.user_address, {
        title: notification.title,
        body: notification.message,
        data: {
          type: 'kyc_expiration',
          action: 'reverify_kyc',
          urgency: notification.urgency_level
        }
      });
    } catch (error) {
      logger.error(`❌ Failed to send push notification:`, error);
      throw error;
    }
  }

  /**
   * Send SMS notification
   */
  async sendSMSNotification(notification, user) {
    // Implementation would depend on your SMS service
    logger.info(`📱 Sending SMS notification to ${user.user_address}: ${notification.title}`);
    // await smsService.sendKycNotification(user.user_address, notification);
  }

  /**
   * Get notification channels based on urgency and user preferences
   */
  getNotificationChannels(user, urgencyLevel) {
    const preferences = user.notification_preferences || {};
    const channels = ['in_app']; // Always include in-app
    
    if (urgencyLevel === 'CRITICAL') {
      if (preferences.email) channels.push('email');
      if (preferences.push) channels.push('push');
      if (preferences.sms) channels.push('sms');
    } else if (urgencyLevel === 'HIGH') {
      if (preferences.email) channels.push('email');
      if (preferences.push) channels.push('push');
    } else if (urgencyLevel === 'MEDIUM') {
      if (preferences.email) channels.push('email');
    }
    
    return channels;
  }

  /**
   * Send compliance alert to internal team
   */
  async sendComplianceAlert(user, severity) {
    try {
      const message = {
        title: `KYC Compliance Alert - ${severity}`,
        text: `User ${user.user_address} KYC status requires attention`,
        fields: [
          { title: 'User Address', value: user.user_address, short: true },
          { title: 'KYC Status', value: user.kyc_status, short: true },
          { title: 'Risk Level', value: user.risk_level, short: true },
          { title: 'Days Until Expiration', value: user.days_until_expiration?.toString() || 'Expired', short: true },
          { title: 'Expiration Date', value: user.expiration_date?.toDateString() || 'N/A', short: true },
          { title: 'Soft Lock', value: user.soft_lock_enabled ? 'Enabled' : 'Disabled', short: true }
        ],
        color: severity === 'CRITICAL' ? 'danger' : severity === 'HIGH' ? 'warning' : 'good',
        timestamp: new Date().toISOString()
      };

      await slackWebhookService.sendKycAlert(message);
      logger.info(`📨 Sent compliance alert for user ${user.user_address}`);
      
    } catch (error) {
      logger.error(`❌ Failed to send compliance alert:`, error);
    }
  }

  /**
   * Send Slack summary of worker run
   */
  async sendSlackSummary(stats) {
    try {
      const message = {
        title: 'KYC Expiration Worker Summary',
        text: `KYC expiration check completed successfully`,
        fields: [
          { title: 'Total Users Processed', value: stats.totalProcessed.toString(), short: true },
          { title: 'Notifications Sent', value: stats.notificationsSent.toString(), short: true },
          { title: 'Soft Locks Applied', value: stats.softLocksApplied.toString(), short: true },
          { title: 'Expired Users', value: stats.expiredUsers.toString(), short: true },
          { title: 'Critical Cases', value: stats.criticalUsers.toString(), short: true },
          { title: 'Warning Cases', value: stats.warningUsers.toString(), short: true },
          { title: 'Last Run', value: this.lastRunTime?.toISOString() || 'Never', short: true }
        ],
        color: 'good',
        timestamp: new Date().toISOString()
      };

      await slackWebhookService.sendKycSummary(message);
      
    } catch (error) {
      logger.error(`❌ Failed to send Slack summary:`, error);
    }
  }

  /**
   * Generate compliance report
   */
  async generateComplianceReport(stats) {
    try {
      const complianceStats = await KycStatus.getComplianceStatistics();
      
      const report = {
        date: new Date().toISOString(),
        workerStats: stats,
        complianceStats,
        recommendations: this.generateRecommendations(complianceStats)
      };

      // Store report or send to compliance team
      logger.info('📊 Generated compliance report:', report);
      
      // Send report to Slack
      await this.sendComplianceReport(report);
      
    } catch (error) {
      logger.error(`❌ Failed to generate compliance report:`, error);
    }
  }

  /**
   * Generate recommendations based on compliance stats
   */
  generateRecommendations(stats) {
    const recommendations = [];
    
    if (stats.softLockedUsers > 0) {
      recommendations.push(`${stats.softLockedUsers} users have soft-locked accounts - immediate follow-up required`);
    }
    
    if (stats.expiringSoonUsers > 10) {
      recommendations.push('High number of users with expiring KYC - consider automated outreach campaign');
    }
    
    if (parseFloat(stats.complianceRate) < 90) {
      recommendations.push('Compliance rate below 90% - review KYC process and user onboarding');
    }
    
    const highRiskUsers = stats.riskBreakdown?.HIGH + stats.riskBreakdown?.CRITICAL || 0;
    if (highRiskUsers > stats.totalUsers * 0.1) {
      recommendations.push('High percentage of high-risk users - enhanced monitoring recommended');
    }
    
    return recommendations;
  }

  /**
   * Send compliance report to Slack
   */
  async sendComplianceReport(report) {
    try {
      const message = {
        title: 'Daily KYC Compliance Report',
        text: `Compliance report for ${new Date().toDateString()}`,
        fields: [
          { title: 'Total Users', value: report.complianceStats.totalUsers.toString(), short: true },
          { title: 'Verified Users', value: report.complianceStats.verifiedUsers.toString(), short: true },
          { title: 'Compliance Rate', value: `${report.complianceStats.complianceRate}%`, short: true },
          { title: 'Soft Locked', value: report.complianceStats.softLockedUsers.toString(), short: true },
          { title: 'Expiring Soon', value: report.complianceStats.expiringSoonUsers.toString(), short: true }
        ],
        color: parseFloat(report.complianceStats.complianceRate) > 90 ? 'good' : 'warning',
        timestamp: new Date().toISOString()
      };

      if (report.recommendations.length > 0) {
        message.fields.push({
          title: 'Recommendations',
          value: report.recommendations.join('\n'),
          short: false
        });
      }

      await slackWebhookService.sendKycReport(message);
      
    } catch (error) {
      logger.error(`❌ Failed to send compliance report:`, error);
    }
  }

  /**
   * Initialize notification templates
   */
  initializeNotificationTemplates() {
    return {
      EXPIRATION_WARNING: {
        title: (user) => `KYC Verification Expiring Soon`,
        message: (user) => {
          const days = user.days_until_expiration;
          if (days <= 1) {
            return `Your KYC verification expires tomorrow. Please complete re-verification immediately to avoid interruption of your claim functionality.`;
          } else if (days <= 3) {
            return `Your KYC verification expires in ${days} days. Immediate action required to maintain full access to your vesting account.`;
          } else {
            return `Your KYC verification expires in ${days} days. Please complete the re-verification process to ensure uninterrupted access to your tokens.`;
          }
        }
      },
      EXPIRED: {
        title: (user) => `KYC Verification Expired`,
        message: (user) => `Your KYC verification has expired. Your claim functionality has been temporarily locked. Please complete re-verification immediately to restore full access.`
      },
      SOFT_LOCK: {
        title: (user) => `Account Temporarily Locked`,
        message: (user) => `Your account has been temporarily locked due to KYC verification requirements. Please complete the re-verification process to unlock your account.`
      },
      REVERIFY_REQUIRED: {
        title: (user) => `Re-verification Required`,
        message: (user) => `Please complete the KYC re-verification process to maintain compliance and continue using our services.`
      },
      VERIFICATION_COMPLETE: {
        title: (user) => `KYC Verification Complete`,
        message: (user) => `Your KYC verification has been successfully updated. Your account is now fully compliant.`
      }
    };
  }

  /**
   * Get worker status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      processedUsersCount: this.processedUsers.size,
      uptime: process.uptime()
    };
  }

  /**
   * Stop the worker
   */
  stop() {
    logger.info('🛑 Stopping KYC Expiration Worker...');
    // In a real implementation, you would stop the cron jobs
    logger.info('✅ KYC Expiration Worker stopped');
  }
}

module.exports = new KYCExpirationWorker();
