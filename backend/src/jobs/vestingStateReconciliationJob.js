'use strict';

const logger = require('../utils/logger');
const cron = require('node-cron');
const VestingStateReconciliationService = require('../services/vestingStateReconciliationService');
const Sentry = require('@sentry/node');

class VestingStateReconciliationJob {
  constructor() {
    this.cronSchedule = process.env.VESTING_RECONCILIATION_CRON || '15 */4 * * *'; // Every 4 hours at :15
    this.isRunning = false;
    this.service = new VestingStateReconciliationService({
      precisionTolerance: parseFloat(process.env.VESTING_RECONCILIATION_PRECISION_TOLERANCE || '1e-18'),
      batchSize: parseInt(process.env.VESTING_RECONCILIATION_BATCH_SIZE || '50', 10),
      autoReconcile: process.env.VESTING_RECONCILIATION_AUTO_RECONCILE === 'true',
      maxRetries: parseInt(process.env.VESTING_RECONCILIATION_MAX_RETRIES || '3', 10),
      rpcTimeout: parseInt(process.env.VESTING_RECONCILIATION_RPC_TIMEOUT || '15000', 10),
    });
    this.task = null;
  }

  start() {
    if (this.isRunning) {
      logger.warn('Vesting State Reconciliation Job is already running');
      return;
    }

    logger.info(`Initializing Vesting State Reconciliation Job (schedule: ${this.cronSchedule})...`);

    this.task = cron.schedule(this.cronSchedule, async () => {
      logger.info('Running Vesting State Reconciliation Job...');
      try {
        const summary = await this.service.reconcileAllVaults('scheduled');
        logger.info(`Vesting State Reconciliation Job completed: ${JSON.stringify(summary)}`);
      } catch (error) {
        logger.error('Error in Vesting State Reconciliation Job:', error);
        Sentry.captureException(error, {
          tags: { service: 'vesting-state-reconciliation-job' },
        });
      }
    });

    this.isRunning = true;
    logger.info('Vesting State Reconciliation Job started.');
  }

  stop() {
    if (!this.isRunning) {
      logger.warn('Vesting State Reconciliation Job is not running');
      return;
    }

    if (this.task) {
      this.task.stop();
      this.task = null;
    }

    this.isRunning = false;
    logger.info('Vesting State Reconciliation Job stopped.');
  }

  async runManually(vaultAddress = null, runType = 'manual') {
    if (vaultAddress) {
      return this.service.reconcileVault(vaultAddress, runType);
    }
    return this.service.reconcileAllVaults(runType);
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      cronSchedule: this.cronSchedule,
      service: this.service.getStatus(),
    };
  }

  updateConfig(config) {
    this.service.updateConfig(config);
    logger.info('Vesting State Reconciliation Job config updated:', config);
  }
}

module.exports = VestingStateReconciliationJob;
