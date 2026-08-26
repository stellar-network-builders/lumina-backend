const logger = require('../utils/logger');
const QueueService = require('./queueService');
const SorobanRpcClient = require('./sorobanRpcClient');
const Sentry = require('@sentry/node');

class RpcQueueService {
  constructor(options = {}) {
    this.queueService = new QueueService(options);
    this.rpcClients = new Map();
    this.isStarted = false;
    
    // Queue names
    this.QUEUE_NAMES = {
      RPC_FETCH: 'rpc-fetch',
      DEAD_LETTER: 'rpc-dead-letter',
      PRIORITY_RPC: 'priority-rpc-fetch'
    };

    // Configuration
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 2000;
    this.dlqMaxSize = options.dlqMaxSize || 1000;
    this.priorityThreshold = options.priorityThreshold || 10;
    
    // Statistics
    this.stats = {
      totalJobs: 0,
      successfulJobs: 0,
      failedJobs: 0,
      dlqJobs: 0,
      retriedJobs: 0
    };
  }

  /**
   * Start the RPC queue service
   */
  async start() {
    if (this.isStarted) {
      logger.warn('RpcQueueService is already started');
      return;
    }

    try {
      logger.info('Starting RPC Queue Service...');
      
      // Connect to Redis
      await this.queueService.connect();
      
      // Setup queues
      await this.setupQueues();
      
      // Setup workers
      await this.setupWorkers();
      
      this.isStarted = true;
      logger.info('RPC Queue Service started successfully');
      
    } catch (error) {
      logger.error('Failed to start RPC Queue Service:', error);
      Sentry.captureException(error, {
        tags: { service: 'rpc-queue-service', operation: 'start' }
      });
      throw error;
    }
  }

  /**
   * Stop the RPC queue service
   */
  async stop() {
    if (!this.isStarted) {
      logger.warn('RpcQueueService is not started');
      return;
    }

    try {
      logger.info('Stopping RPC Queue Service...');
      
      // Disconnect from Redis
      await this.queueService.disconnect();
      
      this.isStarted = false;
      logger.info('RPC Queue Service stopped successfully');
      
    } catch (error) {
      logger.error('Error stopping RPC Queue Service:', error);
      throw error;
    }
  }

  /**
   * Setup BullMQ queues
   */
  async setupQueues() {
    // Main RPC fetch queue
    this.rpcFetchQueue = this.queueService.getQueue(this.QUEUE_NAMES.RPC_FETCH, {
      defaultJobOptions: {
        attempts: this.maxRetries,
        backoff: {
          type: 'exponential',
          delay: this.retryDelay,
        },
        removeOnComplete: 100,
        removeOnFail: 50,
      }
    });

    // Dead Letter Queue
    this.deadLetterQueue = this.queueService.getQueue(this.QUEUE_NAMES.DEAD_LETTER, {
      defaultJobOptions: {
        attempts: 1, // No retries in DLQ
        removeOnComplete: 50,
        removeOnFail: 10,
      }
    });

    // Priority RPC queue for high-priority requests
    this.priorityRpcQueue = this.queueService.getQueue(this.QUEUE_NAMES.PRIORITY_RPC, {
      defaultJobOptions: {
        priority: 10, // High priority
        attempts: this.maxRetries + 1, // Extra retry for priority jobs
        backoff: {
          type: 'exponential',
          delay: this.retryDelay / 2, // Faster retry for priority jobs
        },
        removeOnComplete: 50,
        removeOnFail: 25,
      }
    });

    logger.info('RPC queues setup completed');
  }

  /**
   * Setup BullMQ workers
   */
  async setupWorkers() {
    // RPC fetch worker
    this.rpcFetchWorker = this.queueService.getWorker(
      this.QUEUE_NAMES.RPC_FETCH,
      this.processRpcJob.bind(this),
      {
        concurrency: 5,
        limiter: {
          max: 100,
          duration: 60000, // 100 jobs per minute
        }
      }
    );

    // Priority RPC worker
    this.priorityRpcWorker = this.queueService.getWorker(
      this.QUEUE_NAMES.PRIORITY_RPC,
      this.processRpcJob.bind(this),
      {
        concurrency: 2,
        limiter: {
          max: 20,
          duration: 60000, // 20 jobs per minute for priority
        }
      }
    );

    // Dead Letter Queue worker (for monitoring and alerting)
    this.dlqWorker = this.queueService.getWorker(
      this.QUEUE_NAMES.DEAD_LETTER,
      this.processDlqJob.bind(this),
      {
        concurrency: 1
      }
    );

    logger.info('RPC workers setup completed');
  }

