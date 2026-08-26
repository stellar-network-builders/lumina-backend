const logger = require('../utils/logger');
const { Vault, Beneficiary } = require('../models');
const Sentry = require('@sentry/node');
const slackWebhookService = require('./slackWebhookService');
const cacheService = require('./cacheService');
const axios = require('axios');

class LedgerSyncService {
  constructor() {
    this.isRunning = false;
    this.checkInterval = 60000; // 60 seconds
    this.toleranceThreshold = 0.0000001; // 0.0000001 tokens tolerance
    this.pausedVaults = new Set(); // Track paused vaults
    this.inconsistencyHistory = new Map(); // Track inconsistency patterns
    this.maxRetries = 3;
    this.rpcTimeout = 10000; // 10 seconds timeout for RPC calls
  }

  /**
   * Start the ledger sync consistency checker
   */
  start() {
    if (this.isRunning) {
      logger.warn('Ledger Sync Service is already running');
      return;
    }

    logger.info('🔍 Starting Ledger Sync Consistency Checker...');
    this.isRunning = true;
    
    // Run initial check immediately
    this.performConsistencyCheck();
    
    // Schedule regular checks
    this.intervalId = setInterval(() => {
      this.performConsistencyCheck();
    }, this.checkInterval);

    logger.info(`✅ Ledger Sync Checker started - checking every ${this.checkInterval/1000} seconds`);
  }

  /**
   * Stop the ledger sync consistency checker
   */
  stop() {
    if (!this.isRunning) {
      logger.warn('Ledger Sync Service is not running');
      return;
    }

    logger.info('🛑 Stopping Ledger Sync Consistency Checker...');
    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    logger.info('✅ Ledger Sync Checker stopped');
  }

