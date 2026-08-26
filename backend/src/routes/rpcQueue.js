const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

/**
 * Get RPC queue service status and statistics
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

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    const stats = await rpcQueueService.getStats();
    const healthCheck = await rpcQueueService.healthCheck();

    res.json({
      success: true,
      data: {
        stats,
        health: healthCheck
      }
    });

  } catch (error) {
    logger.error('Error fetching RPC queue status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch RPC queue status'
    });
  }
});

/**
 * Get Dead Letter Queue jobs
 */
router.get('/dlq/jobs', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const { limit = 50 } = req.query;
    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    const dlqJobs = await rpcQueueService.getDlqJobs(parseInt(limit));

    res.json({
      success: true,
      data: {
        jobs: dlqJobs,
        limit: parseInt(limit),
        total: dlqJobs.length
      }
    });

  } catch (error) {
    logger.error('Error fetching DLQ jobs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch DLQ jobs'
    });
  }
});

/**
 * Retry a job from Dead Letter Queue
 */
router.post('/dlq/:jobId/retry', async (req, res) => {
  try {
    const { jobId } = req.params;
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    const retriedJob = await rpcQueueService.retryDlqJob(jobId);

    res.json({
      success: true,
      message: `DLQ job ${jobId} retried successfully`,
      data: {
        originalJobId: jobId,
        newJobId: retriedJob.id,
        newJobName: retriedJob.name
      }
    });

  } catch (error) {
    logger.error(`Error retrying DLQ job ${req.params.jobId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to retry DLQ job'
    });
  }
});

/**
 * Delete a job from Dead Letter Queue
 */
router.delete('/dlq/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    const deleted = await rpcQueueService.deleteDlqJob(jobId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'DLQ job not found'
      });
    }

    res.json({
      success: true,
      message: `DLQ job ${jobId} deleted successfully`
    });

  } catch (error) {
    logger.error(`Error deleting DLQ job ${req.params.jobId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete DLQ job'
    });
  }
});

/**
 * Clear Dead Letter Queue
 */
router.post('/dlq/clear', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    await rpcQueueService.clearDlq();

    res.json({
      success: true,
      message: 'Dead Letter Queue cleared successfully'
    });

  } catch (error) {
    logger.error('Error clearing DLQ:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear Dead Letter Queue'
    });
  }
});

/**
 * Pause RPC queues
 */
router.post('/queues/pause', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    await rpcQueueService.pauseQueues();

    res.json({
      success: true,
      message: 'RPC queues paused successfully'
    });

  } catch (error) {
    logger.error('Error pausing RPC queues:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to pause RPC queues'
    });
  }
});

/**
 * Resume RPC queues
 */
router.post('/queues/resume', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    await rpcQueueService.resumeQueues();

    res.json({
      success: true,
      message: 'RPC queues resumed successfully'
    });

  } catch (error) {
    logger.error('Error resuming RPC queues:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resume RPC queues'
    });
  }
});

/**
 * Add RPC job to queue (for testing/manual operations)
 */
router.post('/jobs', async (req, res) => {
  try {
    const { method, params, options = {} } = req.body;

    if (!method) {
      return res.status(400).json({
        success: false,
        error: 'RPC method is required'
      });
    }

    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    const job = await rpcQueueService.addRpcJob(method, params, {
      priority: options.priority || 'normal',
      source: 'manual-api',
      timeout: options.timeout || 15000
    });

    res.json({
      success: true,
      message: 'RPC job added successfully',
      data: {
        jobId: job.id,
        method,
        priority: options.priority || 'normal'
      }
    });

  } catch (error) {
    logger.error('Error adding RPC job:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add RPC job'
    });
  }
});

/**
 * Get RPC queue configuration
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

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    const stats = await rpcQueueService.getStats();

    res.json({
      success: true,
      data: {
        maxRetries: rpcQueueService.maxRetries,
        retryDelay: rpcQueueService.retryDelay,
        dlqMaxSize: rpcQueueService.dlqMaxSize,
        priorityThreshold: rpcQueueService.priorityThreshold,
        queueNames: rpcQueueService.QUEUE_NAMES,
        isStarted: rpcQueueService.isStarted,
        redisStatus: stats.service.redisStatus
      }
    });

  } catch (error) {
    logger.error('Error fetching RPC queue config:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch RPC queue configuration'
    });
  }
});

/**
 * Reset RPC queue statistics
 */
router.post('/stats/reset', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    rpcQueueService.resetStats();

    res.json({
      success: true,
      message: 'RPC queue statistics reset successfully'
    });

  } catch (error) {
    logger.error('Error resetting RPC queue stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset RPC queue statistics'
    });
  }
});

/**
 * Health check for RPC queue service
 */
router.get('/health', async (req, res) => {
  try {
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    const health = await rpcQueueService.healthCheck();

    const statusCode = health.status === 'healthy' ? 200 : 503;
    
    res.status(statusCode).json({
      success: health.status === 'healthy',
      data: health
    });

  } catch (error) {
    logger.error('Error checking RPC queue health:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check RPC queue health',
      data: {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      }
    });
  }
});

/**
 * Get queue-specific statistics
 */
router.get('/queues/:queueName/stats', async (req, res) => {
  try {
    const { queueName } = req.params;
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    const queueStats = await rpcQueueService.queueService.getQueueStats(queueName);

    res.json({
      success: true,
      data: queueStats
    });

  } catch (error) {
    logger.error(`Error fetching stats for queue ${req.params.queueName}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch queue statistics'
    });
  }
});

/**
 * Get failed jobs from specific queue
 */
router.get('/queues/:queueName/failed', async (req, res) => {
  try {
    const { queueName } = req.params;
    const { limit = 50 } = req.query;
    const sorobanEventPoller = global.sorobanEventPoller;
    
    if (!sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Soroban Event Poller service not available'
      });
    }

    const rpcQueueService = sorobanEventPoller.getRpcQueueService();
    const failedJobs = await rpcQueueService.queueService.getFailedJobs(queueName, parseInt(limit));

    res.json({
      success: true,
      data: {
        queueName,
        jobs: failedJobs,
        limit: parseInt(limit),
        total: failedJobs.length
      }
    });

  } catch (error) {
    logger.error(`Error fetching failed jobs for queue ${req.params.queueName}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch failed jobs'
    });
  }
});

module.exports = router;