  /**
   * Get or create RPC client instance
   * @param {string} rpcUrl - RPC endpoint URL
   * @returns {SorobanRpcClient} RPC client instance
   */
  getRpcClient(rpcUrl) {
    if (!this.rpcClients.has(rpcUrl)) {
      const client = new SorobanRpcClient(rpcUrl, {
        timeout: 15000,
        maxRetries: 1, // Let queue handle retries
        retryDelay: 0
      });
      this.rpcClients.set(rpcUrl, client);
    }
    return this.rpcClients.get(rpcUrl);
  }

  /**
   * Add RPC job to queue
   * @param {string} method - RPC method name
   * @param {Object} params - RPC parameters
   * @param {Object} options - Job options
   * @returns {Promise<Job>} BullMQ job
   */
  async addRpcJob(method, params = {}, options = {}) {
    if (!this.isStarted) {
      throw new Error('RpcQueueService is not started');
    }

    const jobData = {
      method,
      params,
      rpcUrl: options.rpcUrl || process.env.SOROBAN_RPC_URL || process.env.STELLAR_RPC_URL,
      timestamp: Date.now(),
      jobId: options.jobId || `${method}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      metadata: {
        source: options.source || 'unknown',
        priority: options.priority || 'normal',
        timeout: options.timeout || 15000
      }
    };

    // Determine queue based on priority
    const queueName = options.priority === 'high' ? this.QUEUE_NAMES.PRIORITY_RPC : this.QUEUE_NAMES.RPC_FETCH;
    const queue = queueName === this.QUEUE_NAMES.PRIORITY_RPC ? this.priorityRpcQueue : this.rpcFetchQueue;

    try {
      const job = await this.queueService.addJob(queueName, method, jobData, {
        priority: options.priority === 'high' ? 10 : 0,
        delay: options.delay || 0,
        attempts: options.attempts || this.maxRetries,
        removeOnComplete: options.removeOnComplete || 100,
        removeOnFail: options.removeOnFail || 50
      });

      this.stats.totalJobs++;
      logger.info(`Added RPC job ${job.id} (${method}) to ${queueName} queue`);
      return job;
    } catch (error) {
      logger.error(`Failed to add RPC job to queue:`, error);
      Sentry.captureException(error, {
        tags: { service: 'rpc-queue-service', operation: 'add-job' },
        extra: { method, params, options }
      });
      throw error;
    }
  }

  /**
   * Process RPC job
   * @param {Object} job - BullMQ job
   * @returns {Promise<Object>} RPC response
   */
  async processRpcJob(job) {
    const { method, params, rpcUrl, jobId, metadata } = job.data;
    const startTime = Date.now();

    try {
      logger.info(`Processing RPC job ${job.id} (${method})`);
      
      // Get RPC client
      const rpcClient = this.getRpcClient(rpcUrl);
      
      // Execute RPC call
      const result = await rpcClient.call(method, params, {
        timeout: metadata.timeout
      });

      const duration = Date.now() - startTime;
      this.stats.successfulJobs++;
      
      logger.info(`RPC job ${job.id} completed in ${duration}ms`);
      
      return {
        success: true,
        result,
        metadata: {
          jobId,
          method,
          duration,
          timestamp: Date.now()
        }
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      const attemptsMade = job.attemptsMade + 1;
      
      logger.error(`RPC job ${job.id} failed (attempt ${attemptsMade}):`, error.message);
      
      // Check if this is the final failure
      if (attemptsMade >= this.maxRetries) {
        // Move to Dead Letter Queue
        await this.moveToDlq(job, error, attemptsMade, duration);
        this.stats.failedJobs++;
        this.stats.dlqJobs++;
      } else {
        // Will be retried automatically by BullMQ
        this.stats.retriedJobs++;
      }

      throw error; // Re-throw to trigger BullMQ retry logic
    }
  }

  /**
   * Move failed job to Dead Letter Queue
   * @param {Object} job - Failed job
   * @param {Error} error - Error that caused failure
   * @param {number} attemptsMade - Number of attempts made
   * @param {number} duration - Job duration in ms
   */
  async moveToDlq(job, error, attemptsMade, duration) {
    try {
      const dlqJobData = {
        originalJobId: job.id,
        originalJobName: job.name,
        method: job.data.method,
        params: job.data.params,
        rpcUrl: job.data.rpcUrl,
        error: {
          message: error.message,
          stack: error.stack,
          code: error.code
        },
        attemptsMade,
        duration,
        timestamp: Date.now(),
        originalTimestamp: job.data.timestamp,
        metadata: job.data.metadata
      };

      // Add to Dead Letter Queue
      await this.queueService.addJob(
        this.QUEUE_NAMES.DEAD_LETTER,
        `dlq_${job.data.method}`,
        dlqJobData,
        {
          priority: 5, // Medium priority for DLQ jobs
          removeOnComplete: 25,
          removeOnFail: 10
        }
      );

      logger.info(`Moved failed RPC job ${job.id} to Dead Letter Queue`);
      
      // Send alert for critical failures
      await this.sendDlqAlert(dlqJobData);
      
    } catch (dlqError) {
      logger.error('Failed to move job to Dead Letter Queue:', dlqError);
      Sentry.captureException(dlqError, {
        tags: { service: 'rpc-queue-service', operation: 'move-to-dlq' },
        extra: { originalJobId: job.id, error: error.message }
      });
    }
  }

  /**
   * Process Dead Letter Queue job
   * @param {Object} job - DLQ job
   * @returns {Promise<Object>} Processing result
   */
  async processDlqJob(job) {
    const { originalJobId, method, error, attemptsMade, metadata } = job.data;
    
    try {
      logger.info(`Processing DLQ job for failed RPC call ${originalJobId} (${method})`);
      
      // Log to monitoring systems
      await this.logDlqEvent(job.data);
      
      // Update statistics
      this.stats.dlqJobs++;
      
      return {
        success: true,
        action: 'logged',
        metadata: {
          originalJobId,
          method,
          error: error.message,
          attemptsMade,
          processedAt: Date.now()
        }
      };
      
    } catch (error) {
      logger.error(`Failed to process DLQ job ${job.id}:`, error);
      throw error;
    }
  }

  /**
   * Send alert for DLQ events
   * @param {Object} dlqJobData - DLQ job data
   */
  async sendDlqAlert(dlqJobData) {
    try {
      const slackWebhookService = require('./slackWebhookService');
      
      const message = `**RPC Job Failed - Moved to Dead Letter Queue**

**Original Job ID:** ${dlqJobData.originalJobId}
**Method:** ${dlqJobData.method}
**RPC URL:** ${dlqJobData.rpcUrl}
**Attempts:** ${dlqJobData.attemptsMade}/${this.maxRetries}
**Duration:** ${dlqJobData.duration}ms
**Error:** ${dlqJobData.error.message}

**Job Data:**
\`\`\`json
${JSON.stringify(dlqJobData.params, null, 2)}
\`\`\`

**Action Required:** Investigate RPC endpoint and retry manually if needed`;

      await slackWebhookService.sendAlert(message, {
        channel: '#alerts',
        username: 'RPC Queue Service',
        icon_emoji: ':warning:',
        priority: 'medium'
      });
      
    } catch (alertError) {
      logger.error('Failed to send DLQ alert:', alertError);
      // Don't throw - alert failure shouldn't break the queue
    }
  }

