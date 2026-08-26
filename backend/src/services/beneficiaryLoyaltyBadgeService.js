'use strict';

const logger = require('../utils/logger');
const { LoyaltyBadge, Beneficiary, Vault } = require('../models');
const { sequelize } = require('../database/connection');
const StellarSdk = require('stellar-sdk');
const auditLogger = require('./auditLogger');

class BeneficiaryLoyaltyBadgeService {
  constructor() {
    this.server = new StellarSdk.Server(
      process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
    );
    this.diamondHandsThresholdDays = 365; // 1 year for Diamond Hands badge
    this.balanceCheckIntervalHours = 24; // Check balances daily
  }

  /**
   * Start monitoring a beneficiary's wallet balance for loyalty badge eligibility
   * @param {string} beneficiaryId - The beneficiary ID to monitor
   * @param {Date} startDate - When to start monitoring (defaults to now)
   * @returns {Promise<Object>} Monitoring status
   */
  async startMonitoring(beneficiaryId, startDate = new Date()) {
    try {
      const beneficiary = await Beneficiary.findByPk(beneficiaryId, {
        include: [{ model: Vault, as: 'vault' }]
      });

      if (!beneficiary) {
        throw new Error('Beneficiary not found');
      }

      // Check if already being monitored for Diamond Hands
      const existingBadge = await LoyaltyBadge.findOne({
        where: {
          beneficiary_id: beneficiaryId,
          badge_type: 'diamond_hands',
          is_active: true
        }
      });

      if (existingBadge) {
        return {
          success: false,
          message: 'Beneficiary is already being monitored or has already earned Diamond Hands badge',
          existingBadge
        };
      }

      // Get initial balance
      const initialBalance = await this.getWalletBalance(beneficiary.address);
      
      // Create monitoring record
      const monitoringRecord = await LoyaltyBadge.create({
        beneficiary_id: beneficiaryId,
        badge_type: 'diamond_hands',
        monitoring_start_date: startDate,
        initial_vested_amount: beneficiary.total_allocated,
        current_balance: initialBalance,
        retention_period_days: 0,
        last_balance_check: new Date(),
        is_active: true
      });

      await auditLogger.log({
        action: 'loyalty_badge_monitoring_started',
        beneficiary_id: beneficiaryId,
        address: beneficiary.address,
        initial_balance: initialBalance,
        monitoring_start_date: startDate
      });

      return {
        success: true,
        message: 'Started monitoring beneficiary for Diamond Hands badge',
        monitoringRecord
      };

    } catch (error) {
      logger.error('Error starting loyalty badge monitoring:', error);
      throw error;
    }
  }

  /**
   * Get current wallet balance from Stellar network
   * @param {string} walletAddress - Stellar wallet address
   * @returns {Promise<string>} Current balance
   */
  async getWalletBalance(walletAddress) {
    try {
      const account = await this.server.loadAccount(walletAddress);
      const nativeBalance = account.balances.find(b => b.asset_type === 'native');
      return nativeBalance ? parseFloat(nativeBalance.balance) : 0;
    } catch (error) {
      logger.error(`Error fetching balance for ${walletAddress}:`, error);
      return 0;
    }
  }

  /**
   * Check all active monitoring records and update retention periods
   * This should be called periodically (e.g., daily cron job)
   * @returns {Promise<Object>} Results of the monitoring check
   */
  async checkAndUpdateRetentionPeriods() {
    try {
      const activeMonitoring = await LoyaltyBadge.findAll({
        where: {
          is_active: true,
          badge_type: 'diamond_hands'
        },
        include: [{ model: Beneficiary, as: 'beneficiary' }]
      });

      const results = {
        checked: activeMonitoring.length,
        updated: 0,
        badgesAwarded: 0,
        errors: []
      };

      for (const record of activeMonitoring) {
        try {
          const currentBalance = await this.getWalletBalance(record.beneficiary.address);
          const daysSinceStart = Math.floor(
            (new Date() - new Date(record.monitoring_start_date)) / (1000 * 60 * 60 * 24)
          );

          // Check if balance has been maintained (no selling)
          const hasSoldTokens = currentBalance < record.current_balance;
          
          if (hasSoldTokens) {
            // Deactivate monitoring if tokens were sold
            await record.update({
              is_active: false,
              last_balance_check: new Date()
            });

            await auditLogger.log({
              action: 'loyalty_badge_monitoring_deactivated',
              beneficiary_id: record.beneficiary_id,
              reason: 'tokens_sold',
              previous_balance: record.current_balance,
              current_balance: currentBalance
            });

            continue;
          }

          // Update retention period
          const newRetentionDays = Math.min(daysSinceStart, this.diamondHandsThresholdDays);
          await record.update({
            current_balance: currentBalance,
            retention_period_days: newRetentionDays,
            last_balance_check: new Date()
          });

          results.updated++;

          // Check if Diamond Hands badge should be awarded
          if (newRetentionDays >= this.diamondHandsThresholdDays && !record.awarded_at) {
            await this.awardDiamondHandsBadge(record.id);
            results.badgesAwarded++;
          }

        } catch (error) {
          results.errors.push({
            beneficiary_id: record.beneficiary_id,
            error: error.message
          });
        }
      }

      return results;

    } catch (error) {
      logger.error('Error checking retention periods:', error);
      throw error;
    }
  }

