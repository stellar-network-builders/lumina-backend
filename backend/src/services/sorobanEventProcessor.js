const logger = require('../utils/logger');
const { sequelize } = require('../database/connection');
const { SorobanEvent, ClaimsHistory, SubSchedule, Vault, Beneficiary } = require('../models');
const Sentry = require('@sentry/node');
const cacheService = require('./cacheService');

class SorobanEventProcessor {
  constructor(options = {}) {
    this.batchSize = options.batchSize || 50;
    this.maxRetries = options.maxRetries || 3;
    this.processingDelay = options.processingDelay || 1000; // Delay between batches
    this.isProcessing = false;
  }

  /**
   * Start processing unprocessed events
   */
  async startProcessing() {
    if (this.isProcessing) {
      logger.warn('Soroban Event Processor is already running');
      return;
    }

    logger.info('Starting Soroban Event Processor...');
    this.isProcessing = true;

    while (this.isProcessing) {
      try {
        await this.processBatch();
        await this.delay(this.processingDelay);
      } catch (error) {
        logger.error('Error in event processing loop:', error);
        Sentry.captureException(error, {
          tags: { service: 'soroban-event-processor', operation: 'processing_loop' }
        });
        await this.delay(5000); // Wait 5 seconds before retrying
      }
    }

    logger.info('Soroban Event Processor stopped');
  }

  /**
   * Stop processing events
   */
  async stopProcessing() {
    logger.info('Stopping Soroban Event Processor...');
    this.isProcessing = false;
  }

  /**
   * Process a batch of unprocessed events
   */
  async processBatch() {
    const events = await SorobanEvent.findAll({
      where: { processed: false },
      order: [['ledger_sequence', 'ASC']],
      limit: this.batchSize
    });

    if (events.length === 0) {
      return;
    }

    logger.info(`Processing batch of ${events.length} events...`);
    const processedEventIds = [];
    const failedEventIds = [];

    for (const event of events) {
      try {
        await this.processEvent(event);
        processedEventIds.push(event.id);
      } catch (error) {
        logger.error(`Failed to process event ${event.id}:`, error);
        await this.markEventFailed(event.id, error.message);
        failedEventIds.push(event.id);
        
        Sentry.captureException(error, {
          tags: { service: 'soroban-event-processor', event_type: event.event_type },
          extra: { event_id: event.id, ledger_sequence: event.ledger_sequence }
        });
      }
    }

    // Mark successful events as processed
    if (processedEventIds.length > 0) {
      await SorobanEvent.update(
        { processed: true, processing_error: null },
        { where: { id: processedEventIds } }
      );
    }

    logger.info(`Batch completed: ${processedEventIds.length} processed, ${failedEventIds.length} failed`);
  }

  /**
   * Process a single event
   * @param {Object} event - SorobanEvent record
   */
  async processEvent(event) {
    switch (event.event_type) {
      case 'VestingScheduleCreated':
        await this.processVestingScheduleCreated(event);
        break;
      case 'TokensClaimed':
        await this.processTokensClaimed(event);
        break;
      default:
        logger.warn(`Unknown event type: ${event.event_type}`);
        throw new Error(`Unknown event type: ${event.event_type}`);
    }
  }

  /**
   * Process VestingScheduleCreated event
   * @param {Object} event - Event record
   */
  async processVestingScheduleCreated(event) {
    const eventData = event.event_body;
    const eventBody = eventData.body;

    logger.info(`Processing VestingScheduleCreated from ledger ${event.ledger_sequence}`);

    // Extract event data - this would depend on the actual event structure
    const {
      vault_id,
      beneficiary_address,
      token_address,
      total_amount,
      cliff_duration,
      vesting_duration,
      start_timestamp
    } = this.extractVestingScheduleData(eventBody);

    // Validate required fields
    if (!vault_id || !beneficiary_address || !token_address || !total_amount) {
      throw new Error('Missing required fields in VestingScheduleCreated event');
    }

    // Check if vault exists
    const vault = await Vault.findByPk(vault_id);
    if (!vault) {
      throw new Error(`Vault not found: ${vault_id}`);
    }

    // Create or update beneficiary
    const [beneficiary, created] = await Beneficiary.findOrCreate({
      where: { address: beneficiary_address },
      defaults: {
        vault_id,
        created_at: new Date()
      }
    });

    // Create sub-schedule record
    const subSchedule = await SubSchedule.create({
      vault_id,
      top_up_amount: total_amount,
      cliff_duration: cliff_duration || 0,
      vesting_duration,
      start_timestamp: new Date(start_timestamp * 1000), // Convert from seconds
      end_timestamp: new Date((start_timestamp + vesting_duration) * 1000),
      transaction_hash: event.transaction_hash,
      block_number: event.ledger_sequence,
      is_active: true
    });

    logger.info(`Created sub-schedule ${subSchedule.id} for vault ${vault_id}`);

    // Update cache
    await this.updateVaultCache(vault_id);

    return subSchedule;
  }

  /**
   * Process TokensClaimed event
   * @param {Object} event - Event record
   */
  async processTokensClaimed(event) {
    const eventData = event.event_body;
    const eventBody = eventData.body;

    logger.info(`Processing TokensClaimed from ledger ${event.ledger_sequence}`);

    // Extract event data
    const {
      beneficiary_address,
      token_address,
      amount_claimed,
      vault_id
    } = this.extractTokensClaimedData(eventBody);

    // Validate required fields
    if (!beneficiary_address || !token_address || !amount_claimed) {
      throw new Error('Missing required fields in TokensClaimed event');
    }

    // Create claims history record
    const claimRecord = await ClaimsHistory.create({
      user_address: beneficiary_address,
      token_address,
      amount_claimed,
      claim_timestamp: event.event_timestamp,
      transaction_hash: event.transaction_hash,
      block_number: event.ledger_sequence
    });

    logger.info(`Created claim record ${claimRecord.id} for ${amount_claimed} tokens`);

    // Update sub-schedule if vault_id is provided
    if (vault_id) {
      await this.updateSubScheduleClaimed(vault_id, amount_claimed, event.ledger_sequence);
    }

    return claimRecord;
  }

