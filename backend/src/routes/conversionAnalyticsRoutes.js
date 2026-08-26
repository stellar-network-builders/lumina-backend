const express = require('express');
const router = express.Router();
const CostBasisCalculationService = require('../services/costBasisCalculationService');
const ConversionEvent = require('../models/ConversionEvent');
const authService = require('../services/authService');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

const costBasisService = new CostBasisCalculationService();

// GET /api/conversion-analytics/cost-basis/:userAddress
// Calculate cost basis for a user's holdings
router.get(
  '/cost-basis/:userAddress',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const { userAddress } = req.params;
      const { assetCode, method = 'FIFO' } = req.query;

      // Validate parameters
      if (!userAddress) {
        return res.status(400).json({
          success: false,
          message: 'User address is required'
        });
      }

      if (!['FIFO', 'LIFO', 'AVERAGE'].includes(method)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid cost basis method. Must be FIFO, LIFO, or AVERAGE'
        });
      }

      const result = await costBasisService.calculateCostBasis(userAddress, assetCode, method);
      
      res.json(result);
    } catch (error) {
      logger.error('Error calculating cost basis:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/conversion-analytics/conversion-history/:userAddress
// Get conversion history for a user
router.get(
  '/conversion-history/:userAddress',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const { userAddress } = req.params;
      const { 
        assetCode, 
        limit = 100, 
        offset = 0,
        startDate,
        endDate,
        conversionType
      } = req.query;

      // Build where clause
      const whereClause = { user_address: userAddress };
      
      if (assetCode) {
        whereClause[Op.or] = [
          { source_asset_code: assetCode },
          { destination_asset_code: assetCode }
        ];
      }

      if (conversionType) {
        whereClause.conversion_type = conversionType;
      }

      if (startDate || endDate) {
        whereClause.transaction_timestamp = {};
        if (startDate) {
          whereClause.transaction_timestamp[Op.gte] = new Date(startDate);
        }
        if (endDate) {
          whereClause.transaction_timestamp[Op.lte] = new Date(endDate);
        }
      }

      const conversions = await ConversionEvent.findAll({
        where: whereClause,
        order: [['transaction_timestamp', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset),
        include: [
          {
            model: require('../models').ClaimsHistory,
            as: 'claim',
            required: false
          }
        ]
      });

      // Get total count for pagination
      const totalCount = await ConversionEvent.count({ where: whereClause });

      res.json({
        success: true,
        data: {
          conversions,
          pagination: {
            total: totalCount,
            limit: parseInt(limit),
            offset: parseInt(offset),
            hasMore: (parseInt(offset) + conversions.length) < totalCount
          }
        }
      });
    } catch (error) {
      logger.error('Error getting conversion history:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/conversion-analytics/tax-report/:userAddress/:taxYear
// Generate tax report for a user
router.get(
  '/tax-report/:userAddress/:taxYear',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const { userAddress, taxYear } = req.params;

      // Validate tax year
      const year = parseInt(taxYear);
      const currentYear = new Date().getFullYear();
      if (isNaN(year) || year < 2020 || year > currentYear) {
        return res.status(400).json({
          success: false,
          message: 'Invalid tax year. Must be between 2020 and current year.'
        });
      }

      const result = await costBasisService.generateTaxReport(userAddress, year);
      
      res.json(result);
    } catch (error) {
      logger.error('Error generating tax report:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/conversion-analytics/portfolio-summary/:userAddress
// Get portfolio summary with cost basis information
router.get(
  '/portfolio-summary/:userAddress',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const { userAddress } = req.params;
      const { includeUnrealized = 'true' } = req.query;

      // Get all unique assets for this user
      const assets = await ConversionEvent.findAll({
        where: { user_address: userAddress },
        attributes: [
          [sequelize.fn('DISTINCT', sequelize.col('source_asset_code')), 'asset_code'],
          [sequelize.fn('DISTINCT', sequelize.col('destination_asset_code')), 'dest_asset_code']
        ],
        raw: true
      });

      const allAssetCodes = new Set();
      assets.forEach(asset => {
        if (asset.asset_code) allAssetCodes.add(asset.asset_code);
        if (asset.dest_asset_code) allAssetCodes.add(asset.dest_asset_code);
      });

      const portfolioData = [];
      
      // Calculate cost basis for each asset
      for (const assetCode of allAssetCodes) {
        const costBasisResult = await costBasisService.calculateCostBasis(
          userAddress, 
          assetCode, 
          'FIFO'
        );
        
        if (costBasisResult.success) {
          portfolioData.push({
            assetCode,
            ...costBasisResult.data.summary
          });
        }
      }

      // Calculate portfolio totals
      const totalValue = portfolioData.reduce((sum, asset) => 
        sum + (parseFloat(asset.currentHolding) * (asset.averageCostBasis || 1)), 0
      );
      
      const totalCostBasis = portfolioData.reduce((sum, asset) => 
        sum + parseFloat(asset.totalCostBasis || 0), 0
      );
      
      const totalGain = portfolioData.reduce((sum, asset) => 
        sum + parseFloat(asset.totalGain || 0), 0
      );

      res.json({
        success: true,
        data: {
          userAddress,
          assets: portfolioData,
          portfolioSummary: {
            totalAssets: portfolioData.length,
            totalValue,
            totalCostBasis,
            totalGain,
            overallReturn: totalCostBasis > 0 ? (totalGain / totalCostBasis) * 100 : 0
          },
          lastUpdated: new Date()
        }
      });
    } catch (error) {
      logger.error('Error generating portfolio summary:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/conversion-analytics/exchange-rates
// Get exchange rate statistics
router.get(
  '/exchange-rates',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const { 
        sourceAsset,
        destinationAsset,
        period = '24h', // 1h, 24h, 7d, 30d
        limit = 100
      } = req.query;

      // Build where clause
      const whereClause = {};
      
      if (sourceAsset && destinationAsset) {
        whereClause[Op.and] = [
          { source_asset_code: sourceAsset },
          { destination_asset_code: destinationAsset }
        ];
      }

      // Calculate time period
      let startDate = new Date();
      switch (period) {
        case '1h':
          startDate.setHours(startDate.getHours() - 1);
          break;
        case '24h':
          startDate.setDate(startDate.getDate() - 1);
          break;
        case '7d':
          startDate.setDate(startDate.getDate() - 7);
          break;
        case '30d':
          startDate.setDate(startDate.getDate() - 30);
          break;
      }

      whereClause.transaction_timestamp = {
        [Op.gte]: startDate
      };

      const rateData = await ConversionEvent.findAll({
        where: whereClause,
        attributes: [
          'exchange_rate',
          'exchange_rate_usd',
          'transaction_timestamp',
          'source_amount',
          'destination_amount',
          'data_quality'
        ],
        order: [['transaction_timestamp', 'DESC']],
        limit: parseInt(limit)
      });

      // Calculate statistics
      const rates = rateData.map(r => parseFloat(r.exchange_rate));
      const usdRates = rateData.map(r => parseFloat(r.exchange_rate_usd || 0)).filter(rate => rate > 0);

      const statistics = {
        currentRate: rates.length > 0 ? rates[0] : 0,
        averageRate: rates.length > 0 ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : 0,
        minRate: rates.length > 0 ? Math.min(...rates) : 0,
        maxRate: rates.length > 0 ? Math.max(...rates) : 0,
        volatility: rates.length > 1 ? calculateVolatility(rates) : 0
      };

      if (usdRates.length > 0) {
        statistics.currentUSDRate = usdRates[0];
        statistics.averageUSDRate = usdRates.reduce((sum, rate) => sum + rate, 0) / usdRates.length;
        statistics.minUSDRate = Math.min(...usdRates);
        statistics.maxUSDRate = Math.max(...usdRates);
        statistics.usdVolatility = usdRates.length > 1 ? calculateVolatility(usdRates) : 0;
      }

      res.json({
        success: true,
        data: {
          period,
          sourceAsset,
          destinationAsset,
          rates: rateData,
          statistics,
          lastUpdated: new Date()
        }
      });
    } catch (error) {
      logger.error('Error getting exchange rates:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/conversion-analytics/gains-losses/:userAddress
// Get detailed gains and losses analysis
router.get(
  '/gains-losses/:userAddress',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const { userAddress } = req.params;
      const { 
        taxYear,
        assetCode,
        includeUnrealized = 'true'
      } = req.query;

      // Get cost basis calculation
      const costBasisResult = await costBasisService.calculateCostBasis(
        userAddress, 
        assetCode, 
        'FIFO'
      );

      if (!costBasisResult.success) {
        return res.status(500).json(costBasisResult);
      }

      const { unrealized, realized } = costBasisResult.data;

      // Filter by tax year if specified
      let filteredRealized = realized;
      if (taxYear) {
        const yearStart = new Date(parseInt(taxYear), 0, 1);
        const yearEnd = new Date(parseInt(taxYear) + 1, 0, 1);
        
        filteredRealized = {
          ...realized,
          totalDisposals: realized.totalDisposals,
          shortTermGains: 0,
          longTermGains: 0,
          totalRealizedGain: 0,
          totalRealizedLoss: 0
        };
      }

      res.json({
        success: true,
        data: {
          userAddress,
          assetCode,
          taxYear: taxYear || null,
          unrealized,
          realized: filteredRealized,
          summary: {
            totalUnrealizedGain: parseFloat(unrealized.unrealizedGain || 0),
            totalUnrealizedLoss: parseFloat(unrealized.unrealizedLoss || 0),
            totalRealizedGain: realized.totalRealizedGain,
            totalRealizedLoss: realized.totalRealizedLoss,
            netGain: parseFloat(unrealized.unrealizedGain || 0) + realized.totalRealizedGain - realized.totalRealizedLoss,
            taxLossHarvestingOpportunity: this.calculateTaxLossHarvestingOpportunity(unrealized, realized)
          }
        }
      });
    } catch (error) {
      logger.error('Error calculating gains and losses:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/conversion-analytics/performance-metrics/:userAddress
// Get performance metrics and analytics
router.get(
  '/performance-metrics/:userAddress',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const { userAddress } = req.params;
      const { period = '90d' } = req.query;

      // Calculate period start date
      const endDate = new Date();
      let startDate = new Date();
      
      switch (period) {
        case '30d':
          startDate.setDate(startDate.getDate() - 30);
          break;
        case '90d':
          startDate.setDate(startDate.getDate() - 90);
          break;
        case '1y':
          startDate.setFullYear(startDate.getFullYear() - 1);
          break;
        default:
          startDate.setDate(startDate.getDate() - 90);
      }

      // Get conversion events in period
      const conversions = await ConversionEvent.findAll({
        where: {
          user_address: userAddress,
          transaction_timestamp: {
            [Op.gte]: startDate,
            [Op.lte]: endDate
          }
        },
        order: [['transaction_timestamp', 'ASC']]
      });

      // Calculate performance metrics
      const metrics = calculatePerformanceMetrics(conversions, startDate, endDate);

      res.json({
        success: true,
        data: {
          userAddress,
          period,
          dateRange: { startDate, endDate },
          metrics,
          lastUpdated: new Date()
        }
      });
    } catch (error) {
      logger.error('Error calculating performance metrics:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// Helper functions

/**
 * Calculate volatility from array of rates
 * @param {Array} rates - Array of exchange rates
 * @returns {number} Volatility (standard deviation)
 */
function calculateVolatility(rates) {
  if (rates.length < 2) return 0;
  
  const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  const variance = rates.reduce((sum, rate) => sum + Math.pow(rate - mean, 2), 0) / rates.length;
  return Math.sqrt(variance);
}

/**
 * Calculate performance metrics from conversion events
 * @param {Array} conversions - Conversion events
 * @param {Date} startDate - Start date
 * @param {Date} endDate - End date
 * @returns {Object} Performance metrics
 */
function calculatePerformanceMetrics(conversions, startDate, endDate) {
  const totalConversions = conversions.length;
  const totalVolume = conversions.reduce((sum, conv) => 
    sum + parseFloat(conv.destination_amount || conv.source_amount), 0
  );

  // Separate acquisitions and disposals
  const acquisitions = conversions.filter(c => c.destination_asset_code !== null);
  const disposals = conversions.filter(c => c.source_asset_code !== null);

  // Calculate average exchange rates
  const exchangeRates = conversions.map(c => parseFloat(c.exchange_rate)).filter(rate => !isNaN(rate));
  const avgExchangeRate = exchangeRates.length > 0 ? 
    exchangeRates.reduce((sum, rate) => sum + rate, 0) / exchangeRates.length : 0;

  // Calculate best and worst trades
  const gains = disposals.map(d => {
    const proceeds = parseFloat(d.destination_amount);
    const cost = parseFloat(d.source_amount) * avgExchangeRate;
    return proceeds - cost;
  });

  const bestTrade = gains.length > 0 ? Math.max(...gains) : 0;
  const worstTrade = gains.length > 0 ? Math.min(...gains) : 0;

  // Calculate data quality distribution
  const qualityDistribution = conversions.reduce((dist, conv) => {
    dist[conv.data_quality] = (dist[conv.data_quality] || 0) + 1;
    return dist;
  }, {});

  return {
    totalConversions,
    totalVolume,
    averageExchangeRate,
    bestTrade,
    worstTrade,
    totalGains: gains.reduce((sum, gain) => sum + (gain > 0 ? gain : 0), 0),
    totalLosses: Math.abs(gains.reduce((sum, gain) => sum + (gain < 0 ? gain : 0), 0)),
    dataQuality: qualityDistribution,
    conversionFrequency: totalConversions / Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)), // Conversions per day
    avgSlippage: conversions.reduce((sum, conv) => sum + parseFloat(conv.slippage_percentage || 0), 0) / conversions.length
  };
}

/**
 * Calculate tax loss harvesting opportunity
 * @param {Object} unrealized - Unrealized gains/losses
 * @param {Object} realized - Realized gains/losses
 * @returns {Object} Tax loss harvesting opportunity
 */
function calculateTaxLossHarvestingOpportunity(unrealized, realized) {
  const unrealizedLosses = parseFloat(unrealized.unrealizedLoss || 0);
  const realizedLosses = realized.totalRealizedLoss;
  
  // Opportunity to harvest more losses before year end
  const remainingLosses = unrealizedLosses - realizedLosses;
  
  return {
    availableLosses: unrealizedLosses,
    harvestedLosses: realizedLosses,
    remainingLosses,
    recommendation: remainingLosses > 1000 ? 'Consider harvesting additional losses before year end' : 'Loss harvesting on track'
  };
}

module.exports = router;
