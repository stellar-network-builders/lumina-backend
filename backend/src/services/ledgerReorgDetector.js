const logger = require('../utils/logger');
const { sequelize } = require('../database/connection');
const { SorobanEvent, IndexerState, ClaimsHistory, SubSchedule } = require('../models');
const { Op } = require('sequelize');
const Sentry = require('@sentry/node');

class LedgerReorgDetector {
  constructor(options = {}) {
    this.serviceName = 'ledger-reorg-detector';
    this.maxReorgDepth = options.maxReorgDepth || 100; // Maximum reorg depth to detect
    this.finalityThreshold = options.finalityThreshold || 32; // Ledgers to wait for finality
    this.gapDetectionThreshold = options.gapDetectionThreshold || 3; // Consecutive gaps before alert
    this.checkInterval = options.checkInterval || 60000; // Check every minute
    this.isRunning = false;
    this.lastCheckTime = null;
    this.consecutiveGaps = 0;
    this.ledgerHashes = new Map(); // Cache of ledger hashes for fork detection
  }

  /**
   * Start the reorg detection service
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Ledger Reorg Detector is already running');
      return;
    }

    logger.info('Starting Ledger Reorg Detector...');
    this.isRunning = true;
    this.lastCheckTime = Date.now();

    // Run initial check
    await this.performReorgCheck();

    // Schedule regular checks
    this.intervalId = setInterval(() => {
      this.performReorgCheck().catch(error => {
        logger.error('Error in reorg detection check:', error);
        Sentry.captureException(error, {
          tags: { service: this.serviceName, operation: 'scheduled_check' }
        });
      });
    }, this.checkInterval);

    logger.info(`Ledger Reorg Detector started - checking every ${this.checkInterval/1000} seconds`);
  }

  /**
   * Stop the reorg detection service
   */
  async stop() {
    if (!this.isRunning) {
      logger.warn('Ledger Reorg Detector is not running');
      return;
    }

    logger.info('Stopping Ledger Reorg Detector...');
    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    logger.info('Ledger Reorg Detector stopped');
  }

  /**
   * Perform comprehensive reorg detection check
   */
  async performReorgCheck() {
    if (!this.isRunning) return;

    const checkId = `reorg_check_${Date.now()}`;
    const startTime = Date.now();

    try {
      logger.info(`[${checkId}] Starting reorg detection check...`);

      // Get current network state
      const networkState = await this.getNetworkState();
      
      // Get our last processed ledger
      const lastProcessedLedger = await this.getLastProcessedLedger();
      
      // Check for gaps and inconsistencies
      const issues = await this.detectIssues(networkState, lastProcessedLedger);
      
      // Handle detected issues
      if (issues.length > 0) {
        await this.handleDetectedIssues(issues, checkId);
      }

      // Update ledger hash cache
      await this.updateLedgerHashCache(networkState);

      const duration = Date.now() - startTime;
      logger.info(`[${checkId}] Reorg check completed in ${duration}ms - found ${issues.length} issues`);

      return { checkId, issues, duration };

    } catch (error) {
      logger.error(`[${checkId}] Critical error in reorg check:`, error);
      Sentry.captureException(error, {
        tags: { service: this.serviceName, operation: 'reorg_check' },
        extra: { check_id: checkId }
      });
      throw error;
    }
  }

  /**
   * Get current network state from RPC
   */
  async getNetworkState() {
    const SorobanRpcClient = require('./sorobanRpcClient');
    
    const rpcUrl = process.env.SOROBAN_RPC_URL || process.env.STELLAR_RPC_URL;
    if (!rpcUrl) {
      throw new Error('SOROBAN_RPC_URL or STELLAR_RPC_URL environment variable is required');
    }

    const rpcClient = new SorobanRpcClient(rpcUrl);
    
    // Get latest ledger info
    const latestLedger = await rpcClient.getLatestLedger();
    
    // Get recent ledger hashes for fork detection
    const ledgerHashes = await this.getRecentLedgerHashes(rpcClient, latestLedger.sequence);

    return {
      latestSequence: latestLedger.sequence,
      latestHash: latestLedger.hash,
      timestamp: latestLedger.timestamp,
      ledgerHashes
    };
  }

