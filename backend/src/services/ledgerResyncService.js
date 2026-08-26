const logger = require('../utils/logger');
const { sequelize } = require('../database/connection');
const { SorobanEvent, IndexerState, ClaimsHistory, SubSchedule } = require('../models');
const { Op } = require('sequelize');
const Sentry = require('@sentry/node');
const SorobanRpcClient = require('./sorobanRpcClient');

class LedgerResyncService {
  constructor(options = {}) {
    this.serviceName = 'ledger-resync-service';
    this.finalityThreshold = options.finalityThreshold || 32; // Ledgers to wait for finality
    this.resyncBatchSize = options.resyncBatchSize || 50; // Ledgers to process per batch
    this.maxResyncDepth = options.maxResyncDepth || 1000; // Maximum ledgers to resync
    this.resyncDelay = options.resyncDelay || 1000; // Delay between batches
    this.isResyncing = false;
    this.resyncProgress = null;
  }

  /**
   * Perform full resync from last finalized ledger
   */
  async performFullResync(options = {}) {
    if (this.isResyncing) {
      throw new Error('Resync already in progress');
    }

    const resyncId = `resync_${Date.now()}`;
    const startTime = Date.now();

    try {
      logger.info(`[${resyncId}] Starting full ledger resync...`);
      this.isResyncing = true;
      this.resyncProgress = { resyncId, startTime, status: 'STARTING' };

      // Get network state and determine safe starting point
      const networkState = await this.getNetworkState();
      const safeStartSequence = this.calculateSafeStartSequence(networkState);

      logger.info(`[${resyncId}] Safe start sequence: ${safeStartSequence}`);

      // Get current database state
      const currentDbState = await this.getCurrentDbState();
      
      // Determine rollback requirements
      const rollbackPlan = this.calculateRollbackPlan(currentDbState, safeStartSequence);
      
      if (rollbackPlan.needsRollback) {
        logger.info(`[${resyncId}] Rolling back ${rollbackPlan.rollbackDepth} ledgers...`);
        await this.executeRollback(rollbackPlan, resyncId);
      }

      // Perform resync
      const resyncResult = await this.executeResync(safeStartSequence, networkState.latestSequence, resyncId);

      const duration = Date.now() - startTime;
      logger.info(`[${resyncId}] Resync completed in ${duration}ms`);

      this.resyncProgress = {
        ...this.resyncProgress,
        status: 'COMPLETED',
        duration,
        result: resyncResult
      };

      return {
        resyncId,
        duration,
        rollbackPlan,
        resyncResult
      };

    } catch (error) {
      logger.error(`[${resyncId}] Resync failed:`, error);
      Sentry.captureException(error, {
        tags: { service: this.serviceName, operation: 'full_resync' },
        extra: { resync_id: resyncId }
      });

      this.resyncProgress = {
        ...this.resyncProgress,
        status: 'FAILED',
        error: error.message
      };

      throw error;
    } finally {
      this.isResyncing = false;
    }
  }

  /**
   * Get current network state
   */
  async getNetworkState() {
    const rpcUrl = process.env.SOROBAN_RPC_URL || process.env.STELLAR_RPC_URL;
    if (!rpcUrl) {
      throw new Error('SOROBAN_RPC_URL or STELLAR_RPC_URL environment variable is required');
    }

    const rpcClient = new SorobanRpcClient(rpcUrl);
    
    const latestLedger = await rpcClient.getLatestLedger();
    
    return {
      latestSequence: latestLedger.sequence,
      latestHash: latestLedger.hash,
      timestamp: latestLedger.timestamp,
      protocolVersion: latestLedger.protocolVersion
    };
  }

  /**
   * Calculate safe starting sequence for resync
   */
  calculateSafeStartSequence(networkState) {
    const safeSequence = Math.max(1, networkState.latestSequence - this.finalityThreshold);
    return safeSequence;
  }

  /**
   * Get current database state
   */
  async getCurrentDbState() {
    const [sorobanEventsCount, claimsHistoryCount, subSchedulesCount, indexerStates] = await Promise.all([
      SorobanEvent.max('ledger_sequence'),
      ClaimsHistory.max('block_number'),
      SubSchedule.max('block_number'),
      IndexerState.findAll()
    ]);

    const indexerStateMap = new Map();
    indexerStates.forEach(state => {
      indexerStateMap.set(state.service_name, state.last_ingested_ledger);
    });

    return {
      maxSorobanEventSequence: sorobanEventsCount || 0,
      maxClaimsHistorySequence: claimsHistoryCount || 0,
      maxSubScheduleSequence: subSchedulesCount || 0,
      indexerStates: indexerStateMap
    };
  }

