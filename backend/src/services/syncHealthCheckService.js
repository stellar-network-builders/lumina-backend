const logger = require('../utils/logger');
const { IndexerState } = require('../models');
const { sequelize } = require('../database/connection');
const Sentry = require('@sentry/node');
const axios = require('axios');

/**
 * Sync Health Check Service for monitoring indexer status
 * Provides health check endpoint that returns sync status and ledger delta
 */
class SyncHealthCheckService {
  constructor() {
    this.healthyThreshold = 50; // Maximum allowed ledger delta for healthy status
    this.stellarRpcUrl = process.env.STELLAR_RPC_URL || process.env.SOROBAN_RPC_URL;
    this.cacheTimeout = 30000; // 30 seconds cache timeout
    this.lastHealthCheck = null;
    this.cachedResult = null;
  }

  /**
   * Main health check endpoint handler
   * Returns sync status with appropriate HTTP status codes
   * @returns {Promise<Object>} Health check result with status and metadata
   */
  async performHealthCheck() {
    const startTime = Date.now();
    
    try {
      // Check if we have a recent cached result
      if (this.cachedResult && this.lastHealthCheck && 
          (Date.now() - this.lastHealthCheck) < this.cacheTimeout) {
        logger.info('Returning cached health check result');
        return this.cachedResult;
      }

      logger.info('Performing sync health check...');
      
      // Get current Stellar network ledger
      const networkLedger = await this.getCurrentNetworkLedger();
      
      // Get last synced ledger from database
      const lastSyncedLedger = await this.getLastSyncedLedger();
      
      // Calculate ledger delta
      const ledgerDelta = networkLedger - lastSyncedLedger;
      
      // Determine health status
      const isHealthy = ledgerDelta <= this.healthyThreshold;
      const httpStatus = isHealthy ? 200 : 503;
      
      // Create health check result
      const healthResult = {
        status: isHealthy ? 'healthy' : 'unhealthy',
        httpStatus,
        timestamp: new Date().toISOString(),
        networkLedger,
        lastSyncedLedger,
        ledgerDelta,
        healthyThreshold: this.healthyThreshold,
        syncLagSeconds: await this.estimateSyncLagSeconds(ledgerDelta),
        indexerService: 'stellar-indexer',
        checks: {
          networkConnectivity: true,
          databaseConnectivity: true,
          syncStatus: isHealthy
        },
        metadata: {
          responseTime: Date.now() - startTime,
          cacheEnabled: true,
          cacheTimeout: this.cacheTimeout
        }
      };

      // Cache the result
      this.cachedResult = healthResult;
      this.lastHealthCheck = Date.now();

      // Log health status
      logger.info(`Health check completed: ${healthResult.status} (delta: ${ledgerDelta} ledgers)`);
      
      // Send alert if unhealthy
      if (!isHealthy) {
        await this.sendUnhealthyAlert(healthResult);
      }

      return healthResult;

    } catch (error) {
      logger.error('Critical error in health check:', error);
      
      // Send critical alert
      await this.sendCriticalHealthAlert(error);
      
      // Return unhealthy status with error details
      const errorResult = {
        status: 'critical',
        httpStatus: 503,
        timestamp: new Date().toISOString(),
        error: error.message,
        networkLedger: null,
        lastSyncedLedger: null,
        ledgerDelta: null,
        healthyThreshold: this.healthyThreshold,
        indexerService: 'stellar-indexer',
        checks: {
          networkConnectivity: false,
          databaseConnectivity: false,
          syncStatus: false
        },
        metadata: {
          responseTime: Date.now() - startTime,
          error: 'Health check failed'
        }
      };

      Sentry.captureException(error, {
        tags: { service: 'sync-health-check' },
        extra: { healthCheckResult: errorResult }
      });

      return errorResult;
    }
  }