  /**
   * Get recent ledger hashes for fork detection
   */
  async getRecentLedgerHashes(rpcClient, latestSequence) {
    const hashes = new Map();
    const startSequence = Math.max(1, latestSequence - this.maxReorgDepth);

    for (let seq = startSequence; seq <= latestSequence; seq++) {
      try {
        const ledger = await rpcClient.call('getLedger', { sequence: seq });
        hashes.set(seq, ledger.hash);
      } catch (error) {
        // Some ledgers might not be available, continue with what we have
        logger.warn(`Could not fetch ledger ${seq}: ${error.message}`);
      }
    }

    return hashes;
  }

  /**
   * Detect various types of issues (gaps, forks, inconsistencies)
   */
  async detectIssues(networkState, lastProcessedLedger) {
    const issues = [];

    // 1. Check for ledger gaps
    const gapIssues = await this.detectLedgerGaps(networkState, lastProcessedLedger);
    issues.push(...gapIssues);

    // 2. Check for forks using ledger hashes
    const forkIssues = await this.detectForks(networkState);
    issues.push(...forkIssues);

    // 3. Check for sequence inconsistencies
    const sequenceIssues = await this.detectSequenceInconsistencies(networkState, lastProcessedLedger);
    issues.push(...sequenceIssues);

    // 4. Check for orphaned events
    const orphanedIssues = await this.detectOrphanedEvents(networkState);
    issues.push(...orphanedIssues);

    return issues;
  }

  /**
   * Detect gaps in ledger sequences
   */
  async detectLedgerGaps(networkState, lastProcessedLedger) {
    const issues = [];

    if (lastProcessedLedger === 0) {
      return issues; // No history to check against
    }

    const expectedSequence = lastProcessedLedger + 1;
    const actualSequence = networkState.latestSequence;

    if (actualSequence < expectedSequence) {
      // We're ahead of the network - possible rollback
      issues.push({
        type: 'ROLLBACK_DETECTED',
        severity: 'HIGH',
        description: `Network sequence (${actualSequence}) is behind our last processed (${expectedSequence})`,
        data: {
          expectedSequence,
          actualSequence,
          gap: expectedSequence - actualSequence
        }
      });
    } else if (actualSequence > expectedSequence + this.gapDetectionThreshold) {
      // Large gap detected
      issues.push({
        type: 'LEDGER_GAP',
        severity: 'MEDIUM',
        description: `Large gap detected: expected ${expectedSequence}, got ${actualSequence}`,
        data: {
          expectedSequence,
          actualSequence,
          gap: actualSequence - expectedSequence
        }
      });
    }

    return issues;
  }

  /**
   * Detect forks using ledger hash comparison
   */
  async detectForks(networkState) {
    const issues = [];

    for (const [sequence, cachedHash] of this.ledgerHashes) {
      const networkHash = networkState.ledgerHashes.get(sequence);
      
      if (networkHash && networkHash !== cachedHash) {
        // Fork detected at this sequence
        issues.push({
          type: 'FORK_DETECTED',
          severity: 'HIGH',
          description: `Fork detected at ledger ${sequence}: cached hash differs from network`,
          data: {
            sequence,
            cachedHash,
            networkHash
          }
        });
      }
    }

    return issues;
  }

  /**
   * Detect sequence inconsistencies in database
   */
  async detectSequenceInconsistencies(networkState, lastProcessedLedger) {
    const issues = [];

    // Check SorobanEvents for sequence consistency
    const eventSequences = await SorobanEvent.findAll({
      attributes: ['ledger_sequence'],
      where: {
        ledger_sequence: {
          [Op.gte]: Math.max(1, lastProcessedLedger - 100)
        }
      },
      order: [['ledger_sequence', 'ASC']]
    });

    // Look for duplicate or out-of-order sequences
    const seenSequences = new Set();
    let lastSequence = 0;

    for (const event of eventSequences) {
      const sequence = event.ledger_sequence;

      if (seenSequences.has(sequence)) {
        issues.push({
          type: 'DUPLICATE_SEQUENCE',
          severity: 'HIGH',
          description: `Duplicate ledger sequence found: ${sequence}`,
          data: { sequence }
        });
      }

      if (sequence < lastSequence) {
        issues.push({
          type: 'OUT_OF_ORDER_SEQUENCE',
          severity: 'MEDIUM',
          description: `Out-of-order sequence: ${sequence} after ${lastSequence}`,
          data: { sequence, lastSequence }
        });
      }

      seenSequences.add(sequence);
      lastSequence = sequence;
    }

    return issues;
  }

