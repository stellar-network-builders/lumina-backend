/**
 * SEP12KycService - Service for integrating with Stellar SEP-12 KYC/AML verification
 * 
 * This service provides integration with Stellar's SEP-12 KYC protocol
 * for customer due diligence and verification status monitoring.
 */

const logger = require('../utils/logger');
const axios = require('axios');
const { KycStatus, KycNotification } = require('../models');
const Sentry = require('@sentry/node');

class SEP12KycService {
  constructor() {
    this.baseUrl = process.env.STELLAR_SEP12_URL || 'https://api.stellar.org/sep12';
    this.apiKey = process.env.STELLAR_SEP12_API_KEY;
    this.timeout = 30000; // 30 seconds timeout
  }

  /**
   * Get KYC status for a user from SEP-12
   * @param {string} userAddress - User's wallet address
   * @returns {Promise<Object>} KYC status information
   */
  async getKycStatus(userAddress) {
    try {
      logger.info(`🔍 Fetching KYC status for user: ${userAddress}`);
      
      const response = await this.makeRequest('GET', `/customer/${userAddress}`);
      
      const kycData = response.data;
      
      // Update or create KYC status record
      const kycStatus = await this.updateKycStatusFromSEP12(userAddress, kycData);
      
      logger.info(`✅ KYC status retrieved for user ${userAddress}: ${kycData.status}`);
      
      return {
        success: true,
        data: kycStatus.toJSON(),
        sep12Data: kycData
      };
      
    } catch (error) {
      logger.error(`❌ Error fetching KYC status for user ${userAddress}:`, error);
      
      if (error.response?.status === 404) {
        // User not found in SEP-12, create pending record
        const kycStatus = await KycStatus.createKycStatus({
          userAddress,
          kycStatus: 'PENDING',
          kycLevel: 'BASIC'
        });
        
        return {
          success: true,
          data: kycStatus.toJSON(),
          sep12Data: null
        };
      }
      
      Sentry.captureException(error, {
        tags: { operation: 'getKycStatus' },
        extra: { userAddress }
      });
      
      throw error;
    }
  }

  /**
   * Submit KYC information to SEP-12
   * @param {string} userAddress - User's wallet address
   * @param {Object} kycData - KYC information to submit
   * @returns {Promise<Object>} Submission result
   */
  async submitKycInformation(userAddress, kycData) {
    try {
      logger.info(`📤 Submitting KYC information for user: ${userAddress}`);
      
      const payload = {
        account: userAddress,
        ...kycData
      };
      
      const response = await this.makeRequest('POST', '/customer', payload);
      
      // Update local KYC status
      const kycStatus = await this.updateKycStatusFromSEP12(userAddress, response.data);
      
      // Send notification to user
      await KycNotification.createNotification({
        userAddress,
        kycStatusId: kycStatus.id,
        notificationType: 'VERIFICATION_COMPLETE',
        urgencyLevel: 'LOW',
        title: 'KYC Verification Submitted',
        message: 'Your KYC information has been submitted successfully. You will be notified once verification is complete.',
        actionRequired: false
      });
      
      logger.info(`✅ KYC information submitted for user ${userAddress}`);
      
      return {
        success: true,
        data: kycStatus.toJSON(),
        sep12Data: response.data
      };
      
    } catch (error) {
      logger.error(`❌ Error submitting KYC information for user ${userAddress}:`, error);
      Sentry.captureException(error, {
        tags: { operation: 'submitKycInformation' },
        extra: { userAddress }
      });
      throw error;
    }
  }

  /**
   * Update KYC information in SEP-12
   * @param {string} userAddress - User's wallet address
   * @param {Object} kycData - Updated KYC information
   * @returns {Promise<Object>} Update result
   */
  async updateKycInformation(userAddress, kycData) {
    try {
      logger.info(`🔄 Updating KYC information for user: ${userAddress}`);
      
      const response = await this.makeRequest('PUT', `/customer/${userAddress}`, kycData);
      
      // Update local KYC status
      const kycStatus = await this.updateKycStatusFromSEP12(userAddress, response.data);
      
      logger.info(`✅ KYC information updated for user ${userAddress}`);
      
      return {
        success: true,
        data: kycStatus.toJSON(),
        sep12Data: response.data
      };
      
    } catch (error) {
      logger.error(`❌ Error updating KYC information for user ${userAddress}:`, error);
      Sentry.captureException(error, {
        tags: { operation: 'updateKycInformation' },
        extra: { userAddress }
      });
      throw error;
    }
  }