  /**
   * Perform consistency check for all active vaults
   */
  async performConsistencyCheck() {
    if (!this.isRunning) return;

    const startTime = Date.now();
    const checkId = `check_${startTime}`;
    
    try {
      logger.info(`🔍 [${checkId}] Starting consistency check...`);
      
      // Get all active vaults
      const vaults = await Vault.findAll({
        where: {
          // Add any criteria for active vaults
        },
        attributes: ['id', 'address', 'name', 'token_address', 'total_amount']
      });

      logger.info(`📊 [${checkId}] Checking ${vaults.length} vaults`);

      const results = {
        total: vaults.length,
        consistent: 0,
        inconsistent: 0,
        errors: 0,
        paused: 0,
        details: []
      };

      // Check each vault concurrently with a limit to avoid overwhelming RPC
      const concurrencyLimit = 10;
      const chunks = this.chunkArray(vaults, concurrencyLimit);
      
      for (const chunk of chunks) {
        const chunkResults = await Promise.allSettled(
          chunk.map(vault => this.checkVaultConsistency(vault, checkId))
        );
        
        // Process chunk results
        chunkResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            const vaultResult = result.value;
            results.details.push(vaultResult);
            
            if (vaultResult.status === 'consistent') {
              results.consistent++;
            } else if (vaultResult.status === 'inconsistent') {
              results.inconsistent++;
            } else if (vaultResult.status === 'paused') {
              results.paused++;
            }
          } else {
            results.errors++;
            logger.error(`❌ [${checkId}] Error checking vault ${chunk[index].address}:`, result.reason);
            Sentry.captureException(result.reason, {
              tags: { service: 'ledger-sync', vault_address: chunk[index].address },
              extra: { check_id: checkId }
            });
          }
        });
      }

      const duration = Date.now() - startTime;
      logger.info(`✅ [${checkId}] Consistency check completed in ${duration}ms:`, {
        total: results.total,
        consistent: results.consistent,
        inconsistent: results.inconsistent,
        errors: results.errors,
        paused: results.paused
      });

      // Cache results for monitoring
      await cacheService.set(`ledger_sync:${checkId}`, results, 300); // 5 minutes

      // Send summary alert if there are issues
      if (results.inconsistent > 0 || results.errors > 0) {
        await this.sendSummaryAlert(checkId, results);
      }

      return results;

    } catch (error) {
      logger.error(`❌ [${checkId}] Critical error in consistency check:`, error);
      Sentry.captureException(error, {
        tags: { service: 'ledger-sync' },
        extra: { check_id: checkId }
      });
      
      // Send critical alert
      await this.sendCriticalAlert(checkId, error);
    }
  }

  /**
   * Check consistency for a single vault
   */
  async checkVaultConsistency(vault, checkId) {
    const vaultAddress = vault.address;
    const vaultId = vault.id;
    
    try {
      // Skip if vault is already paused
      if (this.pausedVaults.has(vaultAddress)) {
        return {
          vaultId,
          vaultAddress,
          vaultName: vault.name,
          status: 'paused',
          reason: 'Previously paused due to inconsistency',
          databaseBalance: vault.total_amount.toString(),
          blockchainBalance: null,
          drift: null,
          checkId
        };
      }

      // Get database balance
      const databaseBalance = parseFloat(vault.total_amount.toString());
      
      // Get blockchain balance with retries
      const blockchainBalance = await this.getBlockchainBalance(vaultAddress, vault.token_address);
      
      // Calculate drift
      const drift = Math.abs(databaseBalance - blockchainBalance);
      
      // Check if drift exceeds tolerance
      const isConsistent = drift <= this.toleranceThreshold;
      
      if (!isConsistent) {
        // Handle inconsistency
        return await this.handleInconsistency(vault, databaseBalance, blockchainBalance, drift, checkId);
      }

      // Vault is consistent - unpause if it was previously paused
      if (this.pausedVaults.has(vaultAddress)) {
        await this.unpauseVault(vaultAddress, 'Balance consistency restored');
      }

      return {
        vaultId,
        vaultAddress,
        vaultName: vault.name,
        status: 'consistent',
        databaseBalance: databaseBalance.toString(),
        blockchainBalance: blockchainBalance.toString(),
        drift: drift.toString(),
        tolerance: this.toleranceThreshold.toString(),
        checkId
      };

    } catch (error) {
      logger.error(`❌ [${checkId}] Error checking vault ${vaultAddress}:`, error);
      throw error;
    }
  }

  /**
   * Get blockchain balance from Soroban contract
   */
  async getBlockchainBalance(vaultAddress, tokenAddress, retryCount = 0) {
    try {
      const stellarRpcUrl = process.env.STELLAR_RPC_URL || process.env.SOROBAN_RPC_URL;
      if (!stellarRpcUrl) {
        throw new Error('Stellar RPC URL not configured');
      }

      // Prepare the RPC request to get contract balance
      const requestBody = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "getLedgerEntry",
        params: {
          // This would need to be adapted based on actual Soroban contract structure
          contract: vaultAddress,
          key: "balance" // This might need to be different based on contract
        }
      };

      const response = await axios.post(stellarRpcUrl, requestBody, {
        timeout: this.rpcTimeout,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response.data.error) {
        throw new Error(`RPC Error: ${response.data.error.message}`);
      }

      // Parse the balance from the response
      // This would need to be adapted based on actual contract response format
      const balance = this.parseBalanceFromResponse(response.data.result);
      
      return balance;

    } catch (error) {
      if (retryCount < this.maxRetries) {
        logger.warn(`⚠️ Retry ${retryCount + 1}/${this.maxRetries} for vault ${vaultAddress}`);
        await this.delay(1000 * (retryCount + 1)); // Exponential backoff
        return this.getBlockchainBalance(vaultAddress, tokenAddress, retryCount + 1);
      }
      
      throw new Error(`Failed to get blockchain balance after ${this.maxRetries} retries: ${error.message}`);
    }
  }

  /**
   * Parse balance from RPC response
   * This would need to be implemented based on actual Soroban contract response format
   */
  parseBalanceFromResponse(result) {
    try {
      // This is a placeholder implementation
      // The actual implementation would depend on the Soroban contract structure
      if (result && result.data && result.data.value) {
        // Assuming the balance is stored as a string or number
        const balanceStr = result.data.value.toString();
        return parseFloat(balanceStr);
      }
      
      // Alternative parsing based on common Stellar/Soroban patterns
      if (result && result.xdr) {
        // Parse XDR data - would need proper XDR library
        // For now, return 0 as placeholder
        logger.warn('XDR parsing not implemented, returning 0');
        return 0;
      }
      
      throw new Error('Unable to parse balance from RPC response');
      
    } catch (error) {
      logger.error('Error parsing balance:', error);
      throw new Error(`Balance parsing failed: ${error.message}`);
    }
  }

  /**
   * Handle vault inconsistency
   */
  async handleInconsistency(vault, databaseBalance, blockchainBalance, drift, checkId) {
    const vaultAddress = vault.address;
    const vaultId = vault.id;
    
    logger.error(`🚨 [${checkId}] INCONSISTENCY DETECTED - Vault: ${vaultAddress}, Drift: ${drift}`);
    
    // Track inconsistency history
    const history = this.inconsistencyHistory.get(vaultAddress) || [];
    history.push({
      timestamp: Date.now(),
      databaseBalance,
      blockchainBalance,
      drift,
      checkId
    });
    
    // Keep only last 10 inconsistencies
    if (history.length > 10) {
      history.shift();
    }
    
    this.inconsistencyHistory.set(vaultAddress, history);
    
    // Pause the vault API
    await this.pauseVault(vaultAddress, 'Balance inconsistency detected');
    
    // Send immediate alert
    await this.sendInconsistencyAlert(vault, databaseBalance, blockchainBalance, drift, checkId, history);
    
    // Log to Sentry with high severity
    Sentry.captureMessage(`CRITICAL: Ledger sync inconsistency detected`, {
      level: 'fatal',
      tags: { 
        service: 'ledger-sync', 
        vault_address: vaultAddress,
        severity: 'critical'
      },
      extra: {
        vault_id: vaultId,
        vault_name: vault.name,
        database_balance: databaseBalance,
        blockchain_balance: blockchainBalance,
        drift,
        tolerance: this.toleranceThreshold,
        check_id: checkId,
        inconsistency_history: history
      }
    });
    
    return {
      vaultId,
      vaultAddress,
      vaultName: vault.name,
      status: 'inconsistent',
      databaseBalance: databaseBalance.toString(),
      blockchainBalance: blockchainBalance.toString(),
      drift: drift.toString(),
      tolerance: this.toleranceThreshold.toString(),
      action: 'PAUSED',
      alertSent: true,
      checkId
    };
  }

  /**
   * Pause vault API access
   */
  async pauseVault(vaultAddress, reason) {
    try {
      // Add to paused vaults set
      this.pausedVaults.add(vaultAddress);
      
      // Store pause info in cache for persistence across restarts
      await cacheService.set(`paused_vault:${vaultAddress}`, {
        paused: true,
        reason,
        pausedAt: Date.now()
      }, 86400); // 24 hours
      
      logger.info(`🔒 Vault ${vaultAddress} PAUSED: ${reason}`);
      
      // Update vault status in database if needed
      // await Vault.update({ status: 'paused' }, { where: { address: vaultAddress } });
      
    } catch (error) {
      logger.error(`❌ Failed to pause vault ${vaultAddress}:`, error);
      Sentry.captureException(error, {
        tags: { service: 'ledger-sync', action: 'pause_vault' },
        extra: { vault_address: vaultAddress, reason }
      });
    }
  }

  /**
   * Unpause vault API access
   */
  async unpauseVault(vaultAddress, reason) {
    try {
      // Remove from paused vaults set
      this.pausedVaults.delete(vaultAddress);
      
      // Remove from cache
      await cacheService.del(`paused_vault:${vaultAddress}`);
      
      logger.info(`✅ Vault ${vaultAddress} UNPAUSED: ${reason}`);
      
      // Update vault status in database if needed
      // await Vault.update({ status: 'active' }, { where: { address: vaultAddress } });
      
    } catch (error) {
      logger.error(`❌ Failed to unpause vault ${vaultAddress}:`, error);
      Sentry.captureException(error, {
        tags: { service: 'ledger-sync', action: 'unpause_vault' },
        extra: { vault_address: vaultAddress, reason }
      });
    }
  }

  /**
   * Check if vault is paused
   */
  isVaultPaused(vaultAddress) {
    return this.pausedVaults.has(vaultAddress);
  }

  /**
   * Get all paused vaults
   */
  getPausedVaults() {
    return Array.from(this.pausedVaults);
  }

  /**
   * Load paused vaults from cache on startup
   */
  async loadPausedVaults() {
    try {
      // This would need to scan cache for paused_vault:* keys
      // For now, we'll use a simple approach
      logger.info('🔄 Loading paused vaults from cache...');
      // Implementation would depend on cache service capabilities
    } catch (error) {
      logger.error('❌ Failed to load paused vaults:', error);
    }
  }

  /**
   * Send inconsistency alert
   */
  async sendInconsistencyAlert(vault, databaseBalance, blockchainBalance, drift, checkId, history) {
    try {
      const message = `🚨 **CRITICAL: Ledger Sync Inconsistency Detected**

**Vault:** ${vault.name} (${vault.address})
**Drift:** ${drift.toFixed(10)} tokens
**Database Balance:** ${databaseBalance.toFixed(10)}
**Blockchain Balance:** ${blockchainBalance.toFixed(10)}
**Tolerance:** ${this.toleranceThreshold}
**Check ID:** ${checkId}

**Action Taken:** Vault API has been PAUSED
**Previous Inconsistencies:** ${history.length} in the last checks

**Immediate Action Required:**
1. Verify blockchain state
2. Check database integrity
3. Investigate indexing service
4. Manual sync may be required

This prevents "Phantom Liquidity" exposure to investors.`;

      await slackWebhookService.sendAlert(message, {
        channel: '#critical-alerts',
        username: 'Ledger Sync Monitor',
        icon_emoji: ':warning:',
        priority: 'high'
      });

      logger.info(`📢 Inconsistency alert sent for vault ${vault.address}`);
      
    } catch (error) {
      logger.error('❌ Failed to send inconsistency alert:', error);
    }
  }

  /**
   * Send summary alert
   */
  async sendSummaryAlert(checkId, results) {
    try {
      if (results.inconsistent === 0 && results.errors === 0) return;

      const message = `📊 **Ledger Sync Check Summary**

**Check ID:** ${checkId}
**Total Vaults:** ${results.total}
**Consistent:** ${results.consistent}
**Inconsistent:** ${results.inconsistent}
**Errors:** ${results.errors}
**Paused:** ${results.paused}

${results.inconsistent > 0 ? `⚠️ ${results.inconsistent} vaults have been paused due to inconsistencies.` : ''}
${results.errors > 0 ? `❌ ${results.errors} vaults had check errors.` : ''}`;

      await slackWebhookService.sendAlert(message, {
        channel: '#alerts',
        username: 'Ledger Sync Monitor',
        priority: results.inconsistent > 0 ? 'high' : 'medium'
      });

    } catch (error) {
      logger.error('❌ Failed to send summary alert:', error);
    }
  }

  /**
   * Send critical alert
   */
  async sendCriticalAlert(checkId, error) {
    try {
      const message = `🚨 **CRITICAL: Ledger Sync Service Failure**

**Check ID:** ${checkId}
**Error:** ${error.message}
**Service Status:** ${this.isRunning ? 'Running' : 'Stopped'}

**Impact:** All vault consistency checks are failing!
**Immediate Action Required:** Restart service and investigate root cause.`;

      await slackWebhookService.sendAlert(message, {
        channel: '#critical-alerts',
        username: 'Ledger Sync Monitor',
        icon_emoji: ':rotating_light:',
        priority: 'critical'
      });

    } catch (alertError) {
      logger.error('❌ Failed to send critical alert:', alertError);
    }
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.checkInterval,
      toleranceThreshold: this.toleranceThreshold,
      pausedVaultsCount: this.pausedVaults.size,
      pausedVaults: this.getPausedVaults(),
      inconsistencyHistoryCount: this.inconsistencyHistory.size,
      lastCheck: this.lastCheckTime,
      uptime: this.isRunning ? Date.now() - this.startTime : 0
    };
  }

  /**
   * Utility functions
   */
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new LedgerSyncService();