  /**
   * Detect orphaned events that might be from a fork
   */
  async detectOrphanedEvents(networkState) {
    const issues = [];

    // Find events with sequences beyond the current network state
    const orphanedEvents = await SorobanEvent.findAll({
      where: {
        ledger_sequence: {
          [Op.gt]: networkState.latestSequence
        }
      },
      limit: 10
    });

    if (orphanedEvents.length > 0) {
      issues.push({
        type: 'ORPHANED_EVENTS',
        severity: 'HIGH',
        description: `Found ${orphanedEvents.length} events with sequences beyond network state`,
        data: {
          count: orphanedEvents.length,
          events: orphanedEvents.map(e => ({
            id: e.id,
            sequence: e.ledger_sequence,
            type: e.event_type
          }))
        }
      });
    }

    return issues;
  }

  /**
   * Handle detected issues
   */
  async handleDetectedIssues(issues, checkId) {
    logger.info(`[${checkId}] Handling ${issues.length} detected issues...`);

    for (const issue of issues) {
      try {
        await this.handleIssue(issue, checkId);
      } catch (error) {
        logger.error(`[${checkId}] Failed to handle issue ${issue.type}:`, error);
        Sentry.captureException(error, {
          tags: { 
            service: this.serviceName, 
            issue_type: issue.type,
            severity: issue.severity
          },
          extra: { issue, check_id: checkId }
        });
      }
    }
  }

  /**
   * Handle individual issue based on type and severity
   */
  async handleIssue(issue, checkId) {
    logger.info(`[${checkId}] Handling ${issue.type} (${issue.severity}): ${issue.description}`);

    switch (issue.type) {
      case 'ROLLBACK_DETECTED':
        await this.handleRollback(issue, checkId);
        break;
      
      case 'FORK_DETECTED':
        await this.handleFork(issue, checkId);
        break;
      
      case 'LEDGER_GAP':
        await this.handleLedgerGap(issue, checkId);
        break;
      
      case 'DUPLICATE_SEQUENCE':
      case 'OUT_OF_ORDER_SEQUENCE':
        await this.handleSequenceInconsistency(issue, checkId);
        break;
      
      case 'ORPHANED_EVENTS':
        await this.handleOrphanedEvents(issue, checkId);
        break;
      
      default:
        logger.warn(`[${checkId}] Unknown issue type: ${issue.type}`);
    }
  }

  /**
   * Handle rollback scenario
   */
  async handleRollback(issue, checkId) {
    const { expectedSequence, actualSequence, gap } = issue.data;
    
    logger.info(`[${checkId}] Rollback detected: rolling back ${gap} ledgers to ${actualSequence}`);
    
    // Use existing rollback mechanism
    const stellarIngestionService = require('./stellarIngestionService');
    const rollbackResult = await stellarIngestionService.rollbackToLedger(actualSequence);
    
    // Also rollback Soroban events
    await this.rollbackSorobanEvents(actualSequence);
    
    // Clear ledger hash cache beyond rollback point
    this.clearLedgerHashCache(actualSequence);
    
    logger.info(`[${checkId}] Rollback completed:`, rollbackResult);
    
    // Send alert
    await this.sendReorgAlert(issue, checkId, rollbackResult);
  }

  /**
   * Handle fork scenario
   */
  async handleFork(issue, checkId) {
    const { sequence, cachedHash, networkHash } = issue.data;
    
    logger.info(`[${checkId}] Fork detected at ledger ${sequence}, rolling back to safe point`);
    
    // Roll back to a safe point before the fork
    const safeSequence = Math.max(1, sequence - this.finalityThreshold);
    
    const stellarIngestionService = require('./stellarIngestionService');
    const rollbackResult = await stellarIngestionService.rollbackToLedger(safeSequence);
    
    await this.rollbackSorobanEvents(safeSequence);
    this.clearLedgerHashCache(safeSequence);
    
    logger.info(`[${checkId}] Fork handling completed:`, rollbackResult);
    
    // Send critical alert
    await this.sendCriticalAlert(issue, checkId, rollbackResult);
  }

