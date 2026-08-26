'use strict';

const logger = require('../utils/logger');
const EventPriorityQueue = require('../utils/eventPriorityQueue');
const { VestingMilestone, SubSchedule, Vault, Beneficiary } = require('../models');
const { Op } = require('sequelize');

/**
 * VestingUnlockSyncService - Manages time-sensitive unlock events using a Priority Queue.
 * Ensures that off-chain analytics and state are updated precisely when milestones are reached.
 */
class VestingUnlockSyncService {
  constructor() {
    this.queue = new EventPriorityQueue();
    this.isProcessing = false;
    this.checkInterval = 10000; // Check every 10 seconds
    this.timerId = null;
  }

  /**
   * Start the sync service.
   * Loads future milestones from DB and starts the polling timer.
   */
  async start() {
    if (this.timerId) return;

    logger.info('Starting Vesting Unlock Sync Service...');
    await this.loadFutureMilestones();

    this.timerId = setInterval(() => {
      this.processDueEvents().catch(err => {
        logger.error('Error in VestingUnlockSyncService processing:', err);
      });
    }, this.checkInterval);

    logger.info('Vesting Unlock Sync Service started.');
  }

  /**
   * Stop the sync service.
   */
  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
      logger.info('Vesting Unlock Sync Service stopped.');
    }
  }

  /**
   * Load future milestones from the database into the priority queue.
   */
  async loadFutureMilestones() {
    try {
      const now = new Date();
      
      // Find all sub-schedules that have future cliff or end dates
      const subSchedules = await SubSchedule.findAll({
        where: {
          is_active: true,
          [Op.or]: [
            { cliff_date: { [Op.gt]: now } },
            { end_timestamp: { [Op.gt]: now } }
          ]
        },
        include: [
          {
            model: Vault,
            as: 'vault',
            include: [{ model: Beneficiary, as: 'beneficiaries' }]
          }
        ]
      });

      logger.info(`Loading ${subSchedules.length} sub-schedules into unlock queue...`);

      for (const sub of subSchedules) {
        if (sub.cliff_date && sub.cliff_date > now) {
          this.queue.enqueue({
            type: 'CLIFF_REACHED',
            subScheduleId: sub.id,
            vaultId: sub.vault_id
          }, sub.cliff_date);
        }

        if (sub.end_timestamp && sub.end_timestamp > now) {
          this.queue.enqueue({
            type: 'VESTING_COMPLETE',
            subScheduleId: sub.id,
            vaultId: sub.vault_id
          }, sub.end_timestamp);
        }
      }

      logger.info(`Priority queue populated with ${this.queue.size()} future events.`);
    } catch (error) {
      logger.error('Failed to load future milestones:', error);
      throw error;
    }
  }

  /**
   * Add a new unlock event to the queue.
   * Useful when a new top-up or vault is created.
   * @param {Object} event - Event data.
   * @param {number|Date} timestamp - When the event is due.
   */
  scheduleEvent(event, timestamp) {
    this.queue.enqueue(event, timestamp);
    logger.info(`Scheduled event ${event.type} for ${timestamp}`);
  }

  /**
   * Process all events that are currently due.
   */
  async processDueEvents() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const now = new Date();
      const dueEvents = this.queue.getDueEvents(now);

      if (dueEvents.length > 0) {
        logger.info(`Processing ${dueEvents.length} due unlock events...`);
        
        for (const event of dueEvents) {
          await this.handleEvent(event);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Handle an individual unlock event.
   * @param {Object} event 
   */
  async handleEvent(event) {
    const { type, subScheduleId, vaultId } = event;
    logger.info(`Handling ${type} for sub-schedule ${subScheduleId}`);

    try {
      // 1. Log milestone in database
      const sub = await SubSchedule.findByPk(subScheduleId, {
        include: [{ model: Vault, as: 'vault' }]
      });

      if (!sub) {
        logger.warn(`Sub-schedule ${subScheduleId} not found, skipping event.`);
        return;
      }

      // Find beneficiaries to create milestones for them
      const beneficiaries = await Beneficiary.findAll({
        where: { vault_id: vaultId }
      });

      for (const beneficiary of beneficiaries) {
        // Calculate vested amount at this moment
        const vestedAmount = this._calculateVestedAmount(sub, new Date());

        await VestingMilestone.create({
          vault_id: vaultId,
          sub_schedule_id: subScheduleId,
          beneficiary_id: beneficiary.id,
          milestone_date: new Date(),
          milestone_type: type === 'CLIFF_REACHED' ? 'cliff_end' : 'vesting_complete',
          vested_amount: vestedAmount,
          cumulative_vested: vestedAmount, // Simplification for now
          token_address: sub.vault.token_address
        });
      }

      // 2. Trigger notifications/analytics updates (simulated)
      logger.info(`Successfully processed ${type} for vault ${vaultId}`);
      
    } catch (error) {
      logger.error(`Error handling event ${type}:`, error);
    }
  }

  /**
   * Helper to calculate vested amount for a sub-schedule.
   * @private
   */
  _calculateVestedAmount(sub, now) {
    const total = parseFloat(sub.top_up_amount);
    const start = new Date(sub.vesting_start_date);
    const end = new Date(sub.end_timestamp);
    const cliff = sub.cliff_date ? new Date(sub.cliff_date) : null;

    if (now < start) return 0;
    if (cliff && now < cliff) return 0;
    if (now >= end) return total;

    const duration = end - start;
    const elapsed = now - start;
    return (total * elapsed) / duration;
  }
}

module.exports = new VestingUnlockSyncService();