  /**
   * Extract data from VestingScheduleCreated event
   * @param {Object} eventBody - Event body data
   * @returns {Object} Extracted data
   */
  extractVestingScheduleData(eventBody) {
    // This would need to be adapted based on the actual event structure
    // The eventBody.data typically contains the event parameters
    
    try {
      // Example extraction - adjust based on actual event format
      const data = eventBody.data || {};
      
      return {
        vault_id: data.vault_id || data.vaultId,
        beneficiary_address: data.beneficiary_address || data.beneficiary,
        token_address: data.token_address || data.token,
        total_amount: data.total_amount || data.amount,
        cliff_duration: data.cliff_duration || data.cliff,
        vesting_duration: data.vesting_duration || data.duration,
        start_timestamp: data.start_timestamp || data.startTime || Math.floor(Date.now() / 1000)
      };
    } catch (error) {
      logger.error('Error extracting VestingScheduleCreated data:', error);
      throw new Error(`Failed to extract VestingScheduleCreated data: ${error.message}`);
    }
  }

  /**
   * Extract data from TokensClaimed event
   * @param {Object} eventBody - Event body data
   * @returns {Object} Extracted data
   */
  extractTokensClaimedData(eventBody) {
    try {
      const data = eventBody.data || {};
      
      return {
        beneficiary_address: data.beneficiary_address || data.beneficiary,
        token_address: data.token_address || data.token,
        amount_claimed: data.amount_claimed || data.amount,
        vault_id: data.vault_id || data.vaultId
      };
    } catch (error) {
      logger.error('Error extracting TokensClaimed data:', error);
      throw new Error(`Failed to extract TokensClaimed data: ${error.message}`);
    }
  }

  /**
   * Update sub-schedule with claimed amount
   * @param {string} vaultId - Vault ID
   * @param {number} amountClaimed - Amount claimed
   * @param {number} ledgerSequence - Ledger sequence
   */
  async updateSubScheduleClaimed(vaultId, amountClaimed, ledgerSequence) {
    try {
      // Find the most recent active sub-schedule for this vault
      const subSchedule = await SubSchedule.findOne({
        where: {
          vault_id: vaultId,
          is_active: true
        },
        order: [['created_at', 'DESC']]
      });

      if (subSchedule) {
        await subSchedule.update({
          amount_withdrawn: sequelize.literal(`amount_withdrawn + ${amountClaimed}`),
          cumulative_claimed_amount: sequelize.literal(`cumulative_claimed_amount + ${amountClaimed}`)
        });
        
        logger.info(`Updated sub-schedule ${subSchedule.id} with claimed amount ${amountClaimed}`);
      }
    } catch (error) {
      logger.error('Error updating sub-schedule:', error);
      // Don't throw here as this is not critical for the claim record
    }
  }

  /**
   * Update vault cache
   * @param {string} vaultId - Vault ID
   */
  async updateVaultCache(vaultId) {
    try {
      // Invalidate relevant cache entries
      const cacheKeys = [
        `vault:${vaultId}`,
        `vault:${vaultId}:schedules`,
        `vault:${vaultId}:beneficiaries`
      ];

      for (const key of cacheKeys) {
        await cacheService.del(key);
      }
    } catch (error) {
      logger.error('Error updating vault cache:', error);
      // Don't throw as cache issues shouldn't stop processing
    }
  }

  /**
   * Mark event as failed
   * @param {string} eventId - Event ID
   * @param {string} errorMessage - Error message
   */
  async markEventFailed(eventId, errorMessage) {
    await SorobanEvent.update(
      { processing_error: errorMessage },
      { where: { id: eventId } }
    );
  }

  /**
   * Get processing statistics
   * @returns {Object} Processing statistics
   */
  async getProcessingStats() {
    const totalEvents = await SorobanEvent.count();
    const processedEvents = await SorobanEvent.count({ where: { processed: true } });
    const failedEvents = await SorobanEvent.count({ where: { processing_error: { [sequelize.Sequelize.Op.ne]: null } } });
    const unprocessedEvents = totalEvents - processedEvents;

    return {
      totalEvents,
      processedEvents,
      failedEvents,
      unprocessedEvents,
      processingRate: totalEvents > 0 ? (processedEvents / totalEvents) * 100 : 0,
      isProcessing: this.isProcessing
    };
  }

  /**
   * Retry failed events
   * @param {number} limit - Maximum number of events to retry
   */
  async retryFailedEvents(limit = 50) {
    const failedEvents = await SorobanEvent.findAll({
      where: { processing_error: { [sequelize.Sequelize.Op.ne]: null } },
      order: [['ledger_sequence', 'ASC']],
      limit
    });

    logger.info(`Retrying ${failedEvents.length} failed events...`);

    for (const event of failedEvents) {
      try {
        // Clear error and reset processed status
        await event.update({ processing_error: null, processed: false });
        logger.info(`Reset event ${event.id} for retry`);
      } catch (error) {
        logger.error(`Failed to reset event ${event.id}:`, error);
      }
    }
  }

  /**
   * Delay helper
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get service status
   * @returns {Object} Service status
   */
  getStatus() {
    return {
      isProcessing: this.isProcessing,
      batchSize: this.batchSize,
      processingDelay: this.processingDelay
    };
  }
}

module.exports = SorobanEventProcessor;
