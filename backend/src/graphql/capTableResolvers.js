const logger = require('../utils/logger');
const capTableService = require('../services/capTableService');
const { Organization, Token } = require('../models');
const { GraphQLScalarType } = require('graphql');
const { Kind } = require('graphql/language');

// Custom BigDecimal scalar for precise decimal handling
const BigDecimal = new GraphQLScalarType({
  name: 'BigDecimal',
  description: 'BigDecimal custom scalar type',
  serialize(value) {
    return value ? value.toString() : null;
  },
  parseValue(value) {
    return value ? parseFloat(value) : null;
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT || ast.kind === Kind.FLOAT) {
      return parseFloat(ast.value);
    }
    return null;
  }
});

// Main cap table resolvers
const capTableResolvers = {
  BigDecimal,

  Query: {
    /**
     * Get comprehensive Web3 Cap Table for a token
     */
    async web3CapTable(_, { tokenAddress, options = {} }) {
      try {
        return await capTableService.generateCapTable(tokenAddress, options);
      } catch (error) {
        logger.error('Error generating cap table:', error);
        throw new Error(`Failed to generate cap table: ${error.message}`);
      }
    },

    /**
     * Get organization-level cap table
     */
    async organizationCapTable(_, { organizationId, options = {} }) {
      try {
        return await capTableService.getOrganizationCapTable(organizationId, null, options);
      } catch (error) {
        logger.error('Error generating organization cap table:', error);
        throw new Error(`Failed to generate organization cap table: ${error.message}`);
      }
    },

    /**
     * Get individual beneficiary's position
     */
    async beneficiaryCapPosition(_, { beneficiaryAddress, tokenAddress }) {
      try {
        return await capTableService.getBeneficiaryPosition(beneficiaryAddress, tokenAddress);
      } catch (error) {
        logger.error('Error getting beneficiary position:', error);
        throw new Error(`Failed to get beneficiary position: ${error.message}`);
      }
    },

    /**
     * Get cap table analytics
     */
    async capTableAnalytics(_, { tokenAddress, period = '30d', organizationId }) {
      try {
        return await capTableService.getCapTableAnalytics(tokenAddress, period, organizationId);
      } catch (error) {
        logger.error('Error getting cap table analytics:', error);
        throw new Error(`Failed to get cap table analytics: ${error.message}`);
      }
    },

    /**
     * Search beneficiaries in cap table
     */
    async searchCapTableBeneficiaries(_, { tokenAddress, query, first = 50, after }) {
      try {
        const options = { first, after };
        return await capTableService.searchBeneficiaries(tokenAddress, query, options);
      } catch (error) {
        logger.error('Error searching beneficiaries:', error);
        throw new Error(`Failed to search beneficiaries: ${error.message}`);
      }
    },

    /**
     * Get top token holders
     */
    async topTokenHolders(_, { tokenAddress, limit = 10, organizationId }) {
      try {
        const options = { organizationId };
        const capTable = await capTableService.generateCapTable(tokenAddress, options);
        
        return capTable.beneficiaryHoldings
          .sort((a, b) => parseFloat(b.totalVested) - parseFloat(a.totalVested))
          .slice(0, limit);
      } catch (error) {
        logger.error('Error getting top token holders:', error);
        throw new Error(`Failed to get top token holders: ${error.message}`);
      }
    },

    /**
     * Get vesting concentration metrics
     */
    async vestingConcentration(_, { tokenAddress, organizationId }) {
      try {
        return await capTableService.getConcentrationMetrics(tokenAddress, organizationId);
      } catch (error) {
        logger.error('Error getting concentration metrics:', error);
        throw new Error(`Failed to get concentration metrics: ${error.message}`);
      }
    }
  },

  Mutation: {
    /**
     * Refresh cap table calculations
     */
    async refreshCapTable(_, { tokenAddress }) {
      try {
        // This would trigger recalculation of vested amounts
        // For now, we'll just return true as a placeholder
        // In a real implementation, this would update cached calculations
        logger.info(`Refreshing cap table for token: ${tokenAddress}`);
        return true;
      } catch (error) {
        logger.error('Error refreshing cap table:', error);
        throw new Error(`Failed to refresh cap table: ${error.message}`);
      }
    },

    /**
     * Export cap table to CSV
     */
    async exportCapTable(_, { tokenAddress, options = {}, format = 'csv' }) {
      try {
        const capTable = await capTableService.generateCapTable(tokenAddress, options);
        const exportUrl = await capTableService.exportCapTable(capTable, format);
        return exportUrl;
      } catch (error) {
        logger.error('Error exporting cap table:', error);
        throw new Error(`Failed to export cap table: ${error.message}`);
      }
    },

    /**
     * Generate cap table report
     */
    async generateCapTableReport(_, { tokenAddress, reportType, options = {} }) {
      try {
        const capTable = await capTableService.generateCapTable(tokenAddress, options);
        const reportUrl = await capTableService.generateReport(capTable, reportType);
        return reportUrl;
      } catch (error) {
        logger.error('Error generating cap table report:', error);
        throw new Error(`Failed to generate cap table report: ${error.message}`);
      }
    }
  }
};

module.exports = capTableResolvers;
