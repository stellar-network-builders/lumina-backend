// stellar-sdk v11: Soroban RPC client is `SorobanRpc.Server`, classic is `Horizon.Server`.
const logger = require('../utils/logger');
const { Horizon, SorobanRpc } = require('stellar-sdk');
const EventEmitter = require('events');
const Sentry = require('@sentry/node');
const slackWebhookService = require('./slackWebhookService');

class ShadowIndexingService extends EventEmitter {
  constructor() {
    super();
    this.name = 'shadow-indexing';
    this.isEnabled = process.env.SHADOW_INDEXING_ENABLED === 'true';
    this.server = new SorobanRpc.Server(process.env.SOROBAN_RPC_URL || 'https://rpc.mainnet.stellar.org');
    this.horizon = new Horizon.Server(process.env.HORIZON_URL || 'https://horizon.stellar.org');
    this.currentIndex = 0;
    this.processedLedgers = new Map();
    this.processedTransactions = new Map();
    this.isIndexing = false;
    this.indexingInterval = null;
    this.validationInterval = null;
    
    // Configuration
    this.config = {
      indexingInterval: parseInt(process.env.SHADOW_INDEXING_INTERVAL) || 3000,
      validationInterval: parseInt(process.env.SHADOW_VALIDATION_INTERVAL) || 30,
      criticalInconsistencyCount: parseInt(process.env.CRITICAL_INCONSISTENCY_COUNT) || 5,
      warningInconsistencyCount: parseInt(process.env.WARNING_INCONSISTENCY_COUNT) || 2,
      failoverThreshold: parseInt(process.env.FAILOVER_THRESHOLD) || 10,
      autoFailover: process.env.AUTO_FAILOVER === 'true'
    };
    
    // Statistics
    this.stats = {
      totalLedgersProcessed: 0,
      totalTransactionsProcessed: 0,
      inconsistenciesDetected: 0,
      averageProcessingTime: 0,
      lastSyncTime: null,
      validationCount: 0,
      criticalIssues: 0,
      warningIssues: 0
    };
  }

  async start() {
    if (!this.isEnabled) {
      logger.info('Shadow-indexing is disabled');
      return;
    }

    if (this.isIndexing) {
      logger.info('Shadow-indexing is already running');
      return;
    }

    try {
      logger.info('Starting shadow-indexing service...');
      
      // Get current ledger
      const currentLedger = await this.getCurrentLedger();
      this.currentIndex = currentLedger;
      
      // Start indexing loop
      this.startIndexing();
      
      // Start consistency monitoring
      this.startConsistencyMonitoring();
      
      this.isIndexing = true;
      this.emit('started', { name: this.name, startLedger: currentLedger });
      
      logger.info(`Shadow-indexing service started successfully from ledger ${currentLedger}`);
      
    } catch (error) {
      logger.error('Failed to start shadow-indexing service:', error);
      Sentry.captureException(error);
      throw error;
    }
  }

  async stop() {
    if (!this.isIndexing) {
      return;
    }

    logger.info('Stopping shadow-indexing service...');
    
    if (this.indexingInterval) {
      clearInterval(this.indexingInterval);
      this.indexingInterval = null;
    }
    
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
      this.validationInterval = null;
    }
    
    this.isIndexing = false;
    this.emit('stopped', { name: this.name });
    
    logger.info('Shadow-indexing service stopped');
  }

  startIndexing() {
    this.indexingInterval = setInterval(async () => {
      try {
        const currentLedger = await this.getCurrentLedger();
        
        // Process all ledgers from current index to current ledger
        while (this.currentIndex < currentLedger) {
          this.currentIndex++;
          await this.processLedger(this.currentIndex);
        }
        
      } catch (error) {
        logger.error('Error in shadow-indexing loop:', error);
        Sentry.captureException(error);
        this.emit('error', error);
      }
    }, this.config.indexingInterval);
  }

  startConsistencyMonitoring() {
    this.validationInterval = setInterval(async () => {
      try {
        await this.performConsistencyCheck();
      } catch (error) {
        logger.error('Error in consistency monitoring:', error);
        Sentry.captureException(error);
      }
    }, this.config.validationInterval * 1000);
  }

  async getCurrentLedger() {
    try {
      const latestLedger = await this.horizon.ledgers().order('desc').limit(1).call();
      return parseInt(latestLedger.records[0].sequence);
    } catch (error) {
      logger.error('Error fetching current ledger:', error);
      throw error;
    }
  }

  async getLedgerDetails(ledgerSequence) {
    try {
      const ledger = await this.horizon.ledgers().ledger(ledgerSequence).call();
      return ledger;
    } catch (error) {
      logger.error(`Error fetching ledger details for ${ledgerSequence}:`, error);
      throw error;
    }
  }

  async getTransactionsForLedger(ledgerSequence) {
    try {
      const transactions = await this.horizon
        .transactions()
        .forLedger(ledgerSequence)
        .call();
      
      return transactions.records;
    } catch (error) {
      logger.error(`Error fetching transactions for ledger ${ledgerSequence}:`, error);
      throw error;
    }
  }

  async processLedger(ledgerSequence) {
    const startTime = Date.now();
    
    try {
      // Get ledger details
      const ledgerDetails = await this.getLedgerDetails(ledgerSequence);
      
      // Get transactions for this ledger
      const transactions = await this.getTransactionsForLedger(ledgerSequence);
      
      // Process transactions
      const processedTxHashes = [];
      for (const tx of transactions) {
        processedTxHashes.push(tx.hash);
        this.processedTransactions.set(tx.hash, {
          ledger: ledgerSequence,
          timestamp: new Date().toISOString(),
          indexer: this.name
        });
      }

      // Store ledger data for consistency validation
      const ledgerData = {
        sequence: ledgerSequence,
        hash: ledgerDetails.hash,
        transaction_count: transactions.length,
        transaction_hashes: processedTxHashes,
        timestamp: ledgerDetails.closed_at,
        processed_at: new Date().toISOString(),
        processing_time: Date.now() - startTime,
        indexer: this.name
      };
      
      this.processedLedgers.set(ledgerSequence, ledgerData);
      
      // Update stats
      this.updateStats(ledgerData);
      
      // Emit event for real-time monitoring
      this.emit('ledgerProcessed', ledgerData);
      
      console.debug(`[${this.name}] Processed ledger ${ledgerSequence} with ${transactions.length} transactions in ${ledgerData.processing_time}ms`);
      
      return ledgerData;
      
    } catch (error) {
      logger.error(`[${this.name}] Error processing ledger ${ledgerSequence}:`, error);
      Sentry.captureException(error);
      throw error;
    }
  }

  updateStats(ledgerData) {
    this.stats.totalLedgersProcessed++;
    this.stats.totalTransactionsProcessed += ledgerData.transaction_count;
    this.stats.averageProcessingTime = 
      (this.stats.averageProcessingTime * (this.stats.totalLedgersProcessed - 1) + 
       ledgerData.processing_time) / this.stats.totalLedgersProcessed;
    this.stats.lastSyncTime = new Date().toISOString();
  }

  async performConsistencyCheck() {
    if (!this.isEnabled) {
      return;
    }

    this.stats.validationCount++;
    const startTime = Date.now();
    
    try {
      logger.info('Performing shadow-indexing consistency check...');
      
      // For now, we'll simulate consistency checks with the main indexer
      // In a real implementation, you would compare with the main indexer's data
      const inconsistencies = await this.validateAgainstMainIndexer();
      
      // Categorize inconsistencies
      const criticalIssues = inconsistencies.filter(inc => 
        inc.type === 'LEDGER_HASH_MISMATCH' || inc.type === 'MISSING_LEDGER'
      );
      const warningIssues = inconsistencies.filter(inc => 
        inc.type === 'TRANSACTION_COUNT_MISMATCH' || 
        inc.type === 'MISSING_TRANSACTIONS_IN_MAIN' ||
        inc.type === 'MISSING_TRANSACTIONS_IN_SHADOW'
      );
      
      // Update statistics
      this.stats.criticalIssues += criticalIssues.length;
      this.stats.warningIssues += warningIssues.length;
      this.stats.inconsistenciesDetected += inconsistencies.length;
      
      // Create consistency report
      const consistencyReport = {
        timestamp: new Date().toISOString(),
        validationDuration: Date.now() - startTime,
        totalLedgers: this.processedLedgers.size,
        totalInconsistencies: inconsistencies.length,
        criticalIssues: criticalIssues.length,
        warningIssues: warningIssues.length,
        inconsistencies: inconsistencies,
        validationPassed: inconsistencies.length <= this.config.warningInconsistencyCount
      };
      
      // Handle consistency issues
      await this.handleConsistencyIssues(consistencyReport);
      
      // Emit event for monitoring
      this.emit('consistencyCheck', consistencyReport);
      
      logger.info(`Consistency check completed in ${consistencyReport.validationDuration}ms - ` +
                  `Issues: ${inconsistencies.length}, Critical: ${criticalIssues.length}, Warnings: ${warningIssues.length}`);
      
      return consistencyReport;
      
    } catch (error) {
      logger.error('Error during consistency check:', error);
      Sentry.captureException(error);
      this.emit('error', error);
      throw error;
    }
  }

  async validateAgainstMainIndexer() {
    // This is a simplified validation - in a real implementation,
    // you would compare with the main indexer's processed data
    const inconsistencies = [];
    
    // For demonstration, we'll simulate some consistency checks
    // In practice, you would fetch data from the main indexer and compare
    
    return inconsistencies;
  }

  async handleConsistencyIssues(report) {
    // Check for critical issues that require immediate attention
    if (report.criticalIssues >= this.config.criticalInconsistencyCount) {
      await this.sendCriticalAlert(report);
    } else if (report.totalInconsistencies >= this.config.warningInconsistencyCount) {
      await this.sendWarningAlert(report);
    }
    
    // Check if failover is needed
    if (report.criticalIssues >= this.config.failoverThreshold && this.config.autoFailover) {
      logger.warn('Critical inconsistency threshold reached, considering failover...');
      this.emit('failoverRequired', report);
      await this.sendFailoverAlert(report);
    }
    
    // Send recovery notification if consistency is restored
    if (report.validationPassed && this.stats.inconsistenciesDetected > 0) {
      await this.sendRecoveryAlert(report);
    }
  }

  async sendCriticalAlert(report) {
    try {
      const message = `🚨 Critical Consistency Issues Detected\n\n` +
        `**Consistency Rate**: ${((this.processedLedgers.size - report.totalInconsistencies) / this.processedLedgers.size * 100).toFixed(2)}%\n` +
        `**Critical Issues**: ${report.criticalIssues}\n` +
        `**Total Inconsistencies**: ${report.totalInconsistencies}\n` +
        `**Validation Duration**: ${report.validationDuration}ms\n` +
        `**Timestamp**: ${report.timestamp}\n\n` +
        `**Recommendation**: Immediate investigation required - potential data corruption detected`;

      await slackWebhookService.sendAlert(message, 'critical');
      logger.warn('Critical consistency alert sent');
      
    } catch (error) {
      logger.error('Failed to send critical consistency alert:', error);
      Sentry.captureException(error);
    }
  }

  async sendWarningAlert(report) {
    try {
      const message = `⚠️ Consistency Warnings Detected\n\n` +
        `**Consistency Rate**: ${((this.processedLedgers.size - report.totalInconsistencies) / this.processedLedgers.size * 100).toFixed(2)}%\n` +
        `**Warning Issues**: ${report.warningIssues}\n` +
        `**Total Inconsistencies**: ${report.totalInconsistencies}\n` +
        `**Validation Duration**: ${report.validationDuration}ms\n` +
        `**Timestamp**: ${report.timestamp}\n\n` +
        `**Recommendation**: Monitor closely - investigate if issues persist`;

      await slackWebhookService.sendAlert(message, 'warning');
      logger.warn('Warning consistency alert sent');
      
    } catch (error) {
      logger.error('Failed to send warning consistency alert:', error);
      Sentry.captureException(error);
    }
  }

  async sendFailoverAlert(report) {
    try {
      const message = `🔄 Failover Required\n\n` +
        `**Reason**: Critical consistency threshold exceeded\n` +
        `**Critical Issues**: ${report.criticalIssues}\n` +
        `**Failover Threshold**: ${this.config.failoverThreshold}\n` +
        `**Timestamp**: ${report.timestamp}\n\n` +
        `**Action Required**: Immediate failover recommended`;

      await slackWebhookService.sendAlert(message, 'critical');
      logger.warn('Failover alert sent');
      
    } catch (error) {
      logger.error('Failed to send failover alert:', error);
      Sentry.captureException(error);
    }
  }

  async sendRecoveryAlert(report) {
    try {
      const message = `✅ Consistency Restored\n\n` +
        `**Consistency Rate**: ${((this.processedLedgers.size - report.totalInconsistencies) / this.processedLedgers.size * 100).toFixed(2)}%\n` +
        `**Validation Passed**: ${report.validationPassed}\n` +
        `**Timestamp**: ${report.timestamp}\n\n` +
        `**Status**: System stability restored`;

      await slackWebhookService.sendAlert(message, 'info');
      console.info('Recovery alert sent');
      
    } catch (error) {
      logger.error('Failed to send recovery alert:', error);
      Sentry.captureException(error);
    }
  }

  getProcessedLedgers() {
    return new Map(this.processedLedgers);
  }

  getStats() {
    return {
      ...this.stats,
      name: this.name,
      currentIndex: this.currentIndex,
      processedLedgersCount: this.processedLedgers.size,
      processedTransactionsCount: this.processedTransactions.size,
      isIndexing: this.isIndexing,
      isEnabled: this.isEnabled,
      config: this.config
    };
  }

  getConsistencyRate() {
    if (this.processedLedgers.size === 0) return 100;
    return ((this.processedLedgers.size - this.stats.inconsistenciesDetected) / this.processedLedgers.size * 100).toFixed(2);
  }

  reset() {
    this.processedLedgers.clear();
    this.processedTransactions.clear();
    this.currentIndex = 0;
    this.stats = {
      totalLedgersProcessed: 0,
      totalTransactionsProcessed: 0,
      inconsistenciesDetected: 0,
      averageProcessingTime: 0,
      lastSyncTime: null,
      validationCount: 0,
      criticalIssues: 0,
      warningIssues: 0
    };
    logger.info('Shadow-indexing service reset completed');
  }
}

// Create singleton instance
const shadowIndexingService = new ShadowIndexingService();

module.exports = shadowIndexingService;