  /**
   * Award Diamond Hands badge to a beneficiary
   * @param {string} loyaltyBadgeId - The loyalty badge record ID
   * @returns {Promise<Object>} Award result
   */
  async awardDiamondHandsBadge(loyaltyBadgeId) {
    try {
      const badgeRecord = await LoyaltyBadge.findByPk(loyaltyBadgeId, {
        include: [{ model: Beneficiary, as: 'beneficiary' }]
      });

      if (!badgeRecord) {
        throw new Error('Loyalty badge record not found');
      }

      if (badgeRecord.awarded_at) {
        throw new Error('Badge already awarded');
      }

      // Update badge record with award information
      await badgeRecord.update({
        awarded_at: new Date(),
        is_active: false // Monitoring complete
      });

      // Grant Discord role (if configured)
      const discordRoleGranted = await this.grantDiscordRole(badgeRecord.beneficiary);

      // Grant priority access (if configured)
      const priorityAccessGranted = await this.grantPriorityAccess(badgeRecord.beneficiary);

      // Mint NFT badge (if configured)
      const nftMetadataUri = await this.mintBadgeNFT(badgeRecord.beneficiary);

      await badgeRecord.update({
        discord_role_granted: discordRoleGranted,
        priority_access_granted: priorityAccessGranted,
        nft_metadata_uri: nftMetadataUri
      });

      await auditLogger.log({
        action: 'diamond_hands_badge_awarded',
        beneficiary_id: badgeRecord.beneficiary_id,
        address: badgeRecord.beneficiary.address,
        retention_period_days: badgeRecord.retention_period_days,
        nft_metadata_uri: nftMetadataUri
      });

      return {
        success: true,
        message: 'Diamond Hands badge awarded successfully',
        badge: badgeRecord,
        benefits: {
          discordRole: discordRoleGranted,
          priorityAccess: priorityAccessGranted,
          nftMinted: !!nftMetadataUri
        }
      };

    } catch (error) {
      logger.error('Error awarding Diamond Hands badge:', error);
      throw error;
    }
  }

  /**
   * Grant Discord role to beneficiary (placeholder implementation)
   * @param {Beneficiary} beneficiary - The beneficiary to grant role to
   * @returns {Promise<boolean>} Success status
   */
  async grantDiscordRole(beneficiary) {
    try {
      // This would integrate with Discord API
      // For now, return true if Discord webhook is configured
      if (process.env.DISCORD_WEBHOOK_URL) {
        // TODO: Implement Discord API integration
        logger.info(`Discord role granted to ${beneficiary.address}`);
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Error granting Discord role:', error);
      return false;
    }
  }

  /**
   * Grant priority access to beneficiary (placeholder implementation)
   * @param {Beneficiary} beneficiary - The beneficiary to grant access to
   * @returns {Promise<boolean>} Success status
   */
  async grantPriorityAccess(beneficiary) {
    try {
      // This would update beneficiary's priority access status
      // For now, just log the action
      logger.info(`Priority access granted to ${beneficiary.address}`);
      return true;
    } catch (error) {
      logger.error('Error granting priority access:', error);
      return false;
    }
  }

  /**
   * Mint NFT badge for beneficiary (placeholder implementation)
   * @param {Beneficiary} beneficiary - The beneficiary to mint NFT for
   * @returns {Promise<string|null>} NFT metadata URI or null
   */
  async mintBadgeNFT(beneficiary) {
    try {
      // This would integrate with NFT minting service
      // For now, return a mock metadata URI
      const metadataUri = `https://metadata.example.com/badges/diamond-hands/${beneficiary.id}`;
      logger.info(`NFT badge minted for ${beneficiary.address}: ${metadataUri}`);
      return metadataUri;
    } catch (error) {
      logger.error('Error minting NFT badge:', error);
      return null;
    }
  }

  /**
   * Get all badges for a beneficiary
   * @param {string} beneficiaryId - The beneficiary ID
   * @returns {Promise<Array>} Array of badges
   */
  async getBeneficiaryBadges(beneficiaryId) {
    try {
      const badges = await LoyaltyBadge.findAll({
        where: { beneficiary_id: beneficiaryId },
        include: [{ model: Beneficiary, as: 'beneficiary' }],
        order: [['created_at', 'DESC']]
      });

      return badges;
    } catch (error) {
      logger.error('Error fetching beneficiary badges:', error);
      throw error;
    }
  }

  /**
   * Get all Diamond Hands badge holders
   * @returns {Promise<Array>} Array of Diamond Hands badge holders
   */
  async getDiamondHandsHolders() {
    try {
      const holders = await LoyaltyBadge.findAll({
        where: {
          badge_type: 'diamond_hands',
          awarded_at: { [sequelize.Op.ne]: null }
        },
        include: [{ model: Beneficiary, as: 'beneficiary' }],
        order: [['awarded_at', 'DESC']]
      });

      return holders;
    } catch (error) {
      logger.error('Error fetching Diamond Hands holders:', error);
      throw error;
    }
  }

  /**
   * Get monitoring statistics
   * @returns {Promise<Object>} Monitoring statistics
   */
  async getMonitoringStatistics() {
    try {
      const stats = await LoyaltyBadge.findAll({
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('id')), 'total'],
          [sequelize.fn('COUNT', sequelize.literal('CASE WHEN awarded_at IS NOT NULL THEN 1 END')), 'awarded'],
          [sequelize.fn('COUNT', sequelize.literal('CASE WHEN is_active = true THEN 1 END')), 'active_monitoring'],
          [sequelize.fn('AVG', sequelize.col('retention_period_days')), 'avg_retention_days']
        ],
        where: { badge_type: 'diamond_hands' },
        raw: true
      });

      return {
        total_monitored: parseInt(stats[0].total),
        badges_awarded: parseInt(stats[0].awarded),
        active_monitoring: parseInt(stats[0].active_monitoring),
        average_retention_days: parseFloat(stats[0].avg_retention_days || 0)
      };

    } catch (error) {
      logger.error('Error fetching monitoring statistics:', error);
      throw error;
    }
  }
}

module.exports = BeneficiaryLoyaltyBadgeService;
