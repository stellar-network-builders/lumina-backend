'use strict';

const logger = require('../utils/logger');
const { Vault } = require('../models');
const { sequelize } = require('../database/connection');
const { Op } = require('sequelize');

class FeeDistributorService {
  /**
   * Track accumulated fees across all vaults.
   * This is a batch process to summarize accumulated fees and trigger distribution.
   */
  async summarizeAccumulatedFees() {
    const totalFees = await Vault.sum('accumulated_fees', {
      where: {
        accumulated_fees: { [Op.gt]: 0 }
      }
    });

    return totalFees || 0;
  }

  /**
   * Check if the total accumulated fees across all vaults meet the threshold.
   * If so, trigger a batch transaction (simulated for now).
   */
  async checkAndDistributeFees() {
    const threshold = parseFloat(process.env.PROTOCOL_FEE_THRESHOLD || '100'); // Default 100 tokens
    const total = await this.summarizeAccumulatedFees();

    if (total >= threshold) {
      logger.info(`🚀 Fee threshold met (${total} >= ${threshold}). Triggering distribution to Treasury...`);
      return await this.distributeFees();
    }

    return { success: true, message: 'Threshold not met yet', currentTotal: total };
  }

  /**
   * Distribute fees by moving them to the treasury.
   */
  async distributeFees() {
    const treasuryAddress = process.env.PROTOCOL_TREASURY_ADDRESS;
    if (!treasuryAddress) throw new Error('PROTOCOL_TREASURY_ADDRESS not configured');

    const vaultsWithFees = await Vault.findAll({
      where: {
        accumulated_fees: { [Op.gt]: 0 }
      }
    });

    const distributions = [];
    
    // Use transaction for consistency
    const result = await sequelize.transaction(async (t) => {
        for (const vault of vaultsWithFees) {
            const amount = vault.accumulated_fees;
            
            // Simulation: In reality, we'd trigger a Stellar transaction here via StellarService
            distributions.push({
                vault_address: vault.address,
                amount: amount,
                token_address: vault.token_address,
                recipient: treasuryAddress
            });

            // Reset accumulated fees in this vault
            await vault.update({ accumulated_fees: 0 }, { transaction: t });
        }
        return distributions;
    });

    return {
        success: true,
        total_distributed: distributions.reduce((sum, d) => sum + parseFloat(d.amount), 0),
        distributions
    };
  }

  /**
   * Helper to add fees to a vault (e.g., when a stream is processed).
   * Usually called by another service when a distribution or payment is made.
   */
  async accumulateFeeForVault(vaultId, transactionAmount) {
     const feeRate = parseFloat(process.env.PROTOCOL_FEE_RATE || '0.001'); // 0.1%
     const feeAmount = transactionAmount * feeRate;
     
     const vault = await Vault.findByPk(vaultId);
     if (vault) {
        await vault.update({
            accumulated_fees: parseFloat(vault.accumulated_fees) + feeAmount
        });
     }
     return feeAmount;
  }
}

module.exports = new FeeDistributorService();
