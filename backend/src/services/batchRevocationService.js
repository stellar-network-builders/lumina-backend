'use strict';

const logger = require('../utils/logger');
const { sequelize } = require('../database/connection');
const { Vault, Beneficiary, SubSchedule } = require('../models');
const auditLogger = require('./auditLogger');
const AuditService = require('./auditService');
const vestingService = require('./vestingService');

/**
 * Batch Revocation Service
 * 
 * Provides atomic batch revocation functionality for mass team terminations.
 * All operations are wrapped in a single transaction to ensure consistency.
 */

class BatchRevocationService {
  /**
   * Revoke multiple beneficiaries in a single atomic transaction
   * 
   * @param {Object} params
   * @param {string} params.vaultAddress - Vault address containing beneficiaries
   * @param {Array<string>} params.beneficiaryAddresses - Array of beneficiary addresses to revoke
   * @param {string} params.adminAddress - Admin address authorizing the revocation
   * @param {string} params.reason - Reason for batch revocation (e.g., "team_termination")
   * @param {string} [params.treasuryAddress] - Optional treasury address (defaults to vault owner)
   * @returns {Promise<Object>} Batch revocation result
   */
  async batchRevokeBeneficiaries({
    vaultAddress,
    beneficiaryAddresses,
    adminAddress,
    reason,
    treasuryAddress = null,
  }) {
    if (!Array.isArray(beneficiaryAddresses) || beneficiaryAddresses.length === 0) {
      throw new Error('beneficiaryAddresses must be a non-empty array');
    }

    const transaction = await sequelize.transaction();
    
    try {
      // Verify vault exists
      const vault = await Vault.findOne({ 
        where: { address: vaultAddress },
        transaction 
      });
      
      if (!vault) {
        throw new Error(`Vault not found: ${vaultAddress}`);
      }

      if (vault.is_blacklisted) {
        throw new Error(`Vault ${vaultAddress} is blacklisted. Operations are disabled.`);
      }

      const results = [];
      let totalUnvestedReturned = 0;
      let totalVestedPaid = 0;

      // Process each beneficiary
      for (const beneficiaryAddress of beneficiaryAddresses) {
        const result = await this._revokeSingleBeneficiary(
          vault,
          beneficiaryAddress,
          adminAddress,
          treasuryAddress,
          transaction
        );
        
        results.push(result);
        totalUnvestedReturned += parseFloat(result.unvested_returned);
        totalVestedPaid += parseFloat(result.vested_amount);
      }

      // Emit single TeamRevocation event for entire batch
      await this._emitBatchRevocationEvent({
        vaultAddress,
        vaultId: vault.id,
        adminAddress,
        reason,
        beneficiaryCount: beneficiaryAddresses.length,
        totalUnvestedReturned,
        totalVestedPaid,
        results,
        transaction,
      });

      await transaction.commit();

      // Log audit trail
      await auditLogger.logAction(adminAddress, 'BATCH_REVOCATION', vaultAddress, {
        reason,
        beneficiaries_revoked: beneficiaryAddresses.length,
        total_unvested_returned: totalUnvestedReturned,
        total_vested_paid: totalVestedPaid,
        beneficiary_addresses: beneficiaryAddresses,
      });

      // Immutable Audit Log
      await AuditService.logAction({
        adminPubkey: adminAddress,
        action: AuditService.ACTIONS.REVOKE_GRANT,
        ipAddress: 'unknown',
        payload: { vaultAddress, beneficiaryAddresses, reason, treasuryAddress },
        resourceId: vaultAddress
      });

      return {
        success: true,
        message: `Successfully revoked ${beneficiaryAddresses.length} beneficiary(ies)`,
        vault_address: vaultAddress,
        beneficiaries_revoked: beneficiaryAddresses.length,
        total_vested_paid: totalVestedPaid.toString(),
        total_unvested_returned: totalUnvestedReturned.toString(),
        treasury_address: treasuryAddress || vault.owner_address,
        results,
      };
    } catch (error) {
      await transaction.rollback();
      logger.error('Batch revocation failed:', error);
      throw error;
    }
  }

  /**
   * Revoke a single beneficiary (internal helper)
   * 
   * @private
   */
  async _revokeSingleBeneficiary(vault, beneficiaryAddress, adminAddress, treasuryAddress, transaction) {
    const beneficiary = await Beneficiary.findOne({
      where: { 
        vault_id: vault.id, 
        address: beneficiaryAddress 
      },
      transaction,
    });

    if (!beneficiary) {
      throw new Error(`Beneficiary not found: ${beneficiaryAddress}`);
    }

    // Calculate clean break payout
    const cleanBreak = await vestingService.calculateCleanBreak(
      vault.address,
      beneficiary.address,
      new Date(),
      treasuryAddress || vault.owner_address
    );

    const unvestedAmount = cleanBreak.unearned_amount;
    const vestedAmount = cleanBreak.accrued_since_last_claim;

    // Update beneficiary status to revoked
    await beneficiary.update({
      status: 'revoked',
      revoked_at: new Date(),
      revocation_reason: 'batch_termination',
    }, { transaction });

    // Update vault balance - return unvested amount to treasury
    const currentVaultBalance = parseFloat(vault.total_amount);
    const newVaultBalance = currentVaultBalance - unvestedAmount;
    
    await vault.update({
      total_amount: newVaultBalance.toString(),
    }, { transaction });

    // Create audit log for individual revocation
    await auditLogger.logAction(adminAddress, 'BENEFICIARY_REVOKED', vault.address, {
      beneficiary_address: beneficiaryAddress,
      vested_amount: vestedAmount,
      unvested_returned: unvestedAmount,
      treasury_address: treasuryAddress || vault.owner_address,
    }, transaction);

    return {
      beneficiary_address: beneficiaryAddress,
      vested_amount: vestedAmount.toString(),
      unvested_returned: unvestedAmount.toString(),
      treasury_address: treasuryAddress || vault.owner_address,
      employee_payout: cleanBreak.transactions.employee_transfer,
      treasury_return: cleanBreak.transactions.treasury_transfer,
    };
  }

  /**
   * Emit batch revocation event (placeholder for blockchain event)
   * 
   * @private
   */
  async _emitBatchRevocationEvent(params) {
    const {
      vaultAddress,
      vaultId,
      adminAddress,
      reason,
      beneficiaryCount,
      totalUnvestedReturned,
      totalVestedPaid,
      results,
      transaction,
    } = params;

    // In production, this would emit a TeamRevocation event on-chain
    // For now, we log it and create an audit record
    
    logger.info('TeamRevocation Event Emitted:', {
      event: 'TeamRevocation',
      vault_address: vaultAddress,
      admin_address: adminAddress,
      reason: reason,
      beneficiaries_revoked: beneficiaryCount,
      total_unvested_returned: totalUnvestedReturned.toString(),
      total_vested_paid: totalVestedPaid.toString(),
      timestamp: new Date().toISOString(),
    });

    // Store event in database for audit purposes
    // This could be a dedicated TeamRevocationEvents table if needed
    await auditLogger.logAction(adminAddress, 'TEAM_REVOCATION_EVENT', vaultAddress, {
      event_type: 'TeamRevocation',
      reason,
      beneficiaries_revoked: beneficiaryCount,
      total_unvested_returned: totalUnvestedReturned,
      total_vested_paid: totalVestedPaid,
      beneficiary_results: results,
    }, transaction);
  }

  /**
   * Validate batch revocation parameters
   * 
   * @param {Object} params
   * @returns {Promise<boolean>}
   */
  async validateBatchRevocation(params) {
    const { vaultAddress, beneficiaryAddresses, adminAddress } = params;

    if (!vaultAddress) {
      throw new Error('vaultAddress is required');
    }

    if (!Array.isArray(beneficiaryAddresses)) {
      throw new Error('beneficiaryAddresses must be an array');
    }

    if (beneficiaryAddresses.length === 0) {
      throw new Error('beneficiaryAddresses cannot be empty');
    }

    if (!adminAddress) {
      throw new Error('adminAddress is required');
    }

    // Verify vault exists and is not blacklisted
    const vault = await Vault.findOne({ where: { address: vaultAddress } });
    
    if (!vault) {
      throw new Error(`Vault not found: ${vaultAddress}`);
    }

    if (vault.is_blacklisted) {
      throw new Error(`Vault ${vaultAddress} is blacklisted`);
    }

    // Verify all beneficiaries exist
    const beneficiaries = await Beneficiary.findAll({
      where: {
        vault_id: vault.id,
        address: beneficiaryAddresses,
      },
    });

    if (beneficiaries.length !== beneficiaryAddresses.length) {
      const foundAddresses = beneficiaries.map(b => b.address);
      const missingAddresses = beneficiaryAddresses.filter(addr => !foundAddresses.includes(addr));
      throw new Error(`Beneficiaries not found: ${missingAddresses.join(', ')}`);
    }

    return true;
  }
}

module.exports = new BatchRevocationService();