  /**
   * Get current Stellar network ledger number
   * @returns {Promise<number>} Current network ledger
   */
  async getCurrentNetworkLedger() {
    try {
      if (!this.stellarRpcUrl) {
        throw new Error('Stellar RPC URL not configured');
      }

      const requestBody = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "getLatestLedger",
        params: {}
      };

      const response = await axios.post(this.stellarRpcUrl, requestBody, {
        timeout: 5000, // 5 second timeout
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.data.error) {
        throw new Error(`Stellar RPC Error: ${response.data.error.message}`);
      }

      // Extract ledger number from response
      const ledger = response.data.result?.sequence || response.data.result?.header?.ledgerSeq;
      
      if (!ledger) {
        throw new Error('Unable to extract ledger number from Stellar RPC response');
      }

      return parseInt(ledger);

    } catch (error) {
      logger.error('Error getting current network ledger:', error);
      throw new Error(`Failed to get current network ledger: ${error.message}`);
    }
  }

  /**
   * Get last synced ledger from indexer state
   * @returns {Promise<number>} Last synced ledger number
   */
  async getLastSyncedLedger() {
    try {
      const serviceName = 'stellar-indexer';
      
      const indexerState = await IndexerState.findByPk(serviceName);
      
      if (!indexerState) {
        logger.warn('No indexer state found, assuming genesis sync has not started');
        return 0;
      }

      return parseInt(indexerState.last_ingested_ledger);

    } catch (error) {
      logger.error('Error getting last synced ledger:', error);
      throw new Error(`Failed to get last synced ledger: ${error.message}`);
    }
  }

  /**
   * Estimate sync lag in seconds based on ledger delta
   * @param {number} ledgerDelta - Number of ledgers behind
   * @returns {Promise<number>} Estimated lag in seconds
   */
  async estimateSyncLagSeconds(ledgerDelta) {
    try {
      // Stellar has approximately 5 second ledger intervals
      const ledgerIntervalSeconds = 5;
      return ledgerDelta * ledgerIntervalSeconds;
    } catch (error) {
      logger.error('Error estimating sync lag:', error);
      return null;
    }
  }

  /**
   * Get detailed sync status for monitoring dashboards
   * @returns {Promise<Object>} Detailed sync status
   */
  async getDetailedSyncStatus() {
    try {
      const healthCheck = await this.performHealthCheck();
      
      // Add additional detailed information
      const detailedStatus = {
        ...healthCheck,
        indexerHistory: await this.getIndexerHistory(),
        performanceMetrics: await this.getPerformanceMetrics(),
        systemHealth: await this.getSystemHealth()
      };

      return detailedStatus;

    } catch (error) {
      logger.error('Error getting detailed sync status:', error);
      throw error;
    }
  }

  /**
   * Get indexer state history for trend analysis
   * @returns {Promise<Object>} Indexer history data
   */
  async getIndexerHistory() {
    try {
      // This would typically query a historical table or logs
      // For now, return basic information
      return {
        lastUpdated: new Date().toISOString(),
        dataRetention: '7 days',
        availableMetrics: ['ledger_delta', 'sync_time', 'error_rate']
      };
    } catch (error) {
      logger.error('Error getting indexer history:', error);
      return null;
    }
  }

  /**
   * Get performance metrics for the indexer
   * @returns {Promise<Object>} Performance metrics
   */
  async getPerformanceMetrics() {
    try {
      // Query database for performance metrics
      const [result] = await sequelize.query(`
        SELECT 
          COUNT(*) as total_records,
          MAX(updated_at) as last_update,
          AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_processing_time
        FROM indexer_state 
        WHERE service_name = 'stellar-indexer'
      `);

      return {
        totalRecords: parseInt(result[0]?.total_records || 0),
        lastUpdate: result[0]?.last_update,
        avgProcessingTime: parseFloat(result[0]?.avg_processing_time || 0)
      };
    } catch (error) {
      logger.error('Error getting performance metrics:', error);
      return null;
    }
  }

