const logger = require('../utils/logger');
const tvlService = require('../../services/tvlService');

export const tvlResolver = {
  Query: {
    tvlStats: async () => {
      try {
        const tvlStats = await tvlService.getTVLStats();
        return {
          totalValueLocked: tvlStats.total_value_locked.toString(),
          activeVaultsCount: tvlStats.active_vaults_count,
          formattedTvl: tvlService.formatTVL(tvlStats.total_value_locked),
          lastUpdatedAt: tvlStats.last_updated_at
        };
      } catch (error) {
        logger.error('Error fetching TVL stats:', error);
        throw new Error(`Failed to fetch TVL stats: ${error.message}`);
      }
    }
  }
};