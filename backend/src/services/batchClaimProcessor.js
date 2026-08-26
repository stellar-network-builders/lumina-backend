const logger = require('../utils/logger');
const { sequelize } = require('../database/connection');
const AutoClaimConsent = require('../models/autoClaimConsent');
const Beneficiary = require('../models/beneficiary');
const Vault = require('../models/vault');
const SubSchedule = require('../models/subSchedule');
const ClaimsHistory = require('../models/claimsHistory');
const indexingService = require('./indexingService');

/**
 * BatchClaimProcessor
 * Bundles multiple claim requests into single atomic transactions
 * Enterprise payroll feature for efficient team token management
 */
class BatchClaimProcessor {
  constructor() {
    this.maxBatchSize = 50; // Maximum claims per batch
  }

  /**
   * Process batch claims for a team/organization
   * @param {Object} params - Batch claim parameters
   * @param {string} params.vaultAddress - Vault address
   * @param {Array<string>} params.beneficiaryAddresses - List of beneficiary addresses
   * @param {string} params.adminAddress - Admin/Founder address initiating the batch
   * @param {boolean} params.requireConsent - Whether to require auto-claim consent (default: true)
   * @returns {Promise<Object>} Batch processing results
   */
  async processBatchClaims({ 
    vaultAddress, 
    beneficiaryAddresses, 
    adminAddress,
    requireConsent = true 
  }) {
    const transaction = await sequelize.transaction();
    
    try {
      // Validate input
      if (!vaultAddress || !beneficiaryAddresses || !Array.isArray(beneficiaryAddresses)) {
        throw new Error('Invalid parameters: vaultAddress and beneficiaryAddresses array are required');
      }

      if (beneficiaryAddresses.length > this.maxBatchSize) {
        throw new Error(`Batch size exceeds maximum of ${this.maxBatchSize} claims`);
      }

      // Verify vault exists and is active
      const vault = await Vault.findOne({
        where: { address: vaultAddress, is_active: true },
        transaction
      });

      if (!vault) {
        throw new Error('Vault not found or inactive');
      }

      // Verify admin has permissions
      const hasPermission = await this.verifyAdminPermission(adminAddress, vaultAddress);
      if (!hasPermission) {
        throw new Error('Admin does not have permission for this vault');
      }

      const results = {
        successful: [],
        failed: [],
        totalProcessed: 0,
        totalSuccessful: 0,
        totalFailed: 0,
        totalAmountClaimed: '0'
      };

      let totalAmountClaimed = 0;

      // Process each beneficiary
      for (const beneficiaryAddress of beneficiaryAddresses) {
        try {
          // Check auto-claim consent if required
          if (requireConsent) {
            const hasConsent = await AutoClaimConsent.hasActiveConsent(
              beneficiaryAddress,
              vaultAddress
            );

            if (!hasConsent) {
              results.failed.push({
                beneficiaryAddress,
                error: 'Auto-claim consent not given',
                requiresConsent: true
              });
              results.totalFailed++;
              continue;
            }
          }

          // Process individual claim
          const claimResult = await this.processIndividualClaim({
            vaultAddress,
            beneficiaryAddress,
            adminAddress,
            transaction
          });

          if (claimResult.success) {
            results.successful.push({
              beneficiaryAddress,
              amountClaimed: claimResult.amountClaimed,
              transactionHash: claimResult.transactionHash
            });
            results.totalSuccessful++;
            totalAmountClaimed += parseFloat(claimResult.amountClaimed);
          } else {
            results.failed.push({
              beneficiaryAddress,
              error: claimResult.error
            });
            results.totalFailed++;
          }

          results.totalProcessed++;
        } catch (error) {
          logger.error(`Error processing claim for ${beneficiaryAddress}:`, error);
          results.failed.push({
            beneficiaryAddress,
            error: error.message
          });
          results.totalFailed++;
        }
      }

      results.totalAmountClaimed = totalAmountClaimed.toString();

      // Commit transaction
      await transaction.commit();

      // Update auto-claim timestamps for successful claims
      await this.updateAutoClaimTimestamps(results.successful, vaultAddress);

      return results;
    } catch (error) {
      await transaction.rollback();
      logger.error('Batch claim processing error:', error);
      throw error;
    }
  }

