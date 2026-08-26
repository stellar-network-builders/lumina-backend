const logger = require('../utils/logger');
const { ClaimsHistory, Organization, Token } = require('../models');
const { Op } = require('sequelize');
const cacheService = require('./cacheService');
const requestDeduplicationMiddleware = require('../middleware/requestDeduplication.middleware');

class AccountingExportService {
  /**
   * Generate Xero-compatible CSV for organization's token payroll expenses
   * @param {string} organizationId - Organization UUID
   * @param {Object} options - Export options
   * @returns {Promise<string>} CSV content
   */
  async generateXeroExport(organizationId, options = {}) {
    try {
      const {
        startDate,
        endDate,
        tokenAddress
      } = options;

      // Verify organization exists
      const organization = await Organization.findOne({
        where: { id: organizationId }
      });

      if (!organization) {
        throw new Error('Organization not found');
      }

      // Build query conditions
      const whereConditions = {
        claim_timestamp: {}
      };

      if (startDate) {
        whereConditions.claim_timestamp[Op.gte] = new Date(startDate);
      }

      if (endDate) {
        whereConditions.claim_timestamp[Op.lte] = new Date(endDate);
      }

      if (tokenAddress) {
        whereConditions.token_address = tokenAddress;
      }

      // Fetch claims with token and organization data
      const claims = await ClaimsHistory.findAll({
        where: whereConditions,
        include: [
          {
            model: Token,
            as: 'token',
            attributes: ['address', 'symbol', 'name'],
            required: false
          }
        ],
        order: [['claim_timestamp', 'ASC']]
      });

      // Generate Xero CSV
      const csvContent = this.generateXeroCSV(claims, organization);
      return csvContent;

    } catch (error) {
      logger.error('Error generating Xero export:', error);
      throw error;
    }
  }

  /**
   * Generate QuickBooks-compatible CSV for organization's token payroll expenses
   * @param {string} organizationId - Organization UUID
   * @param {Object} options - Export options
   * @returns {Promise<string>} CSV content
   */
  async generateQuickBooksExport(organizationId, options = {}) {
    try {
      const {
        startDate,
        endDate,
        tokenAddress
      } = options;

      // Verify organization exists
      const organization = await Organization.findOne({
        where: { id: organizationId }
      });

      if (!organization) {
        throw new Error('Organization not found');
      }

      // Build query conditions
      const whereConditions = {
        claim_timestamp: {}
      };

      if (startDate) {
        whereConditions.claim_timestamp[Op.gte] = new Date(startDate);
      }

      if (endDate) {
        whereConditions.claim_timestamp[Op.lte] = new Date(endDate);
      }

      if (tokenAddress) {
        whereConditions.token_address = tokenAddress;
      }

      // Fetch claims with token and organization data
      const claims = await ClaimsHistory.findAll({
        where: whereConditions,
        include: [
          {
            model: Token,
            as: 'token',
            attributes: ['address', 'symbol', 'name'],
            required: false
          }
        ],
        order: [['claim_timestamp', 'ASC']]
      });

      // Generate QuickBooks CSV
      const csvContent = this.generateQuickBooksCSV(claims, organization);
      return csvContent;

    } catch (error) {
      logger.error('Error generating QuickBooks export:', error);
      throw error;
    }
  }