  /**
   * Calculate rollback plan
   */
  calculateRollbackPlan(dbState, safeStartSequence) {
    const maxSequence = Math.max(
      dbState.maxSorobanEventSequence,
      dbState.maxClaimsHistorySequence,
      dbState.maxSubScheduleSequence
    );

    const needsRollback = maxSequence > safeStartSequence;
    const rollbackDepth = needsRollback ? maxSequence - safeStartSequence : 0;

    return {
      needsRollback,
      rollbackDepth,
      targetSequence: safeStartSequence,
      currentMaxSequence: maxSequence,
      affectedTables: this.getAffectedTables(dbState, safeStartSequence)
    };
  }

  /**
   * Get affected tables for rollback
   */
  getAffectedTables(dbState, safeStartSequence) {
    const affected = [];

    if (dbState.maxSorobanEventSequence > safeStartSequence) {
      affected.push({
        table: 'soroban_events',
        currentMax: dbState.maxSorobanEventSequence,
        recordsToRollback: dbState.maxSorobanEventSequence - safeStartSequence
      });
    }

    if (dbState.maxClaimsHistorySequence > safeStartSequence) {
      affected.push({
        table: 'claims_history',
        currentMax: dbState.maxClaimsHistorySequence,
        recordsToRollback: dbState.maxClaimsHistorySequence - safeStartSequence
      });
    }

    if (dbState.maxSubScheduleSequence > safeStartSequence) {
      affected.push({
        table: 'sub_schedules',
        currentMax: dbState.maxSubScheduleSequence,
        recordsToRollback: dbState.maxSubScheduleSequence - safeStartSequence
      });
    }

    return affected;
  }

  /**
   * Execute rollback plan
   */
  async executeRollback(rollbackPlan, resyncId) {
    const t = await sequelize.transaction();

    try {
      logger.info(`[${resyncId}] Executing rollback to ${rollbackPlan.targetSequence}...`);

      let totalDeleted = 0;

      // Rollback SorobanEvents
      const deletedEvents = await SorobanEvent.destroy({
        where: {
          ledger_sequence: {
            [Op.gt]: rollbackPlan.targetSequence
          }
        },
        transaction: t
      });
      totalDeleted += deletedEvents;
      logger.info(`[${resyncId}] Deleted ${deletedEvents} Soroban events`);

      // Rollback ClaimsHistory
      const deletedClaims = await ClaimsHistory.destroy({
        where: {
          block_number: {
            [Op.gt]: rollbackPlan.targetSequence
          }
        },
        transaction: t
      });
      totalDeleted += deletedClaims;
      logger.info(`[${resyncId}] Deleted ${deletedClaims} claims history records`);

      // Rollback SubSchedules
      const deletedSchedules = await SubSchedule.destroy({
        where: {
          block_number: {
            [Op.gt]: rollbackPlan.targetSequence
          }
        },
        transaction: t
      });
      totalDeleted += deletedSchedules;
      logger.info(`[${resyncId}] Deleted ${deletedSchedules} sub-schedule records`);

      // Update all indexer states
      for (const [serviceName, currentSequence] of rollbackPlan.affectedTables) {
        await IndexerState.update(
          { last_ingested_ledger: rollbackPlan.targetSequence },
          {
            where: { service_name: serviceName },
            transaction: t
          }
        );
      }

      await t.commit();

      logger.info(`[${resyncId}] Rollback completed: ${totalDeleted} total records deleted`);

      return {
        success: true,
        totalDeleted,
        deletedEvents,
        deletedClaims,
        deletedSchedules,
        newHead: rollbackPlan.targetSequence
      };

    } catch (error) {
      await t.rollback();
      logger.error(`[${resyncId}] Rollback failed:`, error);
      throw error;
    }
  }