  /**
   * Process individual claim within batch
   * @param {Object} params - Claim parameters
   * @returns {Promise<Object>} Claim result
   */
  async processIndividualClaim({ 
    vaultAddress, 
    beneficiaryAddress, 
    adminAddress,
    transaction 
  }) {
    try {
      // Find beneficiary record
      const beneficiary = await Beneficiary.findOne({
        where: {
          address: beneficiaryAddress,
          vault_id: vault.id
        },
        include: [{
          model: SubSchedule,
          as: 'subSchedules',
          where: { is_active: true }
        }],
        transaction
      });

      if (!beneficiary) {
        return {
          success: false,
          error: 'Beneficiary not found in vault'
        };
      }

      // Calculate claimable amount
      const claimableAmount = await this.calculateClaimableAmount(beneficiary);

      if (parseFloat(claimableAmount) <= 0) {
        return {
          success: false,
          error: 'No tokens available to claim',
          amountClaimed: '0'
        };
      }

      // Get auto-claim consent settings
      const consent = await AutoClaimConsent.findOne({
        where: {
          beneficiary_address: beneficiaryAddress,
          vault_address: vaultAddress,
          is_enabled: true
        },
        transaction
      });

      // Apply consent restrictions
      let finalClaimAmount = claimableAmount;
      
      if (consent) {
        // Apply max claim percentage
        if (consent.max_claim_percentage) {
          const maxPercentage = parseFloat(consent.max_claim_percentage) / 100;
          const maxAllowed = parseFloat(claimableAmount) * maxPercentage;
          finalClaimAmount = Math.min(parseFloat(claimableAmount), maxAllowed).toString();
        }

        // Apply min claim threshold
        if (consent.min_claim_amount && parseFloat(finalClaimAmount) < parseFloat(consent.min_claim_amount)) {
          return {
            success: false,
            error: `Claim amount below minimum threshold of ${consent.min_claim_amount}`,
            amountClaimed: '0'
          };
        }
      }

      // Create claim record
      const claimData = {
        user_address: beneficiaryAddress,
        token_address: vault.token_address,
        amount_claimed: finalClaimAmount,
        claim_timestamp: new Date(),
        transaction_hash: `batch_${adminAddress}_${Date.now()}_${beneficiaryAddress}`,
        block_number: 0, // Will be updated by indexer
        vault_address: vaultAddress,
        is_auto_claim: true
      };

      // Process claim through indexing service
      const claim = await indexingService.processClaim(claimData);

      return {
        success: true,
        amountClaimed: finalClaimAmount,
        transactionHash: claim.transaction_hash,
        claim
      };
    } catch (error) {
      logger.error('Individual claim processing error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Calculate claimable amount for a beneficiary
   * @param {Object} beneficiary - Beneficiary record with subSchedules
   * @returns {Promise<string>} Claimable amount
   */
  async calculateClaimableAmount(beneficiary) {
    let totalClaimable = 0;

    for (const subSchedule of beneficiary.subSchedules) {
      // Calculate vested amount
      const now = new Date();
      
      // Check if cliff has passed
      if (subSchedule.cliff_date && now < subSchedule.cliff_date) {
        continue;
      }

      // Check if vesting has started
      if (now < subSchedule.vesting_start_date) {
        continue;
      }

      // Calculate vested amount
      const vestingEnd = new Date(
        subSchedule.vesting_start_date.getTime() + (subSchedule.vesting_duration * 1000)
      );

      let vestedAmount;
      if (now >= vestingEnd) {
        vestedAmount = parseFloat(subSchedule.top_up_amount);
      } else {
        const elapsedSeconds = Math.floor((now - subSchedule.vesting_start_date) / 1000);
        vestedAmount = (elapsedSeconds * parseFloat(subSchedule.top_up_amount)) / subSchedule.vesting_duration;
      }

      // Subtract already claimed
      const claimedAmount = parseFloat(subSchedule.cumulative_claimed_amount || '0');
      const claimable = vestedAmount - claimedAmount;

      if (claimable > 0) {
        totalClaimable += claimable;
      }
    }

    return totalClaimable.toString();
  }

  /**
   * Verify admin has permission to initiate batch claims
   * @param {string} adminAddress - Admin address
   * @param {string} vaultAddress - Vault address
   * @returns {Promise<boolean>} Permission status
   */
  async verifyAdminPermission(adminAddress, vaultAddress) {
    // Check if admin is vault owner or organization admin
    const vault = await Vault.findOne({
      where: {
        address: vaultAddress,
        [sequelize.Op.or]: [
          { owner_address: adminAddress },
          { admin_address: adminAddress }
        ]
      }
    });

    return !!vault;
  }

  /**
   * Update last_claimed_at timestamp for successful auto-claims
   * @param {Array} successfulClaims - List of successful claims
   * @param {string} vaultAddress - Vault address
   */
  async updateAutoClaimTimestamps(successfulClaims, vaultAddress) {
    const beneficiaryAddresses = successfulClaims.map(c => c.beneficiaryAddress);

    await AutoClaimConsent.update(
      { last_claimed_at: new Date() },
      {
        where: {
          vault_address: vaultAddress,
          beneficiary_address: {
            [sequelize.Op.in]: beneficiaryAddresses
          }
        }
      }
    );
  }

  /**
   * Enable auto-claim consent for a beneficiary
   * @param {Object} params - Consent parameters
   */
  async enableAutoClaimConsent({ 
    beneficiaryAddress, 
    vaultAddress, 
    maxClaimPercentage = 100,
    minClaimAmount = null,
    claimFrequency = 'immediate',
    metadata = {}
  }) {
    const [consent, created] = await AutoClaimConsent.findOrCreate({
      where: {
        beneficiary_address: beneficiaryAddress,
        vault_address: vaultAddress
      },
      defaults: {
        is_enabled: true,
        max_claim_percentage: maxClaimPercentage,
        min_claim_amount: minClaimAmount,
        claim_frequency: claimFrequency,
        consent_metadata: metadata
      }
    });

    if (!created) {
      await consent.update({
        is_enabled: true,
        max_claim_percentage: maxClaimPercentage,
        min_claim_amount: minClaimAmount,
        claim_frequency: claimFrequency,
        consent_metadata: metadata,
        consent_given_at: new Date()
      });
    }

    return consent;
  }

  /**
   * Disable auto-claim consent for a beneficiary
   */
  async disableAutoClaimConsent(beneficiaryAddress, vaultAddress) {
    await AutoClaimConsent.update(
      { is_enabled: false },
      {
        where: {
          beneficiary_address: beneficiaryAddress,
          vault_address: vaultAddress
        }
      }
    );
  }

  /**
   * Get batch claim eligibility for a beneficiary
   */
  async getBatchClaimEligibility(beneficiaryAddress, vaultAddress) {
    const consent = await AutoClaimConsent.findOne({
      where: {
        beneficiary_address: beneficiaryAddress,
        vault_address: vaultAddress,
        is_enabled: true
      }
    });

    const beneficiary = await Beneficiary.findOne({
      where: { address: beneficiaryAddress },
      include: [{
        model: Vault,
        as: 'vault',
        where: { address: vaultAddress },
        include: [{
          model: SubSchedule,
          as: 'subSchedules',
          where: { is_active: true }
        }]
      }]
    });

    if (!beneficiary) {
      return {
        eligible: false,
        reason: 'Beneficiary not found in vault'
      };
    }

    const claimableAmount = await this.calculateClaimableAmount(beneficiary);

    return {
      eligible: parseFloat(claimableAmount) > 0,
      hasConsent: !!consent,
      claimableAmount,
      consentSettings: consent ? {
        maxClaimPercentage: consent.max_claim_percentage,
        minClaimAmount: consent.min_claim_amount,
        claimFrequency: consent.claim_frequency
      } : null
    };
  }
}

module.exports = new BatchClaimProcessor();
