/**
 * Rule144ComplianceService - Service for SEC Rule 144 compliance monitoring
 * 
 * This service provides the core logic for tracking holding periods and
 * enforcing compliance gates for restricted securities claims.
 */

const logger = require('../utils/logger');
const { Rule144Compliance, Vault, SubSchedule } = require('../models');
const Sentry = require('@sentry/node');
const BigNumber = require('bignumber.js');

class Rule144ComplianceService {
  /**
   * Create a compliance record for a new vault beneficiary
   * @param {Object} params - Compliance record parameters
   * @returns {Promise<Rule144Compliance>} Created compliance record
   */
  async createComplianceRecord({
    vaultId,
    userAddress,
    tokenAddress,
    acquisitionDate,
    holdingPeriodMonths = 6,
    totalAmountAcquired = '0',
    isRestrictedSecurity = true,
    jurisdiction = 'US'
  }) {
    try {
      // Check if record already exists
      const existing = await Rule144Compliance.getComplianceByVaultAndUser(vaultId, userAddress);
      if (existing) {
        throw new Error(`Compliance record already exists for vault ${vaultId} and user ${userAddress}`);
      }

      const complianceRecord = await Rule144Compliance.createComplianceRecord({
        vaultId,
        userAddress,
        tokenAddress,
        acquisitionDate,
        holdingPeriodMonths,
        totalAmountAcquired,
        isRestrictedSecurity,
        jurisdiction
      });

      logger.info(`Created Rule 144 compliance record for vault ${vaultId}, user ${userAddress}`);
      return complianceRecord;
    } catch (error) {
      logger.error('Error creating compliance record:', error);
      Sentry.captureException(error, {
        tags: { operation: 'createComplianceRecord' },
        extra: { vaultId, userAddress }
      });
      throw error;
    }
  }

  /**
   * Check if a user can claim tokens from a vault based on Rule 144 compliance
   * @param {string} vaultId - Vault ID
   * @param {string} userAddress - User wallet address
   * @param {Date} currentDate - Current date (defaults to now)
   * @returns {Promise<Object>} Compliance check result
   */
  async checkClaimCompliance(vaultId, userAddress, currentDate = new Date()) {
    try {
      const complianceRecord = await Rule144Compliance.getComplianceByVaultAndUser(vaultId, userAddress);
      
      if (!complianceRecord) {
        // No compliance record found - create one automatically
        const vault = await Vault.findByPk(vaultId);
        if (!vault) {
          throw new Error(`Vault ${vaultId} not found`);
        }

        // Get the subschedule for this user to determine acquisition date
        const subSchedule = await SubSchedule.findOne({
          where: {
            vault_id: vaultId,
            beneficiary_address: userAddress
          },
          order: [['vesting_start_date', 'ASC']]
        });

        if (!subSchedule) {
          throw new Error(`No subschedule found for user ${userAddress} in vault ${vaultId}`);
        }

        // Create compliance record with vesting start date as acquisition date
        const newRecord = await this.createComplianceRecord({
          vaultId,
          userAddress,
          tokenAddress: vault.token_address,
          acquisitionDate: subSchedule.vesting_start_date,
          holdingPeriodMonths: 6, // Default to 6 months
          totalAmountAcquired: subSchedule.top_up_amount,
          isRestrictedSecurity: true
        });

        return this.checkClaimCompliance(vaultId, userAddress, currentDate);
      }

      // Update compliance status
      complianceRecord.updateComplianceStatus(currentDate);
      await complianceRecord.save();

      const isCompliant = complianceRecord.compliance_status === 'COMPLIANT';
      const daysUntilCompliance = complianceRecord.getDaysUntilCompliance(currentDate);

      return {
        isCompliant,
        complianceStatus: complianceRecord.compliance_status,
        holdingPeriodEndDate: complianceRecord.holding_period_end_date,
        daysUntilCompliance,
        isRestrictedSecurity: complianceRecord.is_restricted_security,
        exemptionType: complianceRecord.exemption_type,
        jurisdiction: complianceRecord.jurisdiction,
        message: isCompliant 
          ? 'Claim is compliant with Rule 144'
          : `Claim is restricted. Holding period ends in ${daysUntilCompliance} days (${complianceRecord.holding_period_end_date.toDateString()})`
      };
    } catch (error) {
      logger.error('Error checking claim compliance:', error);
      Sentry.captureException(error, {
        tags: { operation: 'checkClaimCompliance' },
        extra: { vaultId, userAddress }
      });
      throw error;
    }
  }