  /**
   * Execute resync from safe sequence to latest
   */
  async executeResync(startSequence, endSequence, resyncId) {
    logger.info(`[${resyncId}] Starting resync from ${startSequence} to ${endSequence}...`);

    const rpcUrl = process.env.SOROBAN_RPC_URL || process.env.STELLAR_RPC_URL;
    const rpcClient = new SorobanRpcClient(rpcUrl);

    let totalEventsProcessed = 0;
    let totalBatches = 0;
    let errors = [];

    for (let currentSequence = startSequence; currentSequence <= endSequence; currentSequence += this.resyncBatchSize) {
      const batchEndSequence = Math.min(currentSequence + this.resyncBatchSize - 1, endSequence);

      try {
        logger.info(`[${resyncId}] Processing batch ${totalBatches + 1}: ledgers ${currentSequence}-${batchEndSequence}`);

        const batchResult = await this.processResyncBatch(
          rpcClient,
          currentSequence,
          batchEndSequence,
          resyncId
        );

        totalEventsProcessed += batchResult.eventsProcessed;
        totalBatches++;

        // Update progress
        this.resyncProgress = {
          ...this.resyncProgress,
          currentSequence: batchEndSequence,
          totalEventsProcessed,
          totalBatches,
          progress: ((batchEndSequence - startSequence) / (endSequence - startSequence)) * 100
        };

        // Delay between batches to avoid overwhelming RPC
        if (currentSequence + this.resyncBatchSize <= endSequence) {
          await this.delay(this.resyncDelay);
        }

      } catch (error) {
        logger.error(`[${resyncId}] Batch ${currentSequence}-${batchEndSequence} failed:`, error);
        errors.push({
          batchStart: currentSequence,
          batchEnd: batchEndSequence,
          error: error.message
        });

        // Continue with next batch unless too many errors
        if (errors.length > 5) {
          throw new Error(`Too many batch errors: ${errors.length}`);
        }
      }
    }

    logger.info(`[${resyncId}] Resync completed: ${totalEventsProcessed} events in ${totalBatches} batches`);

    return {
      success: true,
      totalEventsProcessed,
      totalBatches,
      errors,
      startSequence,
      endSequence
    };
  }

  /**
   * Process a single batch of ledgers during resync
   */
  async processResyncBatch(rpcClient, startLedger, endLedger, resyncId) {
    try {
      // Get events for this ledger range
      const events = await rpcClient.callWithRetry('getEvents', {
        startLedger,
        endLedger
      });

      const relevantEvents = events.events || [];
      let eventsProcessed = 0;

      logger.info(`[${resyncId}] Found ${relevantEvents.length} events in ledgers ${startLedger}-${endLedger}`);

      // Process each event
      for (const event of relevantEvents) {
        try {
          await this.processResyncEvent(event, resyncId);
          eventsProcessed++;
        } catch (eventError) {
          logger.error(`[${resyncId}] Failed to process event ${event.id}:`, eventError);
          // Continue processing other events
        }
      }

      return {
        success: true,
        eventsProcessed,
        totalEvents: relevantEvents.length
      };

    } catch (error) {
      logger.error(`[${resyncId}] Failed to fetch events for ledgers ${startLedger}-${endLedger}:`, error);
      throw error;
    }
  }

  /**
   * Process single event during resync
   */
  async processResyncEvent(event, resyncId) {
    const eventType = this.extractEventType(event);
    
    if (!this.isRelevantEvent(eventType)) {
      return;
    }

    // Store event in database (similar to poller service)
    const contractAddress = event.contractId || event.body?.contractId;
    const transactionHash = event.id;
    const ledgerSequence = event.ledger;
    const eventTimestamp = new Date(event.timestamp || Date.now());

    // Check for duplicates
    const existingEvent = await SorobanEvent.findOne({
      where: {
        ledger_sequence: ledgerSequence,
        event_type: eventType,
        transaction_hash: transactionHash
      }
    });

    if (existingEvent) {
      return; // Skip duplicates
    }

    // Create event record
    await SorobanEvent.create({
      event_type: eventType,
      contract_address: contractAddress,
      transaction_hash: transactionHash,
      ledger_sequence: ledgerSequence,
      event_body: event,
      event_timestamp: eventTimestamp,
      processed: false // Mark as unprocessed for regular processor to handle
    });

    logger.info(`[${resyncId}] Stored ${eventType} event from ledger ${ledgerSequence}`);
  }

  /**
   * Extract event type from event data
   */
  extractEventType(event) {
    const topic = event.body?.topic || '';
    
    if (topic.includes('VestingScheduleCreated')) {
      return 'VestingScheduleCreated';
    } else if (topic.includes('TokensClaimed')) {
      return 'TokensClaimed';
    }
    
    return 'Unknown';
  }

  /**
   * Check if event is relevant
   */
  isRelevantEvent(eventType) {
    return eventType === 'VestingScheduleCreated' || eventType === 'TokensClaimed';
  }