  /**
   * Handle ledger gap
   */
  async handleLedgerGap(issue, checkId) {
    const { expectedSequence, actualSequence, gap } = issue.data;
    
    if (gap > this.maxReorgDepth) {
      // Gap is too large, treat as potential fork
      logger.info(`[${checkId}] Large gap (${gap}) detected, treating as potential fork`);
      await this.handleFork({
        type: 'LARGE_GAP_TREATED_AS_FORK',
        severity: 'HIGH',
        description: `Large gap treated as fork`,
        data: issue.data
      }, checkId);
    } else {
      // Small gap, might be temporary network issue
      logger.info(`[${checkId}] Small gap detected, monitoring...`);
      this.consecutiveGaps++;
      
      if (this.consecutiveGaps >= 3) {
        // Multiple consecutive gaps, treat as issue
        await this.sendGapAlert(issue, checkId);
      }
    }
  }

  /**
   * Handle sequence inconsistency
   */
  async handleSequenceInconsistency(issue, checkId) {
    logger.info(`[${checkId}] Sequence inconsistency detected, investigating...`);
    
    // For now, log and alert - could be enhanced with specific handling
    await this.sendSequenceAlert(issue, checkId);
  }

  /**
   * Handle orphaned events
   */
  async handleOrphanedEvents(issue, checkId) {
    const { events } = issue.data;
    
    logger.info(`[${checkId}] Cleaning up ${events.length} orphaned events...`);
    
    // Delete orphaned events
    const eventIds = events.map(e => e.id);
    const deletedCount = await SorobanEvent.destroy({
      where: {
        id: eventIds
      }
    });
    
    logger.info(`[${checkId}] Deleted ${deletedCount} orphaned events`);
    
    await this.sendOrphanedEventsAlert(issue, checkId, deletedCount);
  }

  /**
   * Rollback Soroban events to specific sequence
   */
  async rollbackSorobanEvents(targetSequence) {
    const deletedCount = await SorobanEvent.destroy({
      where: {
        ledger_sequence: {
          [Op.gt]: targetSequence
        }
      }
    });
    
    logger.info(`Rolled back ${deletedCount} Soroban events to ledger ${targetSequence}`);
    return deletedCount;
  }

  /**
   * Update ledger hash cache
   */
  async updateLedgerHashCache(networkState) {
    // Add new ledger hashes
    for (const [sequence, hash] of networkState.ledgerHashes) {
      this.ledgerHashes.set(sequence, hash);
    }
    
    // Remove old hashes beyond cache size
    const minSequence = networkState.latestSequence - this.maxReorgDepth;
    for (const [sequence] of this.ledgerHashes) {
      if (sequence < minSequence) {
        this.ledgerHashes.delete(sequence);
      }
    }
  }

  /**
   * Clear ledger hash cache beyond sequence
   */
  clearLedgerHashCache(sequence) {
    for (const [seq] of this.ledgerHashes) {
      if (seq > sequence) {
        this.ledgerHashes.delete(seq);
      }
    }
  }

  /**
   * Get last processed ledger
   */
  async getLastProcessedLedger() {
    try {
      const state = await IndexerState.findByPk(this.serviceName);
      if (state) {
        return state.last_ingested_ledger;
      }
      return 0;
    } catch (error) {
      logger.error('Error fetching last processed ledger:', error);
      throw error;
    }
  }

  /**
   * Update last processed ledger
   */
  async updateLastProcessedLedger(sequence) {
    try {
      const [state, created] = await IndexerState.findOrCreate({
        where: { service_name: this.serviceName },
        defaults: {
          last_ingested_ledger: sequence,
        }
      });

      if (!created) {
        state.last_ingested_ledger = sequence;
        await state.save();
      }
    } catch (error) {
      logger.error('Error updating last processed ledger:', error);
      throw error;
    }
  }

  /**
   * Send reorg alert
   */
  async sendReorgAlert(issue, checkId, rollbackResult) {
    const slackWebhookService = require('./slackWebhookService');
    
    const message = `**Ledger Reorganization Detected**

**Check ID:** ${checkId}
**Issue Type:** ${issue.type}
**Severity:** ${issue.severity}
**Description:** ${issue.description}

**Rollback Details:**
- Expected Sequence: ${issue.data.expectedSequence}
- Actual Sequence: ${issue.data.actualSequence}
- Gap: ${issue.data.gap} ledgers

**Cleanup Results:**
- Claims Rolled Back: ${rollbackResult.deletedClaims}
- SubSchedules Rolled Back: ${rollbackResult.deletedSchedules}
- New Head: ${rollbackResult.newHead}

**Action Taken:** Automatic rollback to safe ledger sequence`;

    await slackWebhookService.sendAlert(message, {
      channel: '#alerts',
      username: 'Ledger Reorg Detector',
      icon_emoji: ':warning:',
      priority: 'high'
    });
  }