  /**
   * Log DLQ event for monitoring
   * @param {Object} dlqJobData - DLQ job data
   */
  async logDlqEvent(dlqJobData) {
    try {
      // This could be extended to log to monitoring systems
      logger.info('DLQ Event:', {
        jobId: dlqJobData.originalJobId,
        method: dlqJobData.method,
        error: dlqJobData.error.message,
        attemptsMade: dlqJobData.attemptsMade,
        timestamp: dlqJobData.timestamp
      });
      
      // Send to Sentry for tracking
      Sentry.captureMessage(`RPC Job Failed - Moved to DLQ: ${dlqJobData.method}`, {
        level: 'warning',
        tags: { 
          service: 'rpc-queue-service', 
          method: dlqJobData.method,
          rpc_url: dlqJobData.rpcUrl
        },
        extra: {
          originalJobId: dlqJobData.originalJobId,
          error: dlqJobData.error,
          attemptsMade: dlqJobData.attemptsMade,
          params: dlqJobData.params
        }
      });
      
    } catch (logError) {
      logger.error('Failed to log DLQ event:', logError);
    }
  }

  /**
   * Get queue statistics
   * @returns {Promise<Object>} Queue statistics
   */
  async getStats() {
    try {
      const [rpcFetchStats, priorityRpcStats, dlqStats] = await Promise.all([
        this.queueService.getQueueStats(this.QUEUE_NAMES.RPC_FETCH),
        this.queueService.getQueueStats(this.QUEUE_NAMES.PRIORITY_RPC),
        this.queueService.getQueueStats(this.QUEUE_NAMES.DEAD_LETTER)
      ]);

      return {
        service: {
          isStarted: this.isStarted,
          redisStatus: this.queueService.getConnectionStatus()
        },
        queues: {
          rpcFetch: rpcFetchStats,
          priorityRpc: priorityRpcStats,
          deadLetter: dlqStats
        },
        jobs: {
          ...this.stats,
          successRate: this.stats.totalJobs > 0 ? (this.stats.successfulJobs / this.stats.totalJobs) * 100 : 0,
          failureRate: this.stats.totalJobs > 0 ? (this.stats.failedJobs / this.stats.totalJobs) * 100 : 0,
          dlqRate: this.stats.totalJobs > 0 ? (this.stats.dlqJobs / this.stats.totalJobs) * 100 : 0
        }
      };
    } catch (error) {
      logger.error('Failed to get RPC queue stats:', error);
      throw error;
    }
  }

