const express = require('express');
const syncHealthCheckService = require('../services/syncHealthCheckService');
const Sentry = require('@sentry/node');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /health/indexer
 * Main sync health check endpoint
 * Returns 200 for healthy, 503 for unhealthy sync status
 */
router.get('/indexer', async (req, res) => {
  try {
    const healthResult = await syncHealthCheckService.performHealthCheck();
    
    // Set appropriate HTTP status code based on health
    res.status(healthResult.httpStatus).json({
      success: healthResult.status === 'healthy',
      data: healthResult
    });
    
  } catch (error) {
    logger.error('Error in health check endpoint:', error);
    
    Sentry.captureException(error, {
      tags: { endpoint: '/health/indexer' },
      extra: { request: req.body }
    });
    
    // Return 503 for any errors in health check
    res.status(503).json({
      success: false,
      error: 'Health check failed',
      message: error.message
    });
  }
});

/**
 * GET /health/indexer/detailed
 * Detailed sync health check with additional metrics
 * Returns comprehensive status for monitoring dashboards
 */
router.get('/indexer/detailed', async (req, res) => {
  try {
    const detailedStatus = await syncHealthCheckService.getDetailedSyncStatus();
    
    res.status(200).json({
      success: true,
      data: detailedStatus
    });
    
  } catch (error) {
    logger.error('Error in detailed health check endpoint:', error);
    
    Sentry.captureException(error, {
      tags: { endpoint: '/health/indexer/detailed' },
      extra: { request: req.body }
    });
    
    res.status(503).json({
      success: false,
      error: 'Detailed health check failed',
      message: error.message
    });
  }
});

/**
 * GET /health/indexer/config
 * Get current health check configuration
 */
router.get('/indexer/config', (req, res) => {
  try {
    const config = syncHealthCheckService.getConfig();
    
    res.status(200).json({
      success: true,
      data: config
    });
    
  } catch (error) {
    logger.error('Error getting health check config:', error);
    
    res.status(500).json({
      success: false,
      error: 'Failed to get configuration',
      message: error.message
    });
  }
});

/**
 * POST /health/indexer/config
 * Update health check configuration
 * Requires admin privileges in production
 */
router.post('/indexer/config', async (req, res) => {
  try {
    const { healthyThreshold, cacheTimeout, stellarRpcUrl } = req.body;
    
    // Validate input
    if (healthyThreshold !== undefined && (typeof healthyThreshold !== 'number' || healthyThreshold < 0)) {
      return res.status(400).json({
        success: false,
        error: 'healthyThreshold must be a non-negative number'
      });
    }
    
    if (cacheTimeout !== undefined && (typeof cacheTimeout !== 'number' || cacheTimeout < 1000)) {
      return res.status(400).json({
        success: false,
        error: 'cacheTimeout must be a number >= 1000ms'
      });
    }
    
    // Update configuration
    syncHealthCheckService.updateConfig({
      healthyThreshold,
      cacheTimeout,
      stellarRpcUrl
    });
    
    // Clear cache to apply new settings immediately
    syncHealthCheckService.clearCache();
    
    const updatedConfig = syncHealthCheckService.getConfig();
    
    res.status(200).json({
      success: true,
      message: 'Configuration updated successfully',
      data: updatedConfig
    });
    
  } catch (error) {
    logger.error('Error updating health check config:', error);
    
    Sentry.captureException(error, {
      tags: { endpoint: '/health/indexer/config' },
      extra: { requestBody: req.body }
    });
    
    res.status(500).json({
      success: false,
      error: 'Failed to update configuration',
      message: error.message
    });
  }
});

/**
 * POST /health/indexer/cache/clear
 * Clear health check cache
 * Useful for forcing fresh health checks
 */
router.post('/indexer/cache/clear', (req, res) => {
  try {
    syncHealthCheckService.clearCache();
    
    res.status(200).json({
      success: true,
      message: 'Health check cache cleared successfully'
    });
    
  } catch (error) {
    logger.error('Error clearing health check cache:', error);
    
    res.status(500).json({
      success: false,
      error: 'Failed to clear cache',
      message: error.message
    });
  }
});

/**
 * GET /health
 * Basic application health check
 * Returns simple status for load balancers and basic monitoring
 */
router.get('/', async (req, res) => {
  try {
    // Basic health check - just check if the service is running
    const uptime = process.uptime();
    const timestamp = new Date().toISOString();
    
    res.status(200).json({
      success: true,
      status: 'healthy',
      timestamp,
      uptime: `${Math.floor(uptime)}s`,
      service: 'vesting-vault-api'
    });
    
  } catch (error) {
    logger.error('Error in basic health check:', error);
    
    res.status(503).json({
      success: false,
      status: 'unhealthy',
      error: error.message
    });
  }
});

module.exports = router;
