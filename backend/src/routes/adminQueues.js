const express = require('express');
const router = express.Router();
const backgroundJobManager = require('../workers/backgroundJobManager');
const logger = require('../utils/logger');

/**
 * GET /admin/queues/status
 * Returns queue sizes, active/failed job counts, and dead-letter queue counts
 * for all managed background queues.
 */
router.get('/status', async (req, res) => {
  try {
    const status = await backgroundJobManager.getQueuesStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Error fetching queue status:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch queue status' });
  }
});

/**
 * GET /admin/queues/:queueName/failed
 * List failed jobs for a specific queue.
 */
router.get('/:queueName/failed', async (req, res) => {
  try {
    const { queueName } = req.params;
    const { limit = 50 } = req.query;
    const jobs = await backgroundJobManager.queueService.getFailedJobs(queueName, parseInt(limit, 10));
    res.json({ success: true, data: { queueName, jobs, total: jobs.length } });
  } catch (error) {
    logger.error(`Error fetching failed jobs for ${req.params.queueName}:`, error);
    res.status(500).json({ success: false, error: 'Failed to fetch failed jobs' });
  }
});

/**
 * GET /admin/queues/:queueName/dlq
 * List jobs sitting in a queue's dead-letter queue.
 */
router.get('/:queueName/dlq', async (req, res) => {
  try {
    const { queueName } = req.params;
    const { limit = 50 } = req.query;
    const dlqName = backgroundJobManager.queueService.getDeadLetterQueueName(queueName);
    const dlq = backgroundJobManager.queueService.getQueue(dlqName);
    const jobs = await dlq.getJobs(['waiting', 'active', 'delayed', 'failed'], 0, parseInt(limit, 10) - 1);
    res.json({
      success: true,
      data: {
        queueName: dlqName,
        jobs: jobs.map((j) => ({ id: j.id, name: j.name, data: j.data, timestamp: j.timestamp })),
        total: jobs.length,
      },
    });
  } catch (error) {
    logger.error(`Error fetching DLQ jobs for ${req.params.queueName}:`, error);
    res.status(500).json({ success: false, error: 'Failed to fetch DLQ jobs' });
  }
});

/**
 * POST /admin/queues/:queueName/retry/:jobId
 * Re-enqueue a failed job for another attempt.
 */
router.post('/:queueName/retry/:jobId', async (req, res) => {
  try {
    const { queueName, jobId } = req.params;
    const job = await backgroundJobManager.queueService.retryJob(queueName, jobId);
    res.json({ success: true, message: `Job ${jobId} re-queued`, data: { jobId: job.id } });
  } catch (error) {
    logger.error(`Error retrying job ${req.params.jobId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
