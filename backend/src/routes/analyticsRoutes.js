const express = require('express');
const router = express.Router();
const analyticsController = require('../services/analyticsController');
const authService = require('../services/authService');
const roiAnalyticsService = require('../services/roiAnalyticsService');
const logger = require('../utils/logger');
const dexOracleService = require('../services/dexOracleService');
const syncHealthCheckService = require('../services/syncHealthCheckService');

// GET /api/org/:id/analytics/top-claimers
router.get(
  '/org/:id/analytics/top-claimers',
  authService.authenticate(true), // Enforce admin access
  analyticsController.getTopClaimers.bind(analyticsController)
);

// ROI Analytics Endpoints

// GET /api/analytics/roi/user/:address
router.get(
  '/roi/user/:address',
  authService.authenticate(),
  async (req, res) => {
    try {
      const { address } = req.params;
      const { include_grants, include_vaults, cache_bust } = req.query;

      const options = {
        include_grants: include_grants !== 'false',
        include_vaults: include_vaults !== 'false'
      };

      if (cache_bust) {
        roiAnalyticsService.clearCache();
      }

      let syncHealth;
      try {
        syncHealth = await syncHealthCheckService.performHealthCheck();
      } catch (error) {
        syncHealth = {
          status: 'unknown',
          httpStatus: 503,
          error: error.message
        };
      }

      const analytics = await roiAnalyticsService.getUserRoiAnalytics(address, {
        ...options,
        allowStaleCache: syncHealth.status !== 'healthy'
      });

      res.json({
        success: true,
        data: analytics,
        metadata: {
          degraded: syncHealth.status !== 'healthy',
          syncHealth
        }
      });
    } catch (error) {
      logger.error('Error getting user ROI analytics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// GET /api/analytics/roi/vault/:address
router.get(
  '/roi/vault/:address',
  authService.authenticate(),
  async (req, res) => {
    try {
      const { address } = req.params;
      const { cache_bust } = req.query;

      if (cache_bust) {
        roiAnalyticsService.clearCache();
      }

      let syncHealth;
      try {
        syncHealth = await syncHealthCheckService.performHealthCheck();
      } catch (error) {
        syncHealth = {
          status: 'unknown',
          httpStatus: 503,
          error: error.message
        };
      }

      if (syncHealth.status !== 'healthy') {
        return res.json({
          success: true,
          data: null,
          metadata: {
            degraded: true,
            reason: 'sync_in_progress',
            syncHealth
          }
        });
      }

      const analytics = await roiAnalyticsService.getVaultRoiAnalytics(address);

      res.json({
        success: true,
        data: analytics,
        metadata: {
          degraded: false,
          syncHealth
        }
      });
    } catch (error) {
      logger.error('Error getting vault ROI analytics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// GET /api/analytics/roi/grant/:address
router.get(
  '/roi/grant/:address',
  authService.authenticate(),
  async (req, res) => {
    try {
      const { address } = req.params;
      const { cache_bust } = req.query;

      if (cache_bust) {
        roiAnalyticsService.clearCache();
      }

      let syncHealth;
      try {
        syncHealth = await syncHealthCheckService.performHealthCheck();
      } catch (error) {
        syncHealth = {
          status: 'unknown',
          httpStatus: 503,
          error: error.message
        };
      }

      if (syncHealth.status !== 'healthy') {
        return res.json({
          success: true,
          data: null,
          metadata: {
            degraded: true,
            reason: 'sync_in_progress',
            syncHealth
          }
        });
      }

      const analytics = await roiAnalyticsService.getGrantStreamRoiAnalytics(address);

      res.json({
        success: true,
        data: analytics,
        metadata: {
          degraded: false,
          syncHealth
        }
      });
    } catch (error) {
      logger.error('Error getting grant ROI analytics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// GET /api/analytics/roi/batch
router.post(
  '/roi/batch',
  authService.authenticate(),
  async (req, res) => {
    try {
      const { user_addresses } = req.body;

      if (!Array.isArray(user_addresses) || user_addresses.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'user_addresses must be a non-empty array'
        });
      }

      if (user_addresses.length > 50) {
        return res.status(400).json({
          success: false,
          error: 'Maximum 50 addresses allowed per batch request'
        });
      }

      const analytics = await roiAnalyticsService.getBatchUserRoiAnalytics(user_addresses);

      res.json({
        success: true,
        data: analytics
      });
    } catch (error) {
      logger.error('Error getting batch ROI analytics:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// GET /api/analytics/market/overview
router.get(
  '/market/overview',
  authService.authenticate(),
  async (req, res) => {
    try {
      const overview = await roiAnalyticsService.getMarketOverview();

      res.json({
        success: true,
        data: overview
      });
    } catch (error) {
      logger.error('Error getting market overview:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// DEX Oracle Endpoints

// GET /api/analytics/oracle/price/:tokenAddress
router.get(
  '/oracle/price/:tokenAddress',
  authService.authenticate(),
  async (req, res) => {
    try {
      const { tokenAddress } = req.params;
      const { sources, min_confidence, cache_bust } = req.query;

      const options = {};
      if (sources) {
        options.sources = sources.split(',');
      }
      if (min_confidence) {
        options.minConfidence = parseFloat(min_confidence);
      }

      if (cache_bust) {
        dexOracleService.clearCache();
      }

      const priceData = await dexOracleService.getCurrentPrice(tokenAddress, options);

      res.json({
        success: true,
        data: priceData
      });
    } catch (error) {
      logger.error('Error getting oracle price:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// GET /api/analytics/oracle/historical/:tokenAddress
router.get(
  '/oracle/historical/:tokenAddress',
  authService.authenticate(),
  async (req, res) => {
    try {
      const { tokenAddress } = req.params;
      const { date, sources, min_confidence } = req.query;

      if (!date) {
        return res.status(400).json({
          success: false,
          error: 'date parameter is required (YYYY-MM-DD format)'
        });
      }

      const historicalDate = new Date(date);
      if (isNaN(historicalDate.getTime())) {
        return res.status(400).json({
          success: false,
          error: 'Invalid date format. Use YYYY-MM-DD'
        });
      }

      const options = {};
      if (sources) {
        options.sources = sources.split(',');
      }
      if (min_confidence) {
        options.minConfidence = parseFloat(min_confidence);
      }

      const priceData = await dexOracleService.getHistoricalPrice(tokenAddress, historicalDate, options);

      res.json({
        success: true,
        data: priceData
      });
    } catch (error) {
      logger.error('Error getting historical oracle price:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// GET /api/analytics/oracle/health
router.get(
  '/oracle/health',
  authService.authenticate(true), // Admin only
  async (req, res) => {
    try {
      const health = await dexOracleService.getOracleHealth();

      res.json({
        success: true,
        data: health
      });
    } catch (error) {
      logger.error('Error getting oracle health:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// GET /api/analytics/oracle/sources
router.get(
  '/oracle/sources',
  authService.authenticate(),
  async (req, res) => {
    try {
      const sources = dexOracleService.getSupportedSources();

      res.json({
        success: true,
        data: {
          supported_sources: sources
        }
      });
    } catch (error) {
      logger.error('Error getting supported sources:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

// Utility Endpoints

// POST /api/analytics/cache/clear
router.post(
  '/cache/clear',
  authService.authenticate(true), // Admin only
  async (req, res) => {
    try {
      const { service } = req.body;

      if (service === 'roi' || !service) {
        roiAnalyticsService.clearCache();
      }

      if (service === 'oracle' || !service) {
        dexOracleService.clearCache();
      }

      res.json({
        success: true,
        message: 'Cache cleared successfully'
      });
    } catch (error) {
      logger.error('Error clearing cache:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

module.exports = router;