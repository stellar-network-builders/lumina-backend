const logger = require('../utils/logger');
const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');

/**
 * Default retry strategy for background jobs.
 *
 * 5 attempts with exponential backoff producing the delays:
 *   1min, 2min, 4min, 8min, 16min
 * (BullMQ computes `delay * 2 ** (attemptsMade - 1)` for exponential backoff,
 *  so a base delay of 60_000ms yields the schedule above.)
 */
const DEFAULT_MAX_RETRIES = parseInt(process.env.QUEUE_MAX_RETRIES || '5', 10);
const DEFAULT_BACKOFF_DELAY = parseInt(process.env.QUEUE_BACKOFF_DELAY_MS || '60000', 10);

/**
 * Stalled-job detection defaults. A stalled job is one whose worker died or
 * blocked the event loop long enough to miss its lock renewal. BullMQ will
 * move such jobs back to "waiting" (up to `maxStalledCount` times) so another
 * worker can pick them up; after that they are marked failed.
 */
const DEFAULT_STALLED_INTERVAL = parseInt(process.env.QUEUE_STALLED_INTERVAL_MS || '30000', 10);
const DEFAULT_MAX_STALLED_COUNT = parseInt(process.env.QUEUE_MAX_STALLED_COUNT || '2', 10);

const DLQ_SUFFIX = '-dlq';

/**
 * QueueService — a thin, well-instrumented wrapper around BullMQ that provides:
 *  - retry with exponential backoff (configurable, sensible defaults)
 *  - dead-letter-queue (DLQ) helpers for permanently failed jobs
 *  - stalled-job detection / auto-recovery configuration for workers
 *  - monitoring helpers (per-queue and aggregate stats, health checks)
 *
 * A single QueueService owns one Redis connection shared by all of its queues
 * and workers. Instantiate one per logical service (e.g. the background job
 * manager and the RPC queue service each own their own instance).
 */
class QueueService {
  constructor(options = {}) {
    this.redisConfig = {
      host: options.redisHost || process.env.REDIS_HOST || 'localhost',
      port: parseInt(options.redisPort || process.env.REDIS_PORT || '6379', 10),
      db: parseInt(options.redisDb || process.env.REDIS_DB || '0', 10),
    };

    // Shared connection. lazyConnect lets callers control when the socket opens
    // (and keeps unit tests from auto-connecting). maxRetriesPerRequest must be
    // null for BullMQ blocking commands.
    this.connection = new IORedis({
      host: this.redisConfig.host,
      port: this.redisConfig.port,
      db: this.redisConfig.db,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
    });

    this.queues = new Map();
    this.workers = new Map();
    this.deadLetterQueues = new Set();
    this.isReady = false;

    // Default options applied to every queue/worker created through this service.
    this.defaultMaxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this.defaultBackoffDelay = options.backoffDelay || DEFAULT_BACKOFF_DELAY;
    this.stalledInterval = options.stalledInterval || DEFAULT_STALLED_INTERVAL;
    this.maxStalledCount =
      options.maxStalledCount != null ? options.maxStalledCount : DEFAULT_MAX_STALLED_COUNT;
  }

  /**
   * Default job options shared by all queues: exponential backoff retry and
   * bounded retention so Redis does not grow unbounded.
   */
  getDefaultJobOptions(overrides = {}) {
    return {
      attempts: this.defaultMaxRetries,
      backoff: {
        type: 'exponential',
        delay: this.defaultBackoffDelay,
      },
      removeOnComplete: 1000,
      removeOnFail: false, // keep failed jobs so they can be inspected / routed to DLQ
      ...overrides,
    };
  }

  /**
   * Default worker options: stalled-job detection + auto recovery.
   */
  getDefaultWorkerOptions(overrides = {}) {
    return {
      concurrency: 5,
      stalledInterval: this.stalledInterval,
      maxStalledCount: this.maxStalledCount,
      ...overrides,
    };
  }

  /**
   * Open the Redis connection.
   */
  async connect() {
    try {
      await this.connection.connect();
      this.isReady = true;
      logger.info(
        `QueueService connected to Redis at ${this.redisConfig.host}:${this.redisConfig.port}`
      );
    } catch (error) {
      this.isReady = false;
      logger.error('QueueService failed to connect to Redis:', error.message);
      throw error;
    }
  }

  /**
   * Gracefully close all workers, queues and the Redis connection.
   */
  async disconnect() {
    try {
      for (const worker of this.workers.values()) {
        await worker.close();
      }
      for (const queue of this.queues.values()) {
        await queue.close();
      }
      await this.connection.disconnect();
    } finally {
      this.isReady = false;
    }
  }

  /**
   * Get (or lazily create) a queue by name. Default job options are applied
   * unless explicitly overridden by the caller.
   */
  getQueue(name, options = {}) {
    if (this.queues.has(name)) {
      return this.queues.get(name);
    }

    const queue = new Queue(name, {
      connection: this.connection,
      ...options,
      defaultJobOptions: this.getDefaultJobOptions(options.defaultJobOptions),
    });

    this.queues.set(name, queue);
    return queue;
  }

  /**
   * Get (or lazily create) a worker for a queue. Stalled-job detection is
   * configured by default; callers may override concurrency/limiter/etc.
   */
  getWorker(name, processor, options = {}) {
    if (this.workers.has(name)) {
      return this.workers.get(name);
    }

    const worker = new Worker(name, processor, {
      connection: this.connection,
      ...this.getDefaultWorkerOptions(options),
    });

    // Surface lifecycle events for observability.
    worker.on('failed', (job, err) => {
      logger.error(
        `[queue:${name}] job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err?.message}`
      );
    });
    worker.on('stalled', (jobId) => {
      logger.warn(`[queue:${name}] job ${jobId} stalled — will be retried`);
    });
    worker.on('error', (err) => {
      logger.error(`[queue:${name}] worker error: ${err?.message}`);
    });

    this.workers.set(name, worker);
    return worker;
  }