  /**
   * Perform targeted resync for specific ledger range
   */
  async performTargetedResync(startSequence, endSequence, options = {}) {
    if (this.isResyncing) {
      throw new Error('Resync already in progress');
    }

    const resyncId = `targeted_resync_${Date.now()}`;
    const startTime = Date.now();

    try {
      logger.info(`[${resyncId}] Starting targeted resync from ${startSequence} to ${endSequence}...`);
      this.isResyncing = true;
      this.resyncProgress = { resyncId, startTime, status: 'STARTING' };

      // First rollback the target range
      await this.rollbackTargetRange(startSequence, endSequence, resyncId);

      // Then resync the range
      const resyncResult = await this.executeResync(startSequence, endSequence, resyncId);

      const duration = Date.now() - startTime;
      logger.info(`[${resyncId}] Targeted resync completed in ${duration}ms`);

      this.resyncProgress = {
        ...this.resyncProgress,
        status: 'COMPLETED',
        duration,
        result: resyncResult
      };

      return {
        resyncId,
        duration,
        startSequence,
        endSequence,
        resyncResult
      };

    } catch (error) {
      logger.error(`[${resyncId}] Targeted resync failed:`, error);
      Sentry.captureException(error, {
        tags: { service: this.serviceName, operation: 'targeted_resync' },
        extra: { resync_id: resyncId, startSequence, endSequence }
      });

      this.resyncProgress = {
        ...this.resyncProgress,
        status: 'FAILED',
        error: error.message
      };

      throw error;
    } finally {
      this.isResyncing = false;
    }
  }

  /**
   * Rollback specific ledger range
   */
  async rollbackTargetRange(startSequence, endSequence, resyncId) {
    const t = await sequelize.transaction();

    try {
      logger.info(`[${resyncId}] Rolling back range ${startSequence}-${endSequence}...`);

      // Delete SorobanEvents in range
      const deletedEvents = await SorobanEvent.destroy({
        where: {
          ledger_sequence: {
            [Op.between]: [startSequence, endSequence]
          }
        },
        transaction: t
      });

      // Delete ClaimsHistory in range
      const deletedClaims = await ClaimsHistory.destroy({
        where: {
          block_number: {
            [Op.between]: [startSequence, endSequence]
          }
        },
        transaction: t
      });

      // Delete SubSchedules in range
      const deletedSchedules = await SubSchedule.destroy({
        where: {
          block_number: {
            [Op.between]: [startSequence, endSequence]
          }
        },
        transaction: t
      });

      await t.commit();

      logger.info(`[${resyncId}] Range rollback completed: ${deletedEvents} events, ${deletedClaims} claims, ${deletedSchedules} schedules`);

      return {
        success: true,
        deletedEvents,
        deletedClaims,
        deletedSchedules
      };

    } catch (error) {
      await t.rollback();
      logger.error(`[${resyncId}] Range rollback failed:`, error);
      throw error;
    }
  }

  /**
   * Validate ledger integrity
   */
  async validateLedgerIntegrity() {
    const networkState = await this.getNetworkState();
    const dbState = await this.getCurrentDbState();

    const issues = [];

    // Check for gaps
    if (dbState.maxSorobanEventSequence > networkState.latestSequence) {
      issues.push({
        type: 'DATABASE_AHEAD_OF_NETWORK',
        severity: 'HIGH',
        description: `Database sequence (${dbState.maxSorobanEventSequence}) is ahead of network (${networkState.latestSequence})`
      });
    }

    // Check for large gaps
    const gap = networkState.latestSequence - Math.max(
      dbState.maxSorobanEventSequence,
      dbState.maxClaimsHistorySequence,
      dbState.maxSubScheduleSequence
    );

    if (gap > this.finalityThreshold * 2) {
      issues.push({
        type: 'LARGE_SYNC_GAP',
        severity: 'MEDIUM',
        description: `Large sync gap detected: ${gap} ledgers`,
        data: { gap }
      });
    }

    return {
      isValid: issues.length === 0,
      issues,
      networkState,
      dbState
    };
  }

  /**
   * Get resync progress
   */
  getResyncProgress() {
    return this.resyncProgress;
  }

  /**
   * Cancel ongoing resync
   */
  async cancelResync() {
    if (!this.isResyncing) {
      return false;
    }

    logger.info('Cancelling ongoing resync...');
    this.isResyncing = false;
    
    if (this.resyncProgress) {
      this.resyncProgress = {
        ...this.resyncProgress,
        status: 'CANCELLED'
      };
    }

    return true;
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      isResyncing: this.isResyncing,
      resyncProgress: this.resyncProgress,
      finalityThreshold: this.finalityThreshold,
      resyncBatchSize: this.resyncBatchSize,
      maxResyncDepth: this.maxResyncDepth,
      resyncDelay: this.resyncDelay
    };
  }

  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = LedgerResyncService;
