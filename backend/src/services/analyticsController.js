const logger = require('../utils/logger');
const analyticsService = require('../services/analyticsService');

class AnalyticsController {
  async getTopClaimers(req, res) {
    try {
      const orgId = req.params.id;
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
      
      const topClaimers = await analyticsService.getTopClaimers(orgId, limit);
      
      return res.status(200).json({
        success: true,
        data: topClaimers
      });
    } catch (error) {
      logger.error('Error in getTopClaimers:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch top claimers'
      });
    }
  }
}

module.exports = new AnalyticsController();