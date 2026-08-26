const logger = require('../utils/logger');
const cron = require('node-cron');
const VaultBalanceMonitorService = require('../services/vaultBalanceMonitorService');

class VaultBalanceMonitoringJob {
  constructor(service = new VaultBalanceMonitorService()) {
    this.service = service;
    this.cronJob = null;
    this.isRunning = false;
    this.cronSchedule = process.env.VAULT_BALANCE_MONITOR_CRON || '*/5 * * * *';
  }

  start() {
    if (!this.service.isEnabled()) {
      logger.warn('Vault balance monitoring job is disabled via VAULT_BALANCE_MONITOR_ENABLED=false');
      return;
    }

    if (this.cronJob) {
      logger.info('Vault balance monitoring job is already running');
      return;
    }

    this.cronJob = cron.schedule(this.cronSchedule, async () => {
      await this.execute();
    });

    logger.info(`Vault balance monitoring job started with schedule ${this.cronSchedule}.`);
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
  }

  async execute() {
    if (this.isRunning) {
      logger.info('Vault balance monitoring job already in progress, skipping overlapping run.');
      return;
    }

    this.isRunning = true;

    try {
      await this.service.runCheck();
    } catch (error) {
      logger.error('Vault balance monitoring job failed:', error);
    } finally {
      this.isRunning = false;
    }
  }
}

module.exports = new VaultBalanceMonitoringJob();
module.exports.VaultBalanceMonitoringJob = VaultBalanceMonitoringJob;