  /**
   * Delete KYC information from SEP-12
   * @param {string} userAddress - User's wallet address
   * @returns {Promise<Object>} Deletion result
   */
  async deleteKycInformation(userAddress) {
    try {
      logger.info(`🗑️ Deleting KYC information for user: ${userAddress}`);
      
      await this.makeRequest('DELETE', `/customer/${userAddress}`);
      
      // Update local status
      const kycStatus = await KycStatus.findByUserAddress(userAddress);
      if (kycStatus) {
        await kycStatus.update({
          kyc_status: 'PENDING',
          verification_date: null,
          expiration_date: null,
          sep12_response_data: null,
          updated_at: new Date()
        });
      }
      
      logger.info(`✅ KYC information deleted for user ${userAddress}`);
      
      return {
        success: true,
        message: 'KYC information deleted successfully'
      };
      
    } catch (error) {
      logger.error(`❌ Error deleting KYC information for user ${userAddress}:`, error);
      Sentry.captureException(error, {
        tags: { operation: 'deleteKycInformation' },
        extra: { userAddress }
      });
      throw error;
    }
  }

  /**
   * Get KYC verification history for a user
   * @param {string} userAddress - User's wallet address
   * @returns {Promise<Object>} Verification history
   */
  async getKycHistory(userAddress) {
    try {
      logger.info(`📜 Fetching KYC history for user: ${userAddress}`);
      
      const response = await this.makeRequest('GET', `/customer/${userAddress}/history`);
      
      logger.info(`✅ KYC history retrieved for user ${userAddress}`);
      
      return {
        success: true,
        data: response.data
      };
      
    } catch (error) {
      logger.error(`❌ Error fetching KYC history for user ${userAddress}:`, error);
      Sentry.captureException(error, {
        tags: { operation: 'getKycHistory' },
        extra: { userAddress }
      });
      throw error;
    }
  }

  /**
   * Get KYC verification status for multiple users
   * @param {Array<string>} userAddresses - Array of user wallet addresses
   * @returns {Promise<Object>} Batch status results
   */
  async getBatchKycStatus(userAddresses) {
    try {
      logger.info(`📊 Fetching batch KYC status for ${userAddresses.length} users`);
      
      const results = {};
      
      for (const userAddress of userAddresses) {
        try {
          const result = await this.getKycStatus(userAddress);
          results[userAddress] = result;
        } catch (error) {
          results[userAddress] = {
            success: false,
            error: error.message
          };
        }
      }
      
      logger.info(`✅ Batch KYC status completed for ${userAddresses.length} users`);
      
      return {
        success: true,
        data: results
      };
      
    } catch (error) {
      logger.error(`❌ Error in batch KYC status fetch:`, error);
      Sentry.captureException(error, {
        tags: { operation: 'getBatchKycStatus' }
      });
      throw error;
    }
  }

