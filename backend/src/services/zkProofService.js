const logger = require('../utils/logger');
const axios = require('axios');

class ZKProofService {
  constructor() {
    this.circomServiceUrl = process.env.CIRCOM_SERVICE_URL || 'http://localhost:3001';
  }

  /**
   * Generate ZK-proof proving user is over 18 without revealing birthdate
   * @param {Object} userData - Verified user data
   * @param {string} userData.userAddress - User's wallet address
   * @param {string} userData.birthDate - User's birth date (YYYY-MM-DD)
   * @param {string} userData.firstName - User's first name
   * @param {string} userData.lastName - User's last name
   * @returns {Promise<Object>} ZK-proof data
   */
  async generateAgeProof(userData) {
    try {
      // Validate input
      if (!userData.userAddress || !userData.birthDate) {
        throw new Error('userAddress and birthDate are required');
      }

      // Calculate age from birth date
      const birthDate = new Date(userData.birthDate);
      const today = new Date();
      const age = today.getFullYear() - birthDate.getFullYear();

      // Adjust age if birthday hasn't occurred this year
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        age--;
      }

      if (age < 18) {
        throw new Error('User must be 18 or older to generate age proof');
      }

      // Prepare input for Circom circuit
      const circuitInput = {
        birthYear: birthDate.getFullYear(),
        birthMonth: birthDate.getMonth() + 1, // JS months are 0-based
        birthDay: birthDate.getDate(),
        currentYear: today.getFullYear(),
        currentMonth: today.getMonth() + 1,
        currentDay: today.getDate(),
        userAddress: userData.userAddress
      };

      // Call Circom/SnarkJS microservice
      const response = await axios.post(`${this.circomServiceUrl}/generate-proof`, {
        circuit: 'age-verification',
        input: circuitInput
      }, {
        timeout: 30000 // 30 second timeout
      });

      if (response.data.success) {
        return {
          proof: response.data.proof,
          publicSignals: response.data.publicSignals,
          userAddress: userData.userAddress,
          generatedAt: new Date().toISOString(),
          circuit: 'age-verification'
        };
      } else {
        throw new Error(response.data.error || 'Failed to generate ZK-proof');
      }

    } catch (error) {
      logger.error('ZK-proof generation error:', error);
      if (error.response) {
        throw new Error(`Circom service error: ${error.response.data.message || error.response.statusText}`);
      } else if (error.code === 'ECONNREFUSED') {
        throw new Error('Circom service is not available');
      } else {
        throw error;
      }
    }
  }

  /**
   * Verify a ZK-proof (for testing/validation purposes)
   * @param {Object} proofData - Proof data to verify
   * @returns {Promise<boolean>} Verification result
   */
  async verifyProof(proofData) {
    try {
      const response = await axios.post(`${this.circomServiceUrl}/verify-proof`, {
        proof: proofData.proof,
        publicSignals: proofData.publicSignals,
        circuit: 'age-verification'
      });

      return response.data.verified === true;
    } catch (error) {
      logger.error('ZK-proof verification error:', error);
      return false;
    }
  }
}

module.exports = ZKProofService;