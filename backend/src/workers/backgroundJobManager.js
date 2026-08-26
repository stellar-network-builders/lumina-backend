const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');
const QueueService = require('../services/queueService');
const DeadLetterMonitorService = require('../services/deadLetterMonitorService');

/**
 * Names of the application background queues managed here. Each has a paired
 * dead-letter queue (`<name>-dlq`) created automatically.
 */
const QUEUE_NAMES = {
  ANNUAL_STATEMENT: 'annual-statement',
  HEAVY_COMPUTATION: 'heavy-computation',
};

const EXPORTS_DIR = path.join(__dirname, '../../exports');

/**
 * BackgroundJobManager
 *
 * Single application-wide owner of the Node-side BullMQ background workers
 * (annual-statement PDF generation and heavy CSV/computation jobs). It:
 *  - registers each queue with retry + exponential backoff + stalled detection
 *  - registers a worker per queue that routes exhausted jobs to a DLQ
 *  - runs a periodic monitor that alerts when any DLQ accumulates jobs
 *
 * Exposed as a singleton so routes can enqueue jobs and read status without
 * re-instantiating Redis connections. `init()` is idempotent.
 */
class BackgroundJobManager {
  constructor() {
    this.queueService = new QueueService();
    this.monitor = new DeadLetterMonitorService(this.queueService);
    this.initialized = false;
    this.QUEUE_NAMES = QUEUE_NAMES;
  }

  /**
   * Idempotently wire up queues, workers, DLQs and the monitor. Called once at
   * server boot. Failures are logged but do not crash the server — background
   * processing degrades gracefully if Redis is unavailable.
   */
  async init() {
    if (this.initialized) {
      return;
    }

    try {
      await this.queueService.connect();

      // Register queues + their dead-letter queues.
      Object.values(QUEUE_NAMES).forEach((name) => {
        this.queueService.getQueue(name);
        this.queueService.createDeadLetterQueue(name);
      });

      // Register workers (only when not running under test, to avoid opening
      // blocking Redis connections during unit tests).
      if (process.env.NODE_ENV !== 'test') {
        this.registerWorker(QUEUE_NAMES.ANNUAL_STATEMENT, this.processAnnualStatement.bind(this));
        this.registerWorker(QUEUE_NAMES.HEAVY_COMPUTATION, this.processHeavyComputation.bind(this));
        this.monitor.start();
      }

      this.initialized = true;
      logger.info('BackgroundJobManager initialized');
    } catch (error) {
      logger.error('BackgroundJobManager failed to initialize:', error.message);
    }
  }

  /**
   * Register a worker that, on terminal failure (all retries exhausted), moves
   * the job to its dead-letter queue. BullMQ drives the retry/backoff schedule;
   * the `failed` handler only fires the DLQ routing once attempts run out.
   */
  registerWorker(queueName, processor) {
    const worker = this.queueService.getWorker(queueName, processor);

    worker.on('failed', async (job, err) => {
      if (!job) return;
      const attemptsAllowed = job.opts?.attempts || this.queueService.defaultMaxRetries;
      if (job.attemptsMade >= attemptsAllowed) {
        try {
          await this.queueService.moveToDeadLetter(queueName, job, err);
          logger.error(
            `[${queueName}] job ${job.id} exhausted ${attemptsAllowed} attempts → moved to DLQ`
          );
        } catch (dlqErr) {
          logger.error(`[${queueName}] failed to route job ${job.id} to DLQ:`, dlqErr.message);
        }
      }
    });

    return worker;
  }

  // ---------------------------------------------------------------------------
  // Job producers (used by routes)
  // ---------------------------------------------------------------------------

  /**
   * Queue an annual-statement PDF generation job.
   * Backwards-compatible signature used by index.js.
   */
  async addAnnualStatementJob(statementData, year) {
    return this.queueService.addJob(QUEUE_NAMES.ANNUAL_STATEMENT, 'generate-annual-statement', {
      statementData,
      year,
    });
  }

  /**
   * Queue a heavy computation / CSV export job.
   */
  async addHeavyComputationJob(type, payload = {}) {
    return this.queueService.addJob(QUEUE_NAMES.HEAVY_COMPUTATION, type, { type, ...payload });
  }

  /**
   * Look up the status of a job across the managed queues.
   */
  async getJobStatus(jobId) {
    for (const name of Object.values(QUEUE_NAMES)) {
      const queue = this.queueService.getQueue(name);
      const job = await queue.getJob(jobId);
      if (job) {
        return {
          id: job.id,
          queue: name,
          state: await job.getState(),
          progress: job.progress,
          attemptsMade: job.attemptsMade,
          result: job.returnvalue,
          failedReason: job.failedReason,
        };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Job processors
  // ---------------------------------------------------------------------------

  async processAnnualStatement(job) {
    const annualStatementPDFService = require('../services/annualStatementPDFService');
    const { statementData, year } = job.data;

    const pdfBuffer = await annualStatementPDFService.generateAnnualStatement(statementData, year);

    if (!fs.existsSync(EXPORTS_DIR)) {
      fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    }
    const filename = `annual-statement-${year}-${job.id}.pdf`;
    fs.writeFileSync(path.join(EXPORTS_DIR, filename), pdfBuffer);

    return { success: true, filename, size: pdfBuffer.length };
  }

  async processHeavyComputation(job) {
    const { type, vaultId } = job.data;

    if (type === 'CSV' || type === 'generate-csv') {
      const vaultExportService = require('../services/vaultExportService');
      const vault = await vaultExportService.getVaultDataForExport(vaultId);
      const csv = vaultExportService.generateCSVHeaders() + vaultExportService.vaultToCSV(vault);

      if (!fs.existsSync(EXPORTS_DIR)) {
        fs.mkdirSync(EXPORTS_DIR, { recursive: true });
      }
      const filename = `vault-${vaultId}-${job.id}.csv`;
      fs.writeFileSync(path.join(EXPORTS_DIR, filename), csv);
      return { success: true, filename, length: csv.length };
    }

    throw new Error(`Unknown heavy-computation job type: ${type}`);
  }

  // ---------------------------------------------------------------------------
  // Monitoring (used by /admin/queues/status)
  // ---------------------------------------------------------------------------

  /**
   * Aggregate status of all managed queues and their dead-letter queues.
   */
  async getQueuesStatus() {
    const queues = await this.queueService.getAllQueueStats();
    const deadLetterQueues = await this.queueService.getAllDeadLetterCounts();
    return {
      connection: this.queueService.getConnectionStatus(),
      queues,
      deadLetterQueues,
      monitor: {
        running: this.monitor.isRunning,
        lastAlertAt: this.monitor.lastAlertAt,
      },
      timestamp: new Date().toISOString(),
    };
  }

  async shutdown() {
    this.monitor.stop();
    await this.queueService.disconnect();
    this.initialized = false;
  }
}

module.exports = new BackgroundJobManager();