  /**
   * Record a claim attempt and update compliance tracking
   * @param {string} vaultId - Vault ID
   * @param {string} userAddress - User wallet address
   * @param {string} amountClaimed - Amount claimed
   * @param {Date} claimDate - Claim date
   * @returns {Promise<Rule144Compliance>} Updated compliance record
   */
  async recordClaimAttempt(vaultId, userAddress, amountClaimed, claimDate = new Date()) {
    try {
      const complianceRecord = await Rule144Compliance.getComplianceByVaultAndUser(vaultId, userAddress);
      
      if (!complianceRecord) {
        throw new Error(`No compliance record found for vault ${vaultId} and user ${userAddress}`);
      }

      // Update last claim attempt
      complianceRecord.last_claim_attempt_date = claimDate;

      // Update compliance status
      complianceRecord.updateComplianceStatus(claimDate);

      // Track withdrawal based on compliance
      if (complianceRecord.compliance_status === 'COMPLIANT') {
        const currentCompliant = new BigNumber(complianceRecord.amount_withdrawn_compliant || 0);
        const totalCompliant = currentCompliant.plus(amountClaimed || 0);
        complianceRecord.amount_withdrawn_compliant = totalCompliant.toFixed(18);
      } else {
        const currentRestricted = new BigNumber(complianceRecord.amount_withdrawn_restricted || 0);
        const totalRestricted = currentRestricted.plus(amountClaimed || 0);
        complianceRecord.amount_withdrawn_restricted = totalRestricted.toFixed(18);

        // Log restricted withdrawal for compliance monitoring
        logger.warn(`RESTRICTED WITHDRAWAL: User ${userAddress} claimed ${amountClaimed} from vault ${vaultId} before holding period end`);
        
        // Send to Sentry for monitoring
        Sentry.captureMessage('Rule 144 violation - Restricted withdrawal', {
          level: 'warning',
          tags: { 
            operation: 'recordClaimAttempt',
            compliance_status: 'VIOLATION'
          },
          extra: {
            vaultId,
            userAddress,
            amountClaimed,
            holdingPeriodEndDate: complianceRecord.holding_period_end_date,
            claimDate
          }
        });
      }

      await complianceRecord.save();
      return complianceRecord;
    } catch (error) {
      logger.error('Error recording claim attempt:', error);
      Sentry.captureException(error, {
        tags: { operation: 'recordClaimAttempt' },
        extra: { vaultId, userAddress, amountClaimed }
      });
      throw error;
    }
  }

  /**
   * Get compliance status for all users in a vault
   * @param {string} vaultId - Vault ID
   * @returns {Promise<Array>} Array of compliance records
   */
  async getVaultComplianceStatus(vaultId) {
    try {
      const records = await Rule144Compliance.findAll({
        where: { vault_id: vaultId },
        include: [{
          model: Vault,
          as: 'vault',
          attributes: ['name', 'token_address', 'owner_address']
        }]
      });

      // Update compliance status for all records
      const currentDate = new Date();
      records.forEach(record => {
        record.updateComplianceStatus(currentDate);
      });

      return records.map(record => ({
        userAddress: record.user_address,
        complianceStatus: record.compliance_status,
        isCompliant: record.compliance_status === 'COMPLIANT',
        holdingPeriodEndDate: record.holding_period_end_date,
        daysUntilCompliance: record.getDaysUntilCompliance(currentDate),
        isRestrictedSecurity: record.is_restricted_security,
        totalAmountAcquired: record.total_amount_acquired,
        amountWithdrawnCompliant: record.amount_withdrawn_compliant,
        amountWithdrawnRestricted: record.amount_withdrawn_restricted
      }));
    } catch (error) {
      logger.error('Error getting vault compliance status:', error);
      Sentry.captureException(error, {
        tags: { operation: 'getVaultComplianceStatus' },
        extra: { vaultId }
      });
      throw error;
    }
  }

  /**
   * Update compliance record (admin function)
   * @param {string} vaultId - Vault ID
   * @param {string} userAddress - User wallet address
   * @param {Object} updates - Updates to apply
   * @param {string} verifiedBy - Admin address making the update
   * @returns {Promise<Rule144Compliance>} Updated compliance record
   */
  async updateComplianceRecord(vaultId, userAddress, updates, verifiedBy) {
    try {
      const complianceRecord = await Rule144Compliance.getComplianceByVaultAndUser(vaultId, userAddress);
      
      if (!complianceRecord) {
        throw new Error(`No compliance record found for vault ${vaultId} and user ${userAddress}`);
      }

      // Apply updates
      Object.assign(complianceRecord, updates);
      
      // Update verification info
      complianceRecord.verified_by = verifiedBy;
      complianceRecord.verification_date = new Date();

      // Recalculate holding period end date if months changed
      if (updates.holding_period_months) {
        const endDate = new Date(complianceRecord.initial_acquisition_date);
        endDate.setMonth(endDate.getMonth() + updates.holding_period_months);
        complianceRecord.holding_period_end_date = endDate;
      }

      // Update compliance status
      complianceRecord.updateComplianceStatus();
      
      await complianceRecord.save();
      
      logger.info(`Updated Rule 144 compliance record for vault ${vaultId}, user ${userAddress} by admin ${verifiedBy}`);
      return complianceRecord;
    } catch (error) {
      logger.error('Error updating compliance record:', error);
      Sentry.captureException(error, {
        tags: { operation: 'updateComplianceRecord' },
        extra: { vaultId, userAddress, updates, verifiedBy }
      });
      throw error;
    }
  }

  /**
   * Get compliance statistics for reporting
   * @param {string} vaultId - Optional vault ID filter
   * @returns {Promise<Object>} Compliance statistics
   */
  async getComplianceStatistics(vaultId = null) {
    try {
      const whereClause = vaultId ? { vault_id: vaultId } : {};
      
      const total = await Rule144Compliance.count({ where: whereClause });
      const compliant = await Rule144Compliance.count({ 
        where: { ...whereClause, compliance_status: 'COMPLIANT' }
      });
      const restricted = await Rule144Compliance.count({ 
        where: { ...whereClause, compliance_status: 'RESTRICTED' }
      });
      const pending = await Rule144Compliance.count({ 
        where: { ...whereClause, compliance_status: 'PENDING' }
      });
      const restrictedSecurities = await Rule144Compliance.count({ 
        where: { ...whereClause, is_restricted_security: true }
      });

      return {
        total,
        compliant,
        restricted,
        pending,
        restrictedSecurities,
        complianceRate: total > 0 ? ((compliant / total) * 100).toFixed(2) : 0
      };
    } catch (error) {
      logger.error('Error getting compliance statistics:', error);
      Sentry.captureException(error, {
        tags: { operation: 'getComplianceStatistics' },
        extra: { vaultId }
      });
      throw error;
    }
  }
}

module.exports = new Rule144ComplianceService();
