const logger = require('../utils/logger');
const { Vault, SubSchedule, Beneficiary, Notification, DeviceToken, sequelize } = require('../models');
const { Op } = require('sequelize');
const emailService = require('./emailService');
const firebaseService = require('./firebaseService');
const cron = require('node-cron');

class NotificationService {
  constructor() {
    this.cronJob = null;
  }

  /**
   * Notify beneficiaries about an integrity failure in their vault
   * @param {Object} vault - Vault model instance
   */
  async notifyIntegrityFailure(vault) {
    try {
      logger.info(`CRITICAL: Integrity failure detected for vault ${vault.address}. Notifying beneficiaries...`);
      
      const beneficiaries = await Beneficiary.findAll({
        where: { vault_id: vault.id }
      });

      for (const beneficiary of beneficiaries) {
        // Send email notification
        if (beneficiary.email) {
          try {
            await emailService.sendIntegrityFailureEmail(beneficiary.email, vault.address);
            logger.info(`Integrity failure email sent to ${beneficiary.email}`);
          } catch (emailError) {
            logger.error(`Failed to send integrity failure email to ${beneficiary.email}:`, emailError);
          }
        }

        // Send push notification
        const deviceTokens = await this.getUserDeviceTokens(beneficiary.address);
        if (deviceTokens.length > 0 && firebaseService.isInitialized()) {
          try {
            const tokens = deviceTokens.map(dt => dt.device_token);
            await firebaseService.sendIntegrityFailureNotification(tokens, vault.address);
            logger.info(`Integrity failure push notification sent to beneficiary ${beneficiary.address}`);
          } catch (pushError) {
            logger.error(`Failed to send integrity failure push notification to ${beneficiary.address}:`, pushError);
          }
        }

        // Record notification
        await Notification.create({
          beneficiary_id: beneficiary.id,
          vault_id: vault.id,
          type: 'VAULT_INTEGRITY_FAILED',
          sent_at: new Date()
        });
      }
    } catch (error) {
      logger.error(`Error notifying integrity failure for vault ${vault.address}:`, error);
    }
  }

  /**
   * Start the notification cron job
   */
  start() {
    // Run every hour
    this.cronJob = cron.schedule('0 * * * *', async () => {
      logger.info('Running cliff notification cron job...');
      await this.checkAndNotifyCliffs();
    });
    logger.info('Cliff notification cron job started.');
  }

  /**
   * Check all vaults and sub-schedules for passed cliffs and notify beneficiaries
   */
  async checkAndNotifyCliffs() {
    try {
      const now = new Date();

      // 1. Check Vault cliffs
      const vaultsWithCliffPassed = await Vault.findAll({
        where: {
          cliff_date: {
            [Op.lte]: now,
            [Op.ne]: null
          },
          is_active: true
        },
        include: [{
          model: Beneficiary,
          as: 'beneficiaries',
          where: {
            email: { [Op.ne]: null }
          }
        }]
      });

      for (const vault of vaultsWithCliffPassed) {
        for (const beneficiary of vault.beneficiaries) {
          await this.notifyIfRequired(beneficiary, vault, null, 'CLIFF_PASSED', vault.total_amount);
        }
      }

      // 2. Check SubSchedule cliffs
      const subSchedulesWithCliffPassed = await SubSchedule.findAll({
        where: {
          cliff_date: {
            [Op.lte]: now,
            [Op.ne]: null
          },
          is_active: true
        },
        include: [{
          model: Vault,
          as: 'vault',
          include: [{
            model: Beneficiary,
            as: 'beneficiaries',
            where: {
              email: { [Op.ne]: null }
            }
          }]
        }]
      });

      for (const subSchedule of subSchedulesWithCliffPassed) {
        for (const beneficiary of subSchedule.vault.beneficiaries) {
          await this.notifyIfRequired(beneficiary, subSchedule.vault, subSchedule, 'CLIFF_PASSED', subSchedule.top_up_amount);
        }
      }

    } catch (error) {
      logger.error('Error in checkAndNotifyCliffs:', error);
    }
  }

