const express = require('express');
const router = express.Router();
const shadowIndexingService = require('../services/shadowIndexingService');
const Sentry = require('@sentry/node');
const logger = require('../utils/logger');

// Middleware for error handling
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/**
 * @swagger
 * components:
 *   schemas:
 *     ShadowIndexingStatus:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Service name
 *         currentIndex:
 *           type: number
 *           description: Current ledger index
 *         processedLedgersCount:
 *           type: number
 *           description: Number of processed ledgers
 *         processedTransactionsCount:
 *           type: number
 *           description: Number of processed transactions
 *         isIndexing:
 *           type: boolean
 *           description: Whether indexing is active
 *         isEnabled:
 *           type: boolean
 *           description: Whether shadow-indexing is enabled
 *         totalLedgersProcessed:
 *           type: number
 *           description: Total ledgers processed
 *         totalTransactionsProcessed:
 *           type: number
 *           description: Total transactions processed
 *         inconsistenciesDetected:
 *           type: number
 *           description: Number of inconsistencies detected
 *         consistencyRate:
 *           type: string
 *           description: Current consistency rate percentage
 *         lastSyncTime:
 *           type: string
 *           description: Last sync timestamp
 *         validationCount:
 *           type: number
 *           description: Number of validations performed
 *         criticalIssues:
 *           type: number
 *           description: Number of critical issues
 *         warningIssues:
 *           type: number
 *           description: Number of warning issues
 */

/**
 * @swagger
 * /shadow-indexing/status:
 *   get:
 *     summary: Get shadow-indexing service status
 *     tags: [Shadow Indexing]
 *     responses:
 *       200:
 *         description: Shadow-indexing service status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/ShadowIndexingStatus'
 */
router.get('/status', asyncHandler(async (req, res) => {
  try {
    const stats = shadowIndexingService.getStats();
    const consistencyRate = shadowIndexingService.getConsistencyRate();
    
    const status = {
      ...stats,
      consistencyRate
    };
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error('Error getting shadow-indexing status:', error);
    Sentry.captureException(error);
    res.status(500).json({
      success: false,
      error: 'Failed to get shadow-indexing status'
    });
  }
}));

/**
 * @swagger
 * /shadow-indexing/start:
 *   post:
 *     summary: Start shadow-indexing service
 *     tags: [Shadow Indexing]
 *     responses:
 *       200:
 *         description: Shadow-indexing service started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 */
router.post('/start', asyncHandler(async (req, res) => {
  try {
    await shadowIndexingService.start();
    
    res.json({
      success: true,
      message: 'Shadow-indexing service started successfully'
    });
  } catch (error) {
    logger.error('Error starting shadow-indexing service:', error);
    Sentry.captureException(error);
    res.status(500).json({
      success: false,
      error: 'Failed to start shadow-indexing service'
    });
  }
}));

/**
 * @swagger
 * /shadow-indexing/stop:
 *   post:
 *     summary: Stop shadow-indexing service
 *     tags: [Shadow Indexing]
 *     responses:
 *       200:
 *         description: Shadow-indexing service stopped
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 */
router.post('/stop', asyncHandler(async (req, res) => {
  try {
    await shadowIndexingService.stop();
    
    res.json({
      success: true,
      message: 'Shadow-indexing service stopped successfully'
    });
  } catch (error) {
    logger.error('Error stopping shadow-indexing service:', error);
    Sentry.captureException(error);
    res.status(500).json({
      success: false,
      error: 'Failed to stop shadow-indexing service'
    });
  }
}));

/**
 * @swagger
 * /shadow-indexing/reset:
 *   post:
 *     summary: Reset shadow-indexing service
 *     tags: [Shadow Indexing]
 *     responses:
 *       200:
 *         description: Shadow-indexing service reset
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 */
router.post('/reset', asyncHandler(async (req, res) => {
  try {
    shadowIndexingService.reset();
    
    res.json({
      success: true,
      message: 'Shadow-indexing service reset successfully'
    });
  } catch (error) {
    logger.error('Error resetting shadow-indexing service:', error);
    Sentry.captureException(error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset shadow-indexing service'
    });
  }
}));

/**
 * @swagger
 * /shadow-indexing/consistency-check:
 *   post:
 *     summary: Trigger manual consistency check
 *     tags: [Shadow Indexing]
 *     responses:
 *       200:
 *         description: Consistency check results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     timestamp:
 *                       type: string
 *                     validationDuration:
 *                       type: number
 *                     totalLedgers:
 *                       type: number
 *                     totalInconsistencies:
 *                       type: number
 *                     criticalIssues:
 *                       type: number
 *                     warningIssues:
 *                       type: number
 *                     validationPassed:
 *                       type: boolean
 */