  /**
   * Validate KYC data before submission
   * @param {Object} kycData - KYC data to validate
   * @returns {Promise<Object>} Validation result
   */
  validateKycData(kycData) {
    const errors = [];
    const warnings = [];
    
    // Required fields validation
    const requiredFields = ['first_name', 'last_name', 'email_address'];
    for (const field of requiredFields) {
      if (!kycData[field]) {
        errors.push(`${field} is required`);
      }
    }
    
    // Email format validation
    if (kycData.email_address && !this.isValidEmail(kycData.email_address)) {
      errors.push('Invalid email format');
    }
    
    // Phone number validation
    if (kycData.mobile_number && !this.isValidPhoneNumber(kycData.mobile_number)) {
      warnings.push('Invalid phone number format');
    }
    
    // Document validation
    if (kycData.documents) {
      for (const doc of kycData.documents) {
        if (!doc.type || !doc.number) {
          errors.push('Document type and number are required');
        }
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Update local KYC status from SEP-12 response
   * @private
   */
  async updateKycStatusFromSEP12(userAddress, sep12Data) {
    let kycStatus = await KycStatus.findByUserAddress(userAddress);
    
    if (!kycStatus) {
      kycStatus = await KycStatus.createKycStatus({
        userAddress,
        sep12CustomerId: sep12Data.id,
        kycStatus: 'PENDING'
      });
    }
    
    // Map SEP-12 status to our status
    const statusMapping = {
      'ACCEPTED': 'VERIFIED',
      'ACCEPTED_WITH_CONDITIONS': 'VERIFIED',
      'REJECTED': 'REJECTED',
      'NEED_MORE_INFO': 'PENDING',
      'PENDING': 'PENDING'
    };
    
    const mappedStatus = statusMapping[sep12Data.status] || 'PENDING';
    
    // Calculate expiration date based on verification date
    let expirationDate = null;
    if (sep12Data.verified_at && mappedStatus === 'VERIFIED') {
      const verificationDate = new Date(sep12Data.verified_at);
      // Set expiration to 1 year from verification (adjust based on requirements)
      expirationDate = new Date(verificationDate);
      expirationDate.setFullYear(expirationDate.getFullYear() + 1);
    }
    
    // Map risk level
    const riskMapping = {
      'LOW': 'LOW',
      'MEDIUM': 'MEDIUM',
      'HIGH': 'HIGH',
      'CRITICAL': 'CRITICAL'
    };
    
    const riskLevel = riskMapping[sep12Data.risk_rating] || 'LOW';
    const riskScore = this.calculateRiskScore(sep12Data.risk_rating);
    
    // Update KYC status
    await kycStatus.updateKycStatus({
      kycStatus: mappedStatus,
      kycLevel: sep12Data.verification_level || 'BASIC',
      verificationDate: sep12Data.verified_at ? new Date(sep12Data.verified_at) : null,
      expirationDate,
      riskScore,
      riskLevel,
      sep12ResponseData: sep12Data,
      providerReferenceId: sep12Data.id,
      lastScreeningDate: sep12Data.last_screening_at ? new Date(sep12Data.last_screening_at) : null
    });
    
    // If status changed to VERIFIED and user was soft-locked, remove the lock
    if (mappedStatus === 'VERIFIED' && kycStatus.soft_lock_enabled) {
      await kycStatus.removeSoftLock('KYC verification completed');
      
      // Send notification to user
      await KycNotification.createNotification({
        userAddress,
        kycStatusId: kycStatus.id,
        notificationType: 'VERIFICATION_COMPLETE',
        urgencyLevel: 'LOW',
        title: 'KYC Verification Complete',
        message: 'Your KYC verification has been completed successfully. Your account is now fully active.',
        actionRequired: false
      });
    }
    
    return kycStatus;
  }

  /**
   * Calculate risk score from risk rating
   * @private
   */
  calculateRiskScore(riskRating) {
    const riskScores = {
      'LOW': 0.25,
      'MEDIUM': 0.50,
      'HIGH': 0.75,
      'CRITICAL': 1.00
    };
    
    return riskScores[riskRating] || 0.25;
  }

  /**
   * Make HTTP request to SEP-12 API
   * @private
   */
  async makeRequest(method, endpoint, data = null) {
    const config = {
      method,
      url: `${this.baseUrl}${endpoint}`,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'User-Agent': 'Vesting-Vault/1.0'
      }
    };
    
    if (data) {
      config.data = data;
    }
    
    const response = await axios(config);
    
    return response;
  }

  /**
   * Validate email format
   * @private
   */
  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Validate phone number format
   * @private
   */
  isValidPhoneNumber(phone) {
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    return phoneRegex.test(phone.replace(/[\s\-\(\)]/g, ''));
  }

  /**
   * Get SEP-12 service health status
   */
  async getHealthStatus() {
    try {
      const response = await this.makeRequest('GET', '/health');
      
      return {
        status: 'healthy',
        response: response.data,
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Sync KYC status for all active users
   */
  async syncAllKycStatus() {
    try {
      logger.info('🔄 Starting KYC status sync for all users...');
      
      const allKycStatuses = await KycStatus.findAll({
        where: { is_active: true },
        attributes: ['user_address']
      });
      
      const userAddresses = allKycStatuses.map(status => status.user_address);
      
      const results = await this.getBatchKycStatus(userAddresses);
      
      const successful = Object.values(results.data).filter(r => r.success).length;
      const failed = Object.values(results.data).filter(r => !r.success).length;
      
      logger.info(`✅ KYC sync completed: ${successful} successful, ${failed} failed`);
      
      return {
        total: userAddresses.length,
        successful,
        failed,
        results: results.data
      };
      
    } catch (error) {
      logger.error(`❌ Error in KYC sync:`, error);
      Sentry.captureException(error, {
        tags: { operation: 'syncAllKycStatus' }
      });
      throw error;
    }
  }
}

module.exports = new SEP12KycService();