  /**
   * Notify if not already notified
   * @param {Object} beneficiary - Beneficiary model instance
   * @param {Object} vault - Vault model instance
   * @param {Object|null} subSchedule - SubSchedule model instance or null
   * @param {string} type - Notification type
   * @param {string} amount - Claimable amount
   */
  async notifyIfRequired(beneficiary, vault, subSchedule, type, amount) {
    const transaction = await sequelize.transaction();
    try {
      // Check if notification already sent
      const existingNotification = await Notification.findOne({
        where: {
          beneficiary_id: beneficiary.id,
          vault_id: vault.id,
          sub_schedule_id: subSchedule ? subSchedule.id : null,
          type
        },
        transaction
      });

      if (!existingNotification) {
        logger.info(`Sending ${type} notifications to beneficiary ${beneficiary.email || beneficiary.id} for vault ${vault.vault_address}`);
        
        let emailSent = false;
        let pushSent = false;

        // Send email notification if email is available
        if (beneficiary.email) {
          emailSent = await emailService.sendCliffPassedEmail(beneficiary.email, amount);
        }

        // Send push notification if device tokens are available
        const deviceTokens = await DeviceToken.findAll({
          where: {
            user_address: vault.owner_address, // Assuming owner_address is the beneficiary
            is_active: true
          }
        });

        if (deviceTokens.length > 0 && firebaseService.isInitialized()) {
          try {
            const tokens = deviceTokens.map(dt => dt.device_token);
            const pushResponse = await firebaseService.sendCliffPassedNotification(
              tokens, 
              amount, 
              vault.token_symbol || 'tokens'
            );
            pushSent = pushResponse.successCount > 0;
            logger.info(`Push notifications sent to ${pushResponse.successCount}/${tokens.length} devices`);
          } catch (pushError) {
            logger.error('Error sending push notifications:', pushError);
          }
        }
        
        // Record notification if at least one method succeeded
        if (emailSent || pushSent || deviceTokens.length === 0) {
          await Notification.create({
            beneficiary_id: beneficiary.id,
            vault_id: vault.id,
            sub_schedule_id: subSchedule ? subSchedule.id : null,
            type,
            sent_at: new Date()
          }, { transaction });
          
          logger.info(`Notification recorded in DB for beneficiary ${beneficiary.email || beneficiary.id}`);
        }
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      logger.error(`Failed to process notification for beneficiary ${beneficiary.id}:`, error);
    }
  }

  /**
   * Register a device token for push notifications
   * @param {string} userAddress - User's wallet address
   * @param {string} deviceToken - FCM device token
   * @param {string} platform - Device platform (ios, android, web)
   * @param {string} appVersion - App version (optional)
   * @returns {Promise<Object>} - Created or updated device token record
   */
  async registerDeviceToken(userAddress, deviceToken, platform, appVersion = null) {
    try {
      // Check if token already exists
      const existingToken = await DeviceToken.findOne({
        where: { device_token: deviceToken }
      });

      if (existingToken) {
        // Update existing token
        await existingToken.update({
          user_address: userAddress,
          platform,
          app_version: appVersion,
          is_active: true,
          last_used_at: new Date()
        });
        logger.info(`Updated existing device token for user ${userAddress}`);
        return existingToken;
      } else {
        // Create new token
        const newToken = await DeviceToken.create({
          user_address: userAddress,
          device_token: deviceToken,
          platform,
          app_version: appVersion,
          is_active: true
        });
        logger.info(`Registered new device token for user ${userAddress}`);
        return newToken;
      }
    } catch (error) {
      logger.error('Error registering device token:', error);
      throw error;
    }
  }

  /**
   * Unregister a device token
   * @param {string} deviceToken - FCM device token to unregister
   * @returns {Promise<boolean>} - Success status
   */
  async unregisterDeviceToken(deviceToken) {
    try {
      const result = await DeviceToken.update(
        { is_active: false },
        { where: { device_token: deviceToken } }
      );
      logger.info(`Unregistered device token: ${deviceToken}`);
      return result[0] > 0;
    } catch (error) {
      logger.error('Error unregistering device token:', error);
      throw error;
    }
  }

  /**
   * Get active device tokens for a user
   * @param {string} userAddress - User's wallet address
   * @returns {Promise<Array>} - Array of active device tokens
   */
  async getUserDeviceTokens(userAddress) {
    try {
      return await DeviceToken.findAll({
        where: {
          user_address: userAddress,
          is_active: true
        },
        order: [['last_used_at', 'DESC']]
      });
    } catch (error) {
      logger.error('Error fetching user device tokens:', error);
      throw error;
    }
  }
}

module.exports = new NotificationService();
