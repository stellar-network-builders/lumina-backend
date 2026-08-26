const logger = require('../utils/logger');
const { Vault, TVL } = require('../models');
const cacheService = require('./cacheService');
const requestDeduplicationMiddleware = require('../middleware/requestDeduplication.middleware');

class TVLService {
  /**
   * Calculate total TVL from all active vaults
   * @returns {Promise<{totalValueLocked: number, activeVaultsCount: number}>}
   */
  async calculateTVL() {
    const cacheKey = 'tvl_calculation';
    return await cacheService.wrapWithCache(cacheKey, async () => {
      return this._calculateTVLInternal();
    }, 900); // 15 minutes TTL
  }

  async _calculateTVLInternal() {
    try {
      const vaults = await Vault.findAll({
        where: { is_active: true }
      });

      let totalValueLocked = 0;
      for (const vault of vaults) {
        totalValueLocked += parseFloat(vault.total_amount || 0);
      }

      return {
        totalValueLocked,
        activeVaultsCount: vaults.length
      };
    } catch (error) {
      logger.error('Error calculating TVL:', error);
      throw error;
    }
  }

  /**
   * Create a historical TVL snapshot
   * @param {Date} snapshotDate - Date for the snapshot (defaults to today)
   * @returns {Promise<HistoricalTVL>} Created historical TVL record
   */
  async createHistoricalSnapshot(snapshotDate = new Date()) {
    try {
      const { totalValueLocked, activeVaultsCount } = await this.calculateTVL();
      
      // Get previous day's snapshot for change calculations
      const yesterday = new Date(snapshotDate);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];
      
      const previousSnapshot = await HistoricalTVL.findOne({
        where: { snapshot_date: yesterdayStr }
      });
      
      let tvlChange24h = null;
      let tvlChangePercentage24h = null;
      
      if (previousSnapshot) {
        tvlChange24h = totalValueLocked - parseFloat(previousSnapshot.total_value_locked);
        tvlChangePercentage24h = previousSnapshot.total_value_locked > 0 
          ? (tvlChange24h / parseFloat(previousSnapshot.total_value_locked)) * 100 
          : null;
      }
      
      const snapshotDateStr = snapshotDate.toISOString().split('T')[0];
      
      // Check if snapshot already exists for this date
      const existingSnapshot = await HistoricalTVL.findOne({
        where: { snapshot_date: snapshotDateStr }
      });
      
      if (existingSnapshot) {
        // Update existing snapshot
        await existingSnapshot.update({
          total_value_locked: totalValueLocked,
          active_vaults_count: activeVaultsCount,
          tvl_change_24h: tvlChange24h,
          tvl_change_percentage_24h: tvlChangePercentage24h,
          snapshot_timestamp: new Date()
        });
        return existingSnapshot;
      } else {
        // Create new snapshot
        return await HistoricalTVL.create({
          snapshot_date: snapshotDateStr,
          total_value_locked: totalValueLocked,
          active_vaults_count: activeVaultsCount,
          tvl_change_24h: tvlChange24h,
          tvl_change_percentage_24h: tvlChangePercentage24h,
          snapshot_timestamp: new Date()
        });
      }
    } catch (error) {
      logger.error('Error creating historical TVL snapshot:', error);
      throw error;
    }
  }

  /**
   * Get historical TVL data for a date range
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date (defaults to today)
   * @returns {Promise<Array>} Array of historical TVL records
   */
  async getHistoricalTVL(startDate, endDate = new Date()) {
    try {
      return await HistoricalTVL.findAll({
        where: {
          snapshot_date: {
            [require('sequelize').Op.between]: [
              startDate.toISOString().split('T')[0],
              endDate.toISOString().split('T')[0]
            ]
          }
        },
        order: [['snapshot_date', 'ASC']]
      });
    } catch (error) {
      logger.error('Error getting historical TVL:', error);
      throw error;
    }
  }

  /**
   * Update TVL record in database and broadcast via WebSocket
   * @returns {Promise<TVL>} Updated TVL record
   */
  async updateTVL() {
    try {
      const { totalValueLocked, activeVaultsCount } = await this.calculateTVL();

      // Get or create TVL record (there should only be one)
      let tvlRecord = await TVL.findOne();

      if (tvlRecord) {
        await tvlRecord.update({
          total_value_locked: totalValueLocked,
          active_vaults_count: activeVaultsCount,
          last_updated_at: new Date()
        });
      } else {
        tvlRecord = await TVL.create({
          total_value_locked: totalValueLocked,
          active_vaults_count: activeVaultsCount,
          last_updated_at: new Date()
        });
      }

      logger.info(`TVL updated: ${totalValueLocked} across ${activeVaultsCount} vaults`);

      // Create historical snapshot (don't await to avoid blocking)
      this.createHistoricalSnapshot().catch(error => {
        logger.error('Error creating historical TVL snapshot:', error);
      });

      // Broadcast TVL update via WebSocket
      await this.broadcastTVLUpdate(tvlRecord);

      return tvlRecord;
    } catch (error) {
      logger.error('Error updating TVL:', error);
      throw error;
    }
  }

  /**
   * Get current TVL stats
   * @returns {Promise<Object>} TVL stats
   */
  async getTVLStats() {
    const cacheKey = 'tvl_stats';
    return await cacheService.wrapWithCache(cacheKey, async () => {
      try {
        let tvlRecord = await TVL.findOne();

        // If no record exists, calculate and create one
        if (!tvlRecord) {
          tvlRecord = await this.updateTVL();
        }

        return {
          total_value_locked: parseFloat(tvlRecord.total_value_locked),
          active_vaults_count: tvlRecord.active_vaults_count,
          last_updated_at: tvlRecord.last_updated_at,
          created_at: tvlRecord.created_at
        };
      } catch (error) {
        logger.error('Error getting TVL stats:', error);
        throw error;
      }
    }, 900); // 15 minutes TTL
  }

  /**
   * Handle vault created event - increment TVL
   * @param {Object} vaultData - New vault data
   * @returns {Promise<void>}
   */
  async handleVaultCreated(vaultData) {
    try {
      logger.info(`Handling VaultCreated event for vault: ${vaultData.address}`);
      
      // Clear TVL cache and related deduplication cache
      await this.invalidateTVLCache();
      
      await this.updateTVL();
    } catch (error) {
      logger.error('Error handling vault created event:', error);
    }
  }

  /**
   * Handle claim event - decrement TVL by claimed amount
   * @param {Object} claimData - Claim data
   * @returns {Promise<void>}
   */
  async handleClaim(claimData) {
    try {
      logger.info(`Handling Claim event for transaction: ${claimData.transaction_hash}`);
      
      // Clear TVL cache and related deduplication cache
      await this.invalidateTVLCache();
      
      await this.updateTVL();
    } catch (error) {
      logger.error('Error handling claim event:', error);
    }
  }

  /**
   * Invalidate TVL cache and deduplication entries
   * @returns {Promise<void>}
   */
  async invalidateTVLCache() {
    try {
      // Clear TVL data cache
      await cacheService.deletePattern('tvl_*');
      
      // Clear deduplication cache for TVL operations
      await requestDeduplicationMiddleware.clearOperationCache('tvl_calculation');
      
      logger.info('[TVL] TVL cache invalidated');
    } catch (error) {
      logger.error('Error invalidating TVL cache:', error);
    }
  }

  /**
   * Format TVL value to human-readable string
   * @param {number} tvl - TVL value
   * @returns {string} Formatted TVL string (e.g., "$5M", "$500K")
   */
  formatTVL(tvl) {
    if (tvl >= 1000000) {
      return `$${(tvl / 1000000).toFixed(2)}M`;
    } else if (tvl >= 1000) {
      return `$${(tvl / 1000).toFixed(2)}K`;
    }
    return `$${tvl.toFixed(2)}`;
  }

  /**
   * Broadcast TVL update via WebSocket
   * @param {Object} tvlRecord - TVL database record
   * @returns {Promise<void>}
   */
  async broadcastTVLUpdate(tvlRecord) {
    try {
      // Import here to avoid circular dependency
      const { publishTVLUpdate } = require('../graphql/subscriptions/proofSubscription');
      
      const tvlStats = {
        totalValueLocked: parseFloat(tvlRecord.total_value_locked),
        activeVaultsCount: tvlRecord.active_vaults_count,
        formattedTvl: this.formatTVL(parseFloat(tvlRecord.total_value_locked)),
        lastUpdatedAt: tvlRecord.last_updated_at
      };

      await publishTVLUpdate(tvlStats);
    } catch (error) {
      logger.error('Error broadcasting TVL update:', error);
      // Don't throw - broadcast failure shouldn't fail TVL update
    }
  }
}

module.exports = new TVLService();
