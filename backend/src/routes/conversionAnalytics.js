const express = require('express');
const router = express.Router();
const pathPaymentAnalyticsService = require('../services/pathPaymentAnalyticsService');
const stellarPathPaymentListener = require('../services/stellarPathPaymentListener');
// auth.middleware.js does not export `authMiddleware`; build the user-auth
// middleware from authService (these routes are @access Private).
const authService = require('../services/authService');
const authMiddleware = authService.authenticate();
const { body, param, query, validationResult } = require('express-validator');
const logger = require('../utils/logger');

/**
 * @route GET /api/conversions/user/:userAddress
 * @desc Get conversion events for a user
 * @access Private
 */
router.get('/user/:userAddress', 
  authMiddleware,
  [
    query('startDate').optional().isISO8601().withMessage('Invalid start date format'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date format'),
    query('conversionType').optional().isIn(['claim_and_swap', 'direct_swap', 'arbitrage']),
    query('assetPair').optional().matches(/^[A-Z0-9]+\/[A-Z0-9]+$/).withMessage('Asset pair must be in format SOURCE/DEST'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('orderBy').optional().isIn(['transaction_timestamp', 'source_amount', 'destination_amount', 'exchange_rate']),
    query('orderDirection').optional().isIn(['ASC', 'DESC'])
  ],
  async (req, res) => {
    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array()
        });
      }

      const { userAddress } = req.params;
      const {
        startDate,
        endDate,
        conversionType,
        assetPair,
        limit = 100,
        offset = 0,
        orderBy = 'transaction_timestamp',
        orderDirection = 'DESC'
      } = req.query;

      // Set default date range if not provided
      const start = startDate ? new Date(startDate) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      const end = endDate ? new Date(endDate) : new Date();

      // Get conversion events
      const result = await pathPaymentAnalyticsService.getUserConversionEvents(
        userAddress,
        start,
        end,
        {
          conversionType,
          assetPair,
          limit,
          offset,
          orderBy,
          orderDirection
        }
      );

      res.json({
        success: true,
        data: {
          userAddress,
          period: { start, end },
          events: result.events,
          pagination: {
            total: result.total,
            limit,
            offset,
            hasMore: result.hasMore
          },
          filters: {
            conversionType,
            assetPair
          }
        }
      });

    } catch (error) {
      logger.error('Error fetching user conversion events:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route GET /api/conversions/user/:userAddress/analytics
 * @desc Get analytics summary for a user
 * @access Private
 */
router.get('/user/:userAddress/analytics',
  authMiddleware,
  [
    query('timeRange').optional().isIn(['1H', '24H', '7D', '1M', '3M', '6M', '1Y'])
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array()
        });
      }

      const { userAddress } = req.params;
      const { timeRange = '1Y' } = req.query;

      const analytics = await pathPaymentAnalyticsService.getUserAnalyticsSummary(userAddress, timeRange);

      res.json({
        success: true,
        data: analytics
      });

    } catch (error) {
      logger.error('Error fetching user analytics:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route POST /api/conversions/cost-basis/:userAddress/:taxYear
 * @desc Generate cost basis report for tax year
 * @access Private
 */
router.post('/cost-basis/:userAddress/:taxYear',
  authMiddleware,
  [
    param('taxYear').isInt({ min: 2020, max: new Date().getFullYear() + 1 }).withMessage('Invalid tax year')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array()
        });
      }

      const { userAddress, taxYear } = req.params;
      const taxYearInt = parseInt(taxYear);

      const report = await pathPaymentAnalyticsService.generateCostBasisReport(userAddress, taxYearInt);

      res.json({
        success: true,
        data: report
      });

    } catch (error) {
      logger.error('Error generating cost basis report:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route GET /api/conversions/cost-basis/:userAddress/:taxYear
 * @desc Get existing cost basis report
 * @access Private
 */
router.get('/cost-basis/:userAddress/:taxYear',
  authMiddleware,
  [
    param('taxYear').isInt({ min: 2020, max: new Date().getFullYear() + 1 })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array()
        });
      }

      const { userAddress, taxYear } = req.params;
      const { CostBasisReport } = require('../models');

      const report = await CostBasisReport.findOne({
        where: {
          user_address: userAddress,
          token_address: 'MULTI_CURRENCY',
          report_year: parseInt(taxYear)
        }
      });

      if (!report) {
        return res.status(404).json({
          success: false,
          error: 'Cost basis report not found for the specified tax year'
        });
      }

      res.json({
        success: true,
        data: report
      });

    } catch (error) {
      logger.error('Error fetching cost basis report:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route GET /api/conversions/exchange-rates/:sourceAsset/:destinationAsset
 * @desc Get exchange rate analytics for specific asset pair
 * @access Public
 */
router.get('/exchange-rates/:sourceAsset/:destinationAsset',
  [
    param('sourceAsset').matches(/^[A-Z0-9]+$/).withMessage('Invalid source asset format'),
    param('destinationAsset').matches(/^[A-Z0-9]+$/).withMessage('Invalid destination asset format'),
    query('timeRange').optional().isIn(['1H', '24H', '7D', '1M', '3M', '6M', '1Y']),
    query('sourceIssuer').optional().isAlphanumeric().withMessage('Invalid source issuer'),
    query('destinationIssuer').optional().isAlphanumeric().withMessage('Invalid destination issuer')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array()
        });
      }

      const { sourceAsset, destinationAsset } = req.params;
      const { timeRange = '1M', sourceIssuer, destinationIssuer } = req.query;

      const analytics = await pathPaymentAnalyticsService.getExchangeRateAnalytics(
        { code: sourceAsset, issuer: sourceIssuer },
        { code: destinationAsset, issuer: destinationIssuer },
        timeRange
      );

      res.json({
        success: true,
        data: analytics
      });

    } catch (error) {
      logger.error('Error fetching exchange rate analytics:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route GET /api/conversions/system-stats
 * @desc Get system-wide conversion statistics
 * @access Admin
 */
router.get('/system-stats',
  authMiddleware,
  // Add admin middleware check here
  [
    query('timeRange').optional().isIn(['1H', '24H', '7D', '1M', '3M', '6M', '1Y'])
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array()
        });
      }

      const { timeRange = '24H' } = req.query;

      // Add admin check here - for now, allow all authenticated users
      const stats = await pathPaymentAnalyticsService.getSystemStats(timeRange);

      res.json({
        success: true,
        data: stats
      });

    } catch (error) {
      logger.error('Error fetching system stats:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route GET /api/conversions/listener/status
 * @desc Get status of the path payment listener
 * @access Admin
 */
router.get('/listener/status',
  authMiddleware,
  // Add admin middleware check here
  async (req, res) => {
    try {
      const status = stellarPathPaymentListener.getStatus();

      res.json({
        success: true,
        data: status
      });

    } catch (error) {
      logger.error('Error fetching listener status:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route POST /api/conversions/listener/start
 * @desc Start the path payment listener
 * @access Admin
 */
router.post('/listener/start',
  authMiddleware,
  // Add admin middleware check here
  async (req, res) => {
    try {
      await stellarPathPaymentListener.start();

      res.json({
        success: true,
        message: 'Path payment listener started successfully'
      });

    } catch (error) {
      logger.error('Error starting listener:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to start path payment listener',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route POST /api/conversions/listener/stop
 * @desc Stop the path payment listener
 * @access Admin
 */
router.post('/listener/stop',
  authMiddleware,
  // Add admin middleware check here
  async (req, res) => {
    try {
      await stellarPathPaymentListener.stop();

      res.json({
        success: true,
        message: 'Path payment listener stopped successfully'
      });

    } catch (error) {
      logger.error('Error stopping listener:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to stop path payment listener',
        message: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route GET /api/conversions/health
 * @desc Health check endpoint for the conversion analytics service
 * @access Public
 */
router.get('/health', async (req, res) => {
  try {
    const listenerStatus = stellarPathPaymentListener.getStatus();
    
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      listener: listenerStatus
    });

  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message
    });
  }
});

module.exports = router;
