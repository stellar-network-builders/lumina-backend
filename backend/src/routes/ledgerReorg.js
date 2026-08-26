const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

/**
 * Get reorg detector and resync service status
 */
router.get('/status', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const reorgDetectorStatus = sorobanEventPoller.getReorgDetector().getStatus();
    const resyncServiceStatus = sorobanEventPoller.getResyncService().getStatus();
    const integrityValidation = await sorobanEventPoller.validateLedgerIntegrity();

    res.json({
      success: true,
      data: {
        reorgDetector: reorgDetectorStatus,
        resyncService: resyncServiceStatus,
        integrityValidation
      }
    });

  } catch (error) {
    logger.error('Error fetching reorg status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch reorg status'
    });
  }
});

/**
 * Trigger manual reorg check
 */
router.post('/check', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const result = await sorobanEventPoller.triggerReorgCheck();

    res.json({
      success: true,
      data: {
        checkId: result.checkId,
        issues: result.issues,
        duration: result.duration,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Error triggering reorg check:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to trigger reorg check'
    });
  }
});

/**
 * Perform full resync from last finalized ledger
 */
router.post('/resync/full', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    // Check if resync is already in progress
    const resyncService = sorobanEventPoller.getResyncService();
    if (resyncService.isResyncing) {
      return res.status(409).json({
        success: false,
        error: 'Resync already in progress',
        data: resyncService.getResyncProgress()
      });
    }

    // Start async resync
    sorobanEventPoller.performFullResync().catch(error => {
      logger.error('Background resync failed:', error);
    });

    res.json({
      success: true,
      message: 'Full resync initiated',
      data: {
        resyncId: resyncService.getResyncProgress()?.resyncId,
        status: 'INITIATED'
      }
    });

  } catch (error) {
    logger.error('Error initiating full resync:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate full resync'
    });
  }
});

/**
 * Perform targeted resync for specific ledger range
 */
router.post('/resync/targeted', async (req, res) => {
  try {
    const { startSequence, endSequence } = req.body;

    if (!startSequence || !endSequence) {
      return res.status(400).json({
        success: false,
        error: 'startSequence and endSequence are required'
      });
    }

    if (startSequence >= endSequence) {
      return res.status(400).json({
        success: false,
        error: 'startSequence must be less than endSequence'
      });
    }

    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    // Check if resync is already in progress
    const resyncService = sorobanEventPoller.getResyncService();
    if (resyncService.isResyncing) {
      return res.status(409).json({
        success: false,
        error: 'Resync already in progress',
        data: resyncService.getResyncProgress()
      });
    }

    // Start async targeted resync
    sorobanEventPoller.performTargetedResync(startSequence, endSequence).catch(error => {
      logger.error('Background targeted resync failed:', error);
    });

    res.json({
      success: true,
      message: `Targeted resync initiated for ledgers ${startSequence}-${endSequence}`,
      data: {
        startSequence,
        endSequence,
        resyncId: resyncService.getResyncProgress()?.resyncId,
        status: 'INITIATED'
      }
    });

  } catch (error) {
    logger.error('Error initiating targeted resync:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to initiate targeted resync'
    });
  }
});

/**
 * Get resync progress
 */
router.get('/resync/progress', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const progress = sorobanEventPoller.getResyncService().getResyncProgress();

    res.json({
      success: true,
      data: progress || { message: 'No resync in progress' }
    });

  } catch (error) {
    logger.error('Error fetching resync progress:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch resync progress'
    });
  }
});

/**
 * Cancel ongoing resync
 */
router.post('/resync/cancel', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const cancelled = await sorobanEventPoller.getResyncService().cancelResync();

    res.json({
      success: true,
      message: cancelled ? 'Resync cancelled' : 'No resync in progress',
      data: { cancelled }
    });

  } catch (error) {
    logger.error('Error cancelling resync:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel resync'
    });
  }
});

/**
 * Validate ledger integrity
 */
router.get('/integrity', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const validation = await sorobanEventPoller.validateLedgerIntegrity();

    res.json({
      success: true,
      data: validation
    });

  } catch (error) {
    logger.error('Error validating ledger integrity:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to validate ledger integrity'
    });
  }
});

/**
 * Get reorg detector configuration
 */
router.get('/config', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const reorgDetector = sorobanEventPoller.getReorgDetector();
    const resyncService = sorobanEventPoller.getResyncService();

    res.json({
      success: true,
      data: {
        reorgDetector: {
          maxReorgDepth: reorgDetector.maxReorgDepth,
          finalityThreshold: reorgDetector.finalityThreshold,
          gapDetectionThreshold: reorgDetector.gapDetectionThreshold,
          checkInterval: reorgDetector.checkInterval
        },
        resyncService: {
          finalityThreshold: resyncService.finalityThreshold,
          resyncBatchSize: resyncService.resyncBatchSize,
          maxResyncDepth: resyncService.maxResyncDepth,
          resyncDelay: resyncService.resyncDelay
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching reorg config:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch reorg configuration'
    });
  }
});

/**
 * Get recent reorg issues
 */
router.get('/issues', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const { limit = 10 } = req.query;
    const issues = await sorobanEventPoller.getReorgDetector().getRecentIssues(parseInt(limit));

    res.json({
      success: true,
      data: {
        issues,
        limit: parseInt(limit)
      }
    });

  } catch (error) {
    logger.error('Error fetching recent issues:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent issues'
    });
  }
});

/**
 * Get ledger hash cache information
 */
router.get('/ledger-cache', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const reorgDetector = sorobanEventPoller.getReorgDetector();
    const cacheInfo = {
      size: reorgDetector.ledgerHashes.size,
      sequences: Array.from(reorgDetector.ledgerHashes.keys()).sort((a, b) => a - b)
    };

    res.json({
      success: true,
      data: cacheInfo
    });

  } catch (error) {
    logger.error('Error fetching ledger cache info:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch ledger cache information'
    });
  }
});

/**
 * Force rollback to specific ledger (admin only)
 */
router.post('/rollback/:sequence', async (req, res) => {
  try {
    const { sequence } = req.params;
    const targetSequence = parseInt(sequence);

    if (isNaN(targetSequence) || targetSequence < 1) {
      return res.status(400).json({
        success: false,
        error: 'Valid ledger sequence is required'
      });
    }

    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    // Perform targeted rollback (resync without re-fetching)
    const resyncService = sorobanEventPoller.getResyncService();
    if (resyncService.isResyncing) {
      return res.status(409).json({
        success: false,
        error: 'Cannot rollback while resync is in progress'
      });
    }

    // Get current state to determine rollback range
    const currentDbState = await resyncService.getCurrentDbState();
    const maxSequence = Math.max(
      currentDbState.maxSorobanEventSequence,
      currentDbState.maxClaimsHistorySequence,
      currentDbState.maxSubScheduleSequence
    );

    if (targetSequence >= maxSequence) {
      return res.status(400).json({
        success: false,
        error: `Target sequence ${targetSequence} is not behind current max ${maxSequence}`
      });
    }

    // Execute rollback
    const rollbackResult = await resyncService.rollbackTargetRange(targetSequence + 1, maxSequence, 'manual_rollback');

    res.json({
      success: true,
      message: `Rollback to ledger ${targetSequence} completed`,
      data: rollbackResult
    });

  } catch (error) {
    logger.error('Error performing manual rollback:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to perform manual rollback'
    });
  }
});

module.exports = router;
