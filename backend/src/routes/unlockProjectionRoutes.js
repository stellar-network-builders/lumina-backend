const express = require('express');
const router = express.Router();
const unlockProjectionService = require('../services/unlockProjectionService');
const syncHealthCheckService = require('../services/syncHealthCheckService');
const authService = require('../services/authService');
const logger = require('../utils/logger');

/**
 * GET /api/analytics/projections/unlocks
 * Project future token unlocks for a given period
 */
router.get('/unlocks', authService.authenticate(), async (req, res) => {
  try {
    const {
      token_address,
      organization_id,
      start_date,
      end_date,
      group_by
    } = req.query;

    const options = {
      tokenAddress: token_address,
      organizationId: organization_id,
      startDate: start_date ? new Date(start_date) : new Date(),
      endDate: end_date ? new Date(end_date) : undefined,
      groupBy: group_by || 'month'
    };

    // Basic validation
    if (options.startDate && isNaN(options.startDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid start_date' });
    }
    if (options.endDate && isNaN(options.endDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid end_date' });
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
        data: {
          projection: [],
          summary: {
            totalToUnlock: 0,
            period: { startDate: options.startDate, endDate: options.endDate },
            tokenAddress: options.tokenAddress,
            organizationId: options.organizationId,
            generatedAt: new Date()
          }
        },
        metadata: {
          degraded: true,
          reason: 'sync_in_progress',
          syncHealth
        }
      });
    }

    const projection = await unlockProjectionService.projectUnlocks(options);

    res.json({
      success: true,
      data: projection,
      metadata: {
        degraded: false,
        syncHealth
      }
    });
  } catch (error) {
    logger.error('Error in unlock projection route:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