  /**
   * Get overall system health status
   * @returns {Promise<Object>} System health information
   */
  async getSystemHealth() {
    try {
      // Check database connectivity
      const dbHealth = await this.checkDatabaseHealth();
      
      // Check memory usage
      const memoryUsage = process.memoryUsage();
      
      return {
        database: dbHealth,
        memory: {
          used: memoryUsage.heapUsed,
          total: memoryUsage.heapTotal,
          external: memoryUsage.external,
          rss: memoryUsage.rss
        },
        uptime: process.uptime(),
        nodeVersion: process.version
      };
    } catch (error) {
      logger.error('Error getting system health:', error);
      return null;
    }
  }

  /**
   * Check database connectivity
   * @returns {Promise<Object>} Database health status
   */
  async checkDatabaseHealth() {
    try {
      await sequelize.authenticate();
      return {
        status: 'healthy',
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
   * Send alert when sync health is unhealthy
   * @param {Object} healthResult - Health check result
   */
  async sendUnhealthyAlert(healthResult) {
    try {
      const slackWebhookService = require('./slackWebhookService');
      
      const message = `**Sync Health Check Alert - UNHEALTHY**

**Status:** ${healthResult.status.toUpperCase()}
**Network Ledger:** ${healthResult.networkLedger}
**Last Synced Ledger:** ${healthResult.lastSyncedLedger}
**Ledger Delta:** ${healthResult.ledgerDelta} ledgers
**Healthy Threshold:** ${healthResult.healthyThreshold} ledgers
**Estimated Lag:** ${healthResult.syncLagSeconds} seconds

**Action Required:** Indexer is significantly behind the network. Check indexing service and network connectivity.

**Timestamp:** ${healthResult.timestamp}`;

      await slackWebhookService.sendAlert(message, {
        channel: '#critical-alerts',
        username: 'Sync Health Monitor',
        icon_emoji: ':warning:',
        priority: 'high'
      });

    } catch (error) {
      logger.error('Failed to send unhealthy alert:', error);
    }
  }

  /**
   * Send critical alert when health check fails
   * @param {Error} error - The error that caused the failure
   */
  async sendCriticalHealthAlert(error) {
    try {
      const slackWebhookService = require('./slackWebhookService');
      
      const message = `**CRITICAL: Sync Health Check Failed**

**Error:** ${error.message}
**Service:** stellar-indexer
**Timestamp:** ${new Date().toISOString()}

**Impact:** Unable to monitor sync status. Manual intervention required.

**Immediate Action Required:**
1. Check Stellar RPC connectivity
2. Verify database connectivity
3. Restart indexer service if necessary`;

      await slackWebhookService.sendAlert(message, {
        channel: '#critical-alerts',
        username: 'Sync Health Monitor',
        icon_emoji: ':rotating_light:',
        priority: 'critical'
      });

    } catch (alertError) {
      logger.error('Failed to send critical health alert:', alertError);
    }
  }

  /**
   * Clear cached health check results
   */
  clearCache() {
    this.cachedResult = null;
    this.lastHealthCheck = null;
    logger.info('Health check cache cleared');
  }

  /**
   * Update health check configuration
   * @param {Object} config - New configuration
   */
  updateConfig(config) {
    if (config.healthyThreshold !== undefined) {
      this.healthyThreshold = config.healthyThreshold;
    }
    if (config.cacheTimeout !== undefined) {
      this.cacheTimeout = config.cacheTimeout;
    }
    if (config.stellarRpcUrl !== undefined) {
      this.stellarRpcUrl = config.stellarRpcUrl;
    }
    
    logger.info('Sync health check configuration updated:', {
      healthyThreshold: this.healthyThreshold,
      cacheTimeout: this.cacheTimeout,
      stellarRpcUrl: this.stellarRpcUrl ? 'configured' : 'not configured'
    });
  }

  /**
   * Get current configuration
   * @returns {Object} Current configuration
   */
  getConfig() {
    return {
      healthyThreshold: this.healthyThreshold,
      cacheTimeout: this.cacheTimeout,
      stellarRpcUrl: this.stellarRpcUrl ? 'configured' : 'not configured'
    };
  }
}

module.exports = new SyncHealthCheckService();
