const logger = require('../utils/logger');
const admin = require('firebase-admin');
const { DeviceToken } = require('../models');

class FirebaseService {
  constructor() {
    this.initialized = false;
    this.init();
  }

  init() {
    try {
      // Initialize Firebase Admin SDK
      const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
      const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

      if (serviceAccountPath) {
        // Initialize with service account file
        const serviceAccount = require(serviceAccountPath);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      } else if (serviceAccountKey) {
        // Initialize with service account JSON string
        const serviceAccount = JSON.parse(serviceAccountKey);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
        });
      } else {
        logger.warn('Firebase credentials not configured. Push notifications will be disabled.');
        return;
      }

      this.messaging = admin.messaging();
      this.initialized = true;
      logger.info('Firebase Admin SDK initialized successfully.');
    } catch (error) {
      logger.error('Failed to initialize Firebase Admin SDK:', error);
      this.initialized = false;
    }
  }

  isInitialized() {
    return this.initialized;
  }

  /**
   * Send push notification to a single device
   * @param {string} deviceToken - FCM device token
   * @param {Object} notification - Notification payload
   * @param {Object} data - Additional data payload
   * @returns {Promise<string>} - Message ID if successful
   */
  async sendToDevice(deviceToken, notification, data = {}) {
    if (!this.initialized) {
      throw new Error('Firebase not initialized');
    }

    const message = {
      token: deviceToken,
      notification: {
        title: notification.title,
        body: notification.body,
        ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
      },
      data: {
        ...data,
        timestamp: new Date().toISOString(),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'vesting_notifications',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: notification.title,
              body: notification.body,
            },
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    try {
      const response = await this.messaging.send(message);
      logger.info(`Push notification sent successfully: ${response}`);
      
      // Update last_used_at for the device token
      await DeviceToken.update(
        { last_used_at: new Date() },
        { where: { device_token: deviceToken, is_active: true } }
      );
      
      return response;
    } catch (error) {
      logger.error('Error sending push notification:', error);
      
      // Handle invalid tokens
      if (error.code === 'messaging/registration-token-not-registered' ||
          error.code === 'messaging/invalid-registration-token') {
        logger.info(`Marking device token as inactive: ${deviceToken}`);
        await DeviceToken.update(
          { is_active: false },
          { where: { device_token: deviceToken } }
        );
      }
      
      throw error;
    }
  }

  /**
   * Send integrity failure notification to multiple devices
   * @param {string[]} tokens - Array of device tokens
   * @param {string} vaultAddress - Vault contract address
   * @returns {Promise<Object>} - Summary of successful and failed notifications
   */
  async sendIntegrityFailureNotification(tokens, vaultAddress) {
    if (!this.initialized || !tokens || tokens.length === 0) {
      return { successCount: 0, failureCount: 0 };
    }

    const notification = {
      title: 'CRITICAL: Security Alert',
      body: `Integrity failure detected for vault ${vaultAddress}. The vault has been blacklisted for your protection.`,
    };

    const data = {
      type: 'VAULT_INTEGRITY_FAILED',
      vaultAddress,
      priority: 'CRITICAL',
    };

    return await this.sendToMultipleDevices(tokens, notification, data);
  }

  /**
   * Send push notification to multiple devices
   * @param {string[]} deviceTokens - Array of FCM device tokens
   * @param {Object} notification - Notification payload
   * @param {Object} data - Additional data payload
   * @returns {Promise<Object>} - Batch response with success/failure counts
   */
  async sendToMultipleDevices(deviceTokens, notification, data = {}) {
    if (!this.initialized) {
      throw new Error('Firebase not initialized');
    }

    if (!deviceTokens || deviceTokens.length === 0) {
      return { successCount: 0, failureCount: 0, responses: [] };
    }

    const message = {
      notification: {
        title: notification.title,
        body: notification.body,
        ...(notification.imageUrl && { imageUrl: notification.imageUrl }),
      },
      data: {
        ...data,
        timestamp: new Date().toISOString(),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'vesting_notifications',
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        payload: {
          aps: {
            alert: {
              title: notification.title,
              body: notification.body,
            },
            sound: 'default',
            badge: 1,
          },
        },
      },
    };

    try {
      const response = await this.messaging.sendEachForMulticast({
        tokens: deviceTokens,
        ...message,
      });

      logger.info(`Batch notification sent. Success: ${response.successCount}, Failure: ${response.failureCount}`);

      // Handle invalid tokens
      const invalidTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const error = resp.error;
          if (error.code === 'messaging/registration-token-not-registered' ||
              error.code === 'messaging/invalid-registration-token') {
            invalidTokens.push(deviceTokens[idx]);
          }
        }
      });

      if (invalidTokens.length > 0) {
        logger.info(`Marking ${invalidTokens.length} device tokens as inactive`);
        await DeviceToken.update(
          { is_active: false },
          { where: { device_token: invalidTokens } }
        );
      }

      // Update last_used_at for successful tokens
      const successfulTokens = [];
      response.responses.forEach((resp, idx) => {
        if (resp.success) {
          successfulTokens.push(deviceTokens[idx]);
        }
      });

      if (successfulTokens.length > 0) {
        await DeviceToken.update(
          { last_used_at: new Date() },
          { where: { device_token: successfulTokens, is_active: true } }
        );
      }

      return response;
    } catch (error) {
      logger.error('Error sending batch push notifications:', error);
      throw error;
    }
  }

  /**
   * Send cliff passed notification
   * @param {string[]} deviceTokens - Array of device tokens
   * @param {string} amount - Claimable amount
   * @param {string} tokenSymbol - Token symbol
   * @returns {Promise<Object>} - Batch response
   */
  async sendCliffPassedNotification(deviceTokens, amount, tokenSymbol = 'tokens') {
    const notification = {
      title: '🎉 Vesting Cliff Passed!',
      body: `Your ${amount} ${tokenSymbol} are now available to claim!`,
    };

    const data = {
      type: 'CLIFF_PASSED',
      amount: amount.toString(),
      tokenSymbol,
      action: 'open_app',
    };

    return await this.sendToMultipleDevices(deviceTokens, notification, data);
  }

  async sendLiquidityRiskAlertNotification(deviceTokens, payload) {
    const notification = {
      title: 'Liquidity Risk Alert',
      body: payload.insufficientDepth
        ? `${payload.tokenSymbol} order book cannot absorb a $${payload.orderUsd.toLocaleString()} sell order`
        : `${payload.tokenSymbol} sell slippage reached ${payload.slippagePercent.toFixed(2)}%`,
    };

    const data = {
      type: 'LIQUIDITY_RISK_ALERT',
      vaultAddress: payload.vaultAddress,
      vaultName: payload.vaultName,
      tokenSymbol: payload.tokenSymbol,
      orderUsd: payload.orderUsd.toString(),
      slippagePercent: payload.slippagePercent.toFixed(2),
      thresholdPercent: payload.thresholdPercent.toFixed(2),
      insufficientDepth: payload.insufficientDepth ? 'true' : 'false',
      action: 'open_app',
    };

    return await this.sendToMultipleDevices(deviceTokens, notification, data);
  }
}

module.exports = new FirebaseService();
