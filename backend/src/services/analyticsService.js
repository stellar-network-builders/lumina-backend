const logger = require('../utils/logger');
const { sequelize } = require('../database/connection');
const { QueryTypes } = require('sequelize');

class AnalyticsService {
  /**
   * Get top claimers for an organization
   * @param {string} orgId - Organization ID
   * @param {number} limit - Number of results to return
   * @returns {Promise<Array>} List of top claimers
   */
  async getTopClaimers(orgId, limit = 50) {
    try {
      const topClaimers = await sequelize.query(
        `SELECT b.address as beneficiary_address, SUM(CAST(COALESCE(b.total_withdrawn, '0') AS NUMERIC)) as total_claimed
         FROM beneficiaries b
         JOIN vaults v ON b.vault_id = v.id
         WHERE v.org_id = :orgId
         GROUP BY b.address
         ORDER BY total_claimed DESC
         LIMIT :limit`,
        {
          replacements: { orgId, limit },
          type: QueryTypes.SELECT
        }
      );

      return topClaimers.map(claimer => ({
        beneficiary_address: claimer.beneficiary_address,
        total_claimed: claimer.total_claimed ? claimer.total_claimed.toString() : '0'
      }));
    } catch (error) {
      logger.error('Error fetching top claimers:', error);
      throw error;
    }
  }
}

module.exports = new AnalyticsService();