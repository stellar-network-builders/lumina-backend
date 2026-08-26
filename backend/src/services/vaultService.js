/**
 * VaultService - Service for vault-related operations
 * 
 * This service handles vault queries including balance information
 * for both static and dynamic tokens.
 */

const logger = require('../utils/logger');
const BalanceTracker = require('./balanceTracker');
const BalanceInfo = require('../models/BalanceInfo');
const { Vault, SubSchedule, Beneficiary } = require('../models');
const ClaimCalculator = require('./claimCalculator');

class VaultService {
  /**
   * Create a VaultService instance
   * @param {string} rpcUrl - Optional Stellar RPC URL
   */
  constructor(rpcUrl = null) {
    this.balanceTracker = new BalanceTracker(rpcUrl);
    this.claimCalculator = new ClaimCalculator(rpcUrl);
  }

  /**
   * Query balance information for a vault
   * @param {string} vaultId - The vault ID to query
   * @returns {Promise<BalanceInfo>} Balance information including tracked, actual, and delta
   * @throws {Error} If vault not found or balance query fails
   */
  async queryBalanceInfo(vaultId) {
    // Find the vault
    const vault = await Vault.findByPk(vaultId);
    
    if (!vault) {
      throw new Error(`Vault not found: ${vaultId}`);
    }

    if (vault.is_blacklisted) {
      throw new Error(`Vault ${vaultId} is blacklisted due to integrity failure.`);
    }

    const trackedBalance = vault.total_amount;
    let actualBalance = trackedBalance;
    let distributionRatios = null;

    // For dynamic tokens, query the actual SAC balance
    if (vault.token_type === 'dynamic') {
      try {
        actualBalance = await this.balanceTracker.getActualBalance(
          vault.token_address,
          vault.address
        );
      } catch (error) {
        logger.error(`Failed to query actual balance for vault ${vaultId}:`, error);
        throw error;
      }

      // Calculate distribution ratios for dynamic vaults
      distributionRatios = await this._calculateDistributionRatios(vault, actualBalance);
    }

    // Create and return BalanceInfo
    return BalanceInfo.fromVault(vault, actualBalance, distributionRatios);
  }

  /**
   * Calculate proportional distribution ratios for each beneficiary
   * @private
   * @param {Object} vault - The vault model instance
   * @param {string|number} actualBalance - The actual SAC balance
   * @returns {Promise<Array<Object>>} Array of distribution ratios per beneficiary
   */
  async _calculateDistributionRatios(vault, actualBalance) {
    // Get all subschedules for this vault
    const subSchedules = await SubSchedule.findAll({
      where: { vault_id: vault.id },
      attributes: [
        'id',
        'top_up_amount',
        'amount_withdrawn',
        'vesting_start_date',
        'vesting_duration',
        'cliff_date',
        'cliff_duration'
      ]
    });

    if (!subSchedules || subSchedules.length === 0) {
      return [];
    }

    // Get all beneficiaries for this vault
    const beneficiaries = await Beneficiary.findAll({
      where: { vault_id: vault.id },
      attributes: ['id', 'address', 'email', 'total_allocated', 'total_withdrawn']
    });

    if (!beneficiaries || beneficiaries.length === 0) {
      return [];
    }

    // Calculate total vested amount across all subschedules
    const currentTime = new Date();
    const totalVested = this.claimCalculator.calculateTotalVested(subSchedules, currentTime);

    // Calculate proportional ratios for each beneficiary
    const actualBalanceNum = typeof actualBalance === 'string' 
      ? parseFloat(actualBalance) 
      : actualBalance;

    const ratios = beneficiaries.map(beneficiary => {
      // Calculate vested amount for this beneficiary based on their allocation
      const allocatedNum = parseFloat(beneficiary.total_allocated);
      const withdrawnNum = parseFloat(beneficiary.total_withdrawn);
      
      // Calculate this beneficiary's ratio of the total vested
      const ratio = totalVested > 0 ? allocatedNum / parseFloat(vault.total_amount) : 0;
      
      // Calculate proportional share of actual balance
      const proportionalShare = actualBalanceNum * ratio;
      
      // Calculate claimable amount (proportional share minus what's already withdrawn)
      const claimable = Math.max(0, proportionalShare - withdrawnNum);

      return {
        beneficiary_id: beneficiary.id,
        beneficiary_address: beneficiary.address,
        beneficiary_email: beneficiary.email,
        allocated_amount: String(allocatedNum),
        withdrawn_amount: String(withdrawnNum),
        ratio: ratio.toFixed(6),
        proportional_share: String(proportionalShare.toFixed(18)),
        claimable_amount: String(claimable.toFixed(18))
      };
    });

    return ratios;
  }
}

module.exports = VaultService;
