/**
 * VaultService - Service for vault-related operations
 * 
 * This service handles vault queries including balance information
 * for both static and dynamic tokens.
 */

const BalanceTracker = require('./balanceTracker');
const BalanceInfo = require('../models/BalanceInfo');
const { Vault, SubSchedule, Beneficiary } = require('../models');
const ClaimCalculator = require('./claimCalculator');
const cacheService = require('./cacheService');

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
    const cacheKey = `vesting:vault:${vaultId}`;
    return await cacheService.getOrSet(cacheKey, 300, async () => {
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
          console.error(`Failed to query actual balance for vault ${vaultId}:`, error);
          throw error;
        }

        // Calculate distribution ratios for dynamic vaults
        distributionRatios = await this._calculateDistributionRatios(vault, actualBalance);
      }

      // Create and return BalanceInfo
      const balanceInfo = BalanceInfo.fromVault(vault, actualBalance, distributionRatios);
      return JSON.parse(JSON.stringify(balanceInfo));
    });
  }

  /**
   * Get vault by ID with caching (5m TTL)
   * @param {string} vaultId - Vault ID
   * @returns {Promise<Object>} Vault details
   */
  async getVaultById(vaultId) {
    const cacheKey = `vesting:vault:${vaultId}`;
    return await cacheService.getOrSet(cacheKey, 300, async () => {
      const vault = await Vault.findByPk(vaultId);
      return vault ? vault.toJSON() : null;
    });
  }

  /**
   * Get sub-schedules for a vault with caching (2m TTL)
   * @param {string} vaultId - Vault ID
   * @returns {Promise<Array<Object>>} Sub-schedules
   */
  async getSubSchedulesByVaultId(vaultId) {
    const cacheKey = `vesting:sub_schedule:${vaultId}`;
    return await cacheService.getOrSet(cacheKey, 120, async () => {
      const subSchedules = await SubSchedule.findAll({
        where: { vault_id: vaultId }
      });
      return subSchedules.map(ss => ss.toJSON());
    });
  }

  /**
   * Get claims history for a sub-schedule with caching (30s TTL)
   * @param {string} subScheduleId - Sub-schedule ID
   * @returns {Promise<Array<Object>>} Claims history
   */
  async getClaimsBySubScheduleId(subScheduleId) {
    const cacheKey = `vesting:claims:${subScheduleId}`;
    return await cacheService.getOrSet(cacheKey, 30, async () => {
      const subSchedule = await SubSchedule.findByPk(subScheduleId);
      if (!subSchedule) return [];

      const { ClaimsHistory } = require('../models');
      const claims = await ClaimsHistory.findAll({
        where: { vault_id: subSchedule.vault_id }
      });
      return claims.map(c => c.toJSON());
    });
  }

  /**
   * Invalidate cache for a vault (after write operations)
   * @param {string} vaultId - Vault ID
   */
  async invalidateVaultCache(vaultId) {
    await cacheService.invalidatePattern(`vesting:vault:${vaultId}`);
    await cacheService.invalidatePattern(`vesting:sub_schedule:${vaultId}`);
    await cacheService.invalidatePattern(`vesting:claims:*`);
    const vault = await Vault.findByPk(vaultId);
    if (vault) {
      await cacheService.invalidatePattern(`vesting:schedule:${vault.address}*`);
    }
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
      };
    });

    return ratios;
  }
}

module.exports = VaultService;