  /**
   * Add a job to a queue. Default job options are merged with any per-job
   * overrides.
   */
  async addJob(queueName, jobName, data, options = {}) {
    const queue = this.getQueue(queueName);
    return queue.add(jobName, data, this.getDefaultJobOptions(options));
  }

  // ---------------------------------------------------------------------------
  // Dead-letter queue (DLQ) support
  // ---------------------------------------------------------------------------

  /**
   * Conventional DLQ name for a given source queue.
   */
  getDeadLetterQueueName(queueName) {
    return `${queueName}${DLQ_SUFFIX}`;
  }

  /**
   * Create (idempotently) the dead-letter queue paired with `queueName`.
   * DLQ jobs are not retried automatically and are retained for inspection.
   */
  createDeadLetterQueue(queueName) {
    const dlqName = this.getDeadLetterQueueName(queueName);
    const dlq = this.getQueue(dlqName, {
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    });
    this.deadLetterQueues.add(dlqName);
    return dlq;
  }

  /**
   * Move a permanently-failed job onto its dead-letter queue, preserving the
   * original payload and the failure context for later inspection / replay.
   */
  async moveToDeadLetter(queueName, job, error) {
    const dlq = this.createDeadLetterQueue(queueName);
    const payload = {
      originalQueue: queueName,
      originalJobId: job?.id,
      originalJobName: job?.name,
      data: job?.data,
      failedReason: error?.message || job?.failedReason,
      stack: error?.stack,
      attemptsMade: job?.attemptsMade,
      movedAt: new Date().toISOString(),
    };
    return dlq.add(`dlq:${job?.name || 'job'}`, payload, {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });
  }

  /**
   * Number of jobs currently sitting in a queue's DLQ (waiting + delayed +
   * failed + active). Used by the monitor to decide whether to alert.
   */
  async getDeadLetterCount(queueName) {
    const dlqName = this.getDeadLetterQueueName(queueName);
    const dlq = this.getQueue(dlqName);
    const counts = await dlq.getJobCounts('waiting', 'active', 'delayed', 'failed');
    return (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0) + (counts.failed || 0);
  }

  /**
   * Aggregate DLQ counts for every DLQ this service knows about.
   */
  async getAllDeadLetterCounts() {
    const results = [];
    for (const dlqName of this.deadLetterQueues) {
      const dlq = this.getQueue(dlqName);
      const counts = await dlq.getJobCounts('waiting', 'active', 'delayed', 'failed');
      const total =
        (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0) + (counts.failed || 0);
      results.push({ queueName: dlqName, total, counts });
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Monitoring helpers
  // ---------------------------------------------------------------------------

  /**
   * Snapshot of a single queue's job counts.
   */
  async getQueueStats(queueName) {
    const queue = this.queues.get(queueName) || this.getQueue(queueName);

    // Awaited sequentially so a failure in the first call propagates cleanly
    // without leaving sibling promises unhandled.
    const waiting = await queue.getWaiting();
    const active = await queue.getActive();
    const completed = await queue.getCompleted();
    const failed = await queue.getFailed();
    const delayed = await queue.getDelayed();

    return {
      queueName,
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      delayed: delayed.length,
      total: waiting.length + active.length + completed.length + failed.length + delayed.length,
    };
  }

  /**
   * Stats for every queue managed by this service.
   */
  async getAllQueueStats() {
    const stats = [];
    for (const queueName of this.queues.keys()) {
      stats.push(await this.getQueueStats(queueName));
    }
    return stats;
  }

  async pauseQueue(queueName) {
    const queue = this.queues.get(queueName) || this.getQueue(queueName);
    await queue.pause();
  }

  async resumeQueue(queueName) {
    const queue = this.queues.get(queueName) || this.getQueue(queueName);
    await queue.resume();
  }

  async clearQueue(queueName) {
    const queue = this.queues.get(queueName) || this.getQueue(queueName);
    await queue.drain();
  }

  /**
   * Return up to `limit` failed jobs from a queue, flattened for API responses.
   */
  async getFailedJobs(queueName, limit = 50) {
    const queue = this.queues.get(queueName) || this.getQueue(queueName);
    const jobs = await queue.getFailed(0, limit - 1);

    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      data: job.data,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
    }));
  }

  /**
   * Re-enqueue a specific job for another attempt.
   */
  async retryJob(queueName, jobId) {
    const queue = this.queues.get(queueName) || this.getQueue(queueName);
    const job = await queue.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    await job.retry();
    return job;
  }

  /**
   * Remove a specific job. Returns false if it did not exist.
   */
  async deleteJob(queueName, jobId) {
    const queue = this.queues.get(queueName) || this.getQueue(queueName);
    const job = await queue.getJob(jobId);
    if (!job) {
      return false;
    }
    await job.remove();
    return true;
  }

  isRedisReady() {
    return this.isReady && this.connection.status === 'ready';
  }

  getConnectionStatus() {
    return {
      status: this.connection.status,
      ready: this.isReady,
      host: this.redisConfig.host,
      port: this.redisConfig.port,
      db: this.redisConfig.db,
      queueCount: this.queues.size,
      workerCount: this.workers.size,
    };
  }

  /**
   * Full health check: pings Redis and returns per-queue stats.
   */
  async healthCheck() {
    try {
      await this.connection.ping();
      const queues = await this.getAllQueueStats();
      return {
        status: 'healthy',
        redis: {
          connected: this.isRedisReady(),
          status: this.connection.status,
        },
        queues,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

module.exports = QueueService;