router.post('/consistency-check', asyncHandler(async (req, res) => {
  try {
    const result = await shadowIndexingService.performConsistencyCheck();
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Error performing consistency check:', error);
    Sentry.captureException(error);
    res.status(500).json({
      success: false,
      error: 'Failed to perform consistency check'
    });
  }
}));

/**
 * @swagger
 * /shadow-indexing/ledgers:
 *   get:
 *     summary: Get processed ledgers
 *     tags: [Shadow Indexing]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of ledgers to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of ledgers to skip
 *     responses:
 *       200:
 *         description: Processed ledgers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     ledgers:
 *                       type: array
 *                       items:
 *                         type: object
 *                     total:
 *                       type: number
 */
router.get('/ledgers', asyncHandler(async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const offset = parseInt(req.query.offset) || 0;
    
    const processedLedgers = shadowIndexingService.getProcessedLedgers();
    const ledgersArray = Array.from(processedLedgers.values())
      .sort((a, b) => b.sequence - a.sequence)
      .slice(offset, offset + limit);
    
    res.json({
      success: true,
      data: {
        ledgers: ledgersArray,
        total: processedLedgers.size,
        limit,
        offset
      }
    });
  } catch (error) {
    logger.error('Error getting processed ledgers:', error);
    Sentry.captureException(error);
    res.status(500).json({
      success: false,
      error: 'Failed to get processed ledgers'
    });
  }
}));

/**
 * @swagger
 * /shadow-indexing/config:
 *   get:
 *     summary: Get shadow-indexing configuration
 *     tags: [Shadow Indexing]
 *     responses:
 *       200:
 *         description: Shadow-indexing configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     indexingInterval:
 *                       type: number
 *                     validationInterval:
 *                       type: number
 *                     criticalInconsistencyCount:
 *                       type: number
 *                     warningInconsistencyCount:
 *                       type: number
 *                     failoverThreshold:
 *                       type: number
 *                     autoFailover:
 *                       type: boolean
 */
router.get('/config', asyncHandler(async (req, res) => {
  try {
    const stats = shadowIndexingService.getStats();
    
    res.json({
      success: true,
      data: stats.config
    });
  } catch (error) {
    logger.error('Error getting shadow-indexing config:', error);
    Sentry.captureException(error);
    res.status(500).json({
      success: false,
      error: 'Failed to get shadow-indexing config'
    });
  }
}));

/**
 * @swagger
 * /shadow-indexing/health:
 *   get:
 *     summary: Get shadow-indexing health check
 *     tags: [Shadow Indexing]
 *     responses:
 *       200:
 *         description: Shadow-indexing health status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [healthy, warning, critical]
 *                     consistencyRate:
 *                       type: string
 *                     lastSyncTime:
 *                       type: string
 *                     isIndexing:
 *                       type: boolean
 *                     issues:
 *                       type: array
 *                       items:
 *                         type: string
 */
router.get('/health', asyncHandler(async (req, res) => {
  try {
    const stats = shadowIndexingService.getStats();
    const consistencyRate = parseFloat(shadowIndexingService.getConsistencyRate());
    
    let status = 'healthy';
    const issues = [];
    
    if (consistencyRate < 95) {
      status = 'critical';
      issues.push('Low consistency rate');
    } else if (consistencyRate < 99) {
      status = 'warning';
      issues.push('Moderate consistency rate');
    }
    
    if (!stats.isIndexing && stats.isEnabled) {
      status = 'critical';
      issues.push('Indexing not active');
    }
    
    if (stats.criticalIssues > 0) {
      status = 'critical';
      issues.push(`${stats.criticalIssues} critical issues detected`);
    }
    
    const healthData = {
      status,
      consistencyRate: shadowIndexingService.getConsistencyRate(),
      lastSyncTime: stats.lastSyncTime,
      isIndexing: stats.isIndexing,
      isEnabled: stats.isEnabled,
      issues
    };
    
    res.json({
      success: true,
      data: healthData
    });
  } catch (error) {
    logger.error('Error getting shadow-indexing health:', error);
    Sentry.captureException(error);
    res.status(500).json({
      success: false,
      error: 'Failed to get shadow-indexing health'
    });
  }
}));

// Error handling middleware
router.use((error, req, res, next) => {
  logger.error('Shadow-indexing route error:', error);
  Sentry.captureException(error);
  
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

module.exports = router;