  /**
   * Send critical alert for forks
   */
  async sendCriticalAlert(issue, checkId, rollbackResult) {
    const slackWebhookService = require('./slackWebhookService');
    
    const message = `**CRITICAL: Ledger Fork Detected**

**Check ID:** ${checkId}
**Issue Type:** ${issue.type}
**Severity:** ${issue.severity}
**Description:** ${issue.description}

**Fork Details:**
- Fork Sequence: ${issue.data.sequence}
- Cached Hash: ${issue.data.cachedHash}
- Network Hash: ${issue.data.networkHash}

**Emergency Action Taken:** Automatic rollback to safe ledger sequence
**New Head:** ${rollbackResult.newHead}

**IMMEDIATE ATTENTION REQUIRED:** Investigate network state and RPC endpoint integrity`;

    await slackWebhookService.sendAlert(message, {
      channel: '#critical-alerts',
      username: 'Ledger Reorg Detector',
      icon_emoji: ':rotating_light:',
      priority: 'critical'
    });
  }

  /**
   * Send gap alert
   */
  async sendGapAlert(issue, checkId) {
    const slackWebhookService = require('./slackWebhookService');
    
    const message = `**Ledger Gap Alert**

**Check ID:** ${checkId}
**Issue Type:** ${issue.type}
**Severity:** ${issue.severity}
**Description:** ${issue.description}

**Gap Details:**
- Expected: ${issue.data.expectedSequence}
- Actual: ${issue.data.actualSequence}
- Gap: ${issue.data.gap} ledgers
- Consecutive Gaps: ${this.consecutiveGaps}

**Status:** Monitoring for resolution`;

    await slackWebhookService.sendAlert(message, {
      channel: '#alerts',
      username: 'Ledger Reorg Detector',
      priority: 'medium'
    });
  }

  /**
   * Send sequence alert
   */
  async sendSequenceAlert(issue, checkId) {
    const slackWebhookService = require('./slackWebhookService');
    
    const message = `**Sequence Inconsistency Alert**

**Check ID:** ${checkId}
**Issue Type:** ${issue.type}
**Severity:** ${issue.severity}
**Description:** ${issue.description}

**Investigation required for database integrity`;

    await slackWebhookService.sendAlert(message, {
      channel: '#alerts',
      username: 'Ledger Reorg Detector',
      priority: 'medium'
    });
  }

  /**
   * Send orphaned events alert
   */
  async sendOrphanedEventsAlert(issue, checkId, deletedCount) {
    const slackWebhookService = require('./slackWebhookService');
    
    const message = `**Orphaned Events Cleaned**

**Check ID:** ${checkId}
**Issue Type:** ${issue.type}
**Severity:** ${issue.severity}
**Description:** ${issue.description}

**Cleanup Results:**
- Events Found: ${issue.data.count}
- Events Deleted: ${deletedCount}

**Action Taken:** Automatic cleanup of orphaned events`;

    await slackWebhookService.sendAlert(message, {
      channel: '#alerts',
      username: 'Ledger Reorg Detector',
      priority: 'low'
    });
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      checkInterval: this.checkInterval,
      maxReorgDepth: this.maxReorgDepth,
      finalityThreshold: this.finalityThreshold,
      consecutiveGaps: this.consecutiveGaps,
      ledgerHashesCacheSize: this.ledgerHashes.size,
      lastCheckTime: this.lastCheckTime,
      uptime: this.isRunning ? Date.now() - this.startTime : 0
    };
  }

  /**
   * Manually trigger reorg check
   */
  async triggerCheck() {
    return this.performReorgCheck();
  }

  /**
   * Get recent issues
   */
  async getRecentIssues(limit = 10) {
    // This would typically query a logs table or recent issues storage
    // For now, return a placeholder
    return [];
  }
}

module.exports = LedgerReorgDetector;