  /**
   * Get failed jobs from Dead Letter Queue
   * @param {number} limit - Maximum number of jobs to return
   * @returns {Promise<Array>} Array of failed jobs
   */
  async getDlqJobs(limit = 50) {
    return this.queueService.getFailedJobs(this.QUEUE_NAMES.DEAD_LETTER, limit);
  }

  /**
   * Retry job from Dead Letter Queue
   * @param {string} dlqJobId - DLQ job ID
   * @returns {Promise<Job>} Retried job
   */
  async retryDlqJob(dlqJobId) {
    try {
      // Get the DLQ job
      const dlqJob = await this.deadLetterQueue.getJob(dlqJobId);
      if (!dlqJob) {
        throw new Error(`DLQ job ${dlqJobId} not found`);
      }

      const { method, params, rpcUrl, metadata } = dlqJob.data;

      // Remove from DLQ
      await dlqJob.remove();

      // Add back to main queue with higher priority
      const newJob = await this.addRpcJob(method, params, {
        rpcUrl,
        priority: 'high',
        source: 'dlq-retry',
        timeout: metadata?.timeout || 15000
      });

      logger.info(`Retried DLQ job ${dlqJobId} as new job ${newJob.id}`);
      return newJob;
      
    } catch (error) {
      logger.error(`Failed to retry DLQ job ${dlqJobId}:`, error);
      throw error;
    }
  }

  /**
   * Delete job from Dead Letter Queue
   * @param {string} dlqJobId - DLQ job ID
   * @returns {Promise<boolean>} True if job was deleted
   */
  async deleteDlqJob(dlqJobId) {
    return this.queueService.deleteJob(this.QUEUE_NAMES.DEAD_LETTER, dlqJobId);
  }

  /**
   * Clear Dead Letter Queue
   */
  async clearDlq() {
    await this.queueService.clearQueue(this.QUEUE_NAMES.DEAD_LETTER);
    logger.info('Dead Letter Queue cleared');
  }

  /**
   * Pause RPC queues
   */
  async pauseQueues() {
    await Promise.all([
      this.queueService.pauseQueue(this.QUEUE_NAMES.RPC_FETCH),
      this.queueService.pauseQueue(this.QUEUE_NAMES.PRIORITY_RPC)
    ]);
    logger.info('RPC queues paused');
  }

  /**
   * Resume RPC queues
   */
  async resumeQueues() {
    await Promise.all([
      this.queueService.resumeQueue(this.QUEUE_NAMES.RPC_FETCH),
      this.queueService.resumeQueue(this.QUEUE_NAMES.PRIORITY_RPC)
    ]);
    logger.info('RPC queues resumed');
  }

  /**
   * Health check
   * @returns {Promise<Object>} Health check results
   */
  async healthCheck() {
    try {
      const queueHealth = await this.queueService.healthCheck();
      const stats = await this.getStats();
      
      return {
        status: this.isStarted ? 'healthy' : 'stopped',
        queue: queueHealth,
        stats,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalJobs: 0,
      successfulJobs: 0,
      failedJobs: 0,
      dlqJobs: 0,
      retriedJobs: 0
    };
    logger.info('RPC queue statistics reset');
  }
}

module.exports = RpcQueueService;