  /**
   * Generate Xero-formatted CSV content
   * @param {Array} claims - Array of claim records
   * @param {Object} organization - Organization object
   * @returns {string} CSV content
   */
  generateXeroCSV(claims, organization) {
    const headers = [
      '*ContactName',
      '*Email',
      '*Amount',
      '*AccountCode',
      '*Description',
      '*Date',
      'Reference',
      'TaxType',
      'TrackingName1',
      'TrackingOption1',
      'TrackingName2',
      'TrackingOption2',
      'Currency',
      'Status'
    ];

    const rows = claims.map(claim => {
      const date = new Date(claim.claim_timestamp).toISOString().split('T')[0];
      const amount = claim.price_at_claim_usd ? claim.price_at_claim_usd : claim.amount_claimed;
      const tokenSymbol = claim.token?.symbol || 'UNKNOWN';
      const description = `Token payroll expense - ${tokenSymbol} tokens claimed by ${claim.user_address}`;
      
      return [
        organization.name || 'Unknown Organization', // ContactName
        '', // Email
        amount.toString(), // Amount
        '400', // AccountCode (default payroll expense account)
        `"${description}"`, // Description
        date, // Date
        claim.transaction_hash, // Reference
        'NONE', // TaxType
        '', // TrackingName1
        '', // TrackingOption1
        '', // TrackingName2
        '', // TrackingOption2
        'USD', // Currency
        'AUTHORISED' // Status
      ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Generate QuickBooks-formatted CSV content
   * @param {Array} claims - Array of claim records
   * @param {Object} organization - Organization object
   * @returns {string} CSV content
   */
  generateQuickBooksCSV(claims, organization) {
    const headers = [
      'Date',
      'Description',
      'Amount',
      'Account',
      'Name',
      'RefNumber',
      'Memo',
      'Class'
    ];

    const rows = claims.map(claim => {
      const date = new Date(claim.claim_timestamp).toISOString().split('T')[0];
      const amount = claim.price_at_claim_usd ? claim.price_at_claim_usd : claim.amount_claimed;
      const tokenSymbol = claim.token?.symbol || 'UNKNOWN';
      const description = `Token payroll expense - ${tokenSymbol} tokens claimed by ${claim.user_address}`;
      
      return [
        date, // Date
        `"${description}"`, // Description
        amount.toString(), // Amount
        'Payroll Expenses', // Account
        organization.name || 'Unknown Organization', // Name
        claim.transaction_hash, // RefNumber
        `Token: ${tokenSymbol}, Address: ${claim.user_address}`, // Memo
        'Token Payroll' // Class
      ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Get export summary statistics
   * @param {string} organizationId - Organization UUID
   * @param {Object} options - Export options
   * @returns {Promise<Object>} Export summary
   */
  async getExportSummary(organizationId, options = {}) {
    try {
      const {
        startDate,
        endDate,
        tokenAddress
      } = options;

      // Build query conditions
      const whereConditions = {
        claim_timestamp: {}
      };

      if (startDate) {
        whereConditions.claim_timestamp[Op.gte] = new Date(startDate);
      }

      if (endDate) {
        whereConditions.claim_timestamp[Op.lte] = new Date(endDate);
      }

      if (tokenAddress) {
        whereConditions.token_address = tokenAddress;
      }

      // Get summary statistics
      const summary = await ClaimsHistory.findAll({
        where: whereConditions,
        attributes: [
          [ClaimsHistory.sequelize.fn('COUNT', ClaimsHistory.sequelize.col('id')), 'totalClaims'],
          [ClaimsHistory.sequelize.fn('SUM', ClaimsHistory.sequelize.col('amount_claimed')), 'totalTokensClaimed'],
          [ClaimsHistory.sequelize.fn('SUM', ClaimsHistory.sequelize.col('price_at_claim_usd')), 'totalUSDValue'],
          [ClaimsHistory.sequelize.fn('MIN', ClaimsHistory.sequelize.col('claim_timestamp')), 'firstClaimDate'],
          [ClaimsHistory.sequelize.fn('MAX', ClaimsHistory.sequelize.col('claim_timestamp')), 'lastClaimDate']
        ],
        raw: true
      });

      const result = summary[0];
      
      return {
        organizationId,
        totalClaims: parseInt(result.totalClaims) || 0,
        totalTokensClaimed: parseFloat(result.totalTokensClaimed) || 0,
        totalUSDValue: parseFloat(result.totalUSDValue) || 0,
        firstClaimDate: result.firstClaimDate,
        lastClaimDate: result.lastClaimDate,
        dateRange: {
          startDate,
          endDate
        },
        tokenFilter: tokenAddress
      };

    } catch (error) {
      logger.error('Error getting export summary:', error);
      throw error;
    }
  }

  /**
   * Validate export parameters
   * @param {Object} options - Export options
   * @returns {Object} Validation result
   */
  validateExportOptions(options) {
    const errors = [];
    const { startDate, endDate } = options;

    if (startDate && !this.isValidDate(startDate)) {
      errors.push('Invalid startDate format. Use ISO 8601 format (YYYY-MM-DD).');
    }

    if (endDate && !this.isValidDate(endDate)) {
      errors.push('Invalid endDate format. Use ISO 8601 format (YYYY-MM-DD).');
    }

    if (startDate && endDate && new Date(startDate) > new Date(endDate)) {
      errors.push('startDate must be before endDate.');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Check if date string is valid
   * @param {string} dateString - Date string to validate
   * @returns {boolean} True if valid
   */
  isValidDate(dateString) {
    const date = new Date(dateString);
    return date instanceof Date && !isNaN(date);
  }

  /**
   * Invalidate accounting export cache for organization
   * @param {string} organizationId - Organization UUID
   * @returns {Promise<void>}
   */
  async invalidateExportCache(organizationId) {
    try {
      // Clear export data cache for this organization
      await cacheService.deletePattern(`export_${organizationId}_*`);
      
      // Clear deduplication cache for accounting export operations
      await requestDeduplicationMiddleware.clearOperationCache('accounting_export');
      
      logger.info(`[AccountingExport] Export cache invalidated for organization: ${organizationId}`);
    } catch (error) {
      logger.error('Error invalidating accounting export cache:', error);
    }
  }

  /**
   * Generate cache key for export operations
   * @param {string} organizationId - Organization UUID
   * @param {Object} options - Export options
   * @returns {string} Cache key
   */
  getExportCacheKey(organizationId, options) {
    const { startDate, endDate, tokenAddress, exportType } = options;
    const keyParts = [
      'export',
      organizationId,
      exportType || 'generic',
      startDate || 'no-start',
      endDate || 'no-end',
      tokenAddress || 'no-token'
    ];
    return keyParts.join('_');
  }
}

module.exports = new AccountingExportService();
