const logger = require('../utils/logger');
const { sequelize } = require('../database/connection');
const { IndexerState, ClaimsHistory, SubSchedule } = require('../models');
const { Op } = require('sequelize');

class StellarIngestionService {
  constructor() {
    this.serviceName = 'stellar-indexer';
  }

  async getLastIngestedLedger() {
    try {
      const state = await IndexerState.findByPk(this.serviceName);
      if (state) {
        return state.last_ingested_ledger;
      }
      return 0; // Default to 0 if no state exists
    } catch (error) {
      logger.error('Error fetching last ingested ledger:', error);
      throw error;
    }
  }

  async updateLastIngestedLedger(sequence, transaction = null) {
    try {
      const options = transaction ? { transaction } : {};
      
      const [state, created] = await IndexerState.findOrCreate({
        where: { service_name: this.serviceName },
        defaults: {
          last_ingested_ledger: sequence,
        },
        ...options
      });

      if (!created) {
        state.last_ingested_ledger = sequence;
        await state.save(options);
      }
      
      return sequence;
    } catch (error) {
      logger.error('Error updating last ingested ledger:', error);
      throw error;
    }
  }

  /**
   * Rolls back the database state to a specific ledger sequence.
   * Deletes all records associated with ledgers greater than the target sequence.
   * @param {number} targetSequence The ledger sequence to roll back to (inclusive - this ledger is kept).
   */
  async rollbackToLedger(targetSequence) {
    const t = await sequelize.transaction();

    try {
      logger.info(`Starting rollback to ledger ${targetSequence}...`);

      // 1. Delete ClaimsHistory records > targetSequence
      const deletedClaims = await ClaimsHistory.destroy({
        where: {
          block_number: {
            [Op.gt]: targetSequence
          }
        },
        transaction: t
      });
      logger.info(`Rolled back ${deletedClaims} claims.`);

      // 2. Delete SubSchedule records (top-ups) > targetSequence
      const deletedSchedules = await SubSchedule.destroy({
        where: {
          block_number: {
            [Op.gt]: targetSequence
          }
        },
        transaction: t
      });
      logger.info(`Rolled back ${deletedSchedules} sub-schedules.`);

      // 3. Update IndexerState
      await this.updateLastIngestedLedger(targetSequence, t);

      await t.commit();
      logger.info(`Rollback complete. New last ingested ledger: ${targetSequence}`);
      
      return {
        success: true,
        deletedClaims,
        deletedSchedules,
        newHead: targetSequence
      };
    } catch (error) {
      await t.rollback();
      logger.error('Rollback failed:', error);
      throw error;
    }
  }
}

module.exports = new StellarIngestionService();
