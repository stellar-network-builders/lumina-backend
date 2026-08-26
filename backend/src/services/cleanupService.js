'use strict';

const logger = require('../utils/logger');
const { CleanupTask, CleanupReward, Vault, SubSchedule, Beneficiary } = require('../models');
const { sequelize } = require('../database/connection');
const auditLogger = require('./auditLogger');

/**
 * Cleanup Service
 * Handles storage cleanup incentives for closed vaults
 * Implements "Bounty Logic" where platform fees are returned to users
 * who trigger finalize_and_delete on empty vaults after 4-year vesting
 */
class CleanupService {
  /**
   * Default bounty percentage - returned to user who cleans up vault
   * This is a percentage of the platform fee paid for the vault
   */
  static DEFAULT_BOUNTY_PERCENTAGE = 10; // 10% of platform fee

  /**
   * Calculate whether a vault is eligible for cleanup
   * A vault is eligible if:
   * 1. All vesting schedules have completed
   * 2. Vault is empty (no remaining balance)
   * 3. 4-year vesting period has passed
   * 
   * @param {string|Object} vaultData - vault address or vault object
   * @returns {Promise<{isEligible: boolean, reason: string, vestingComplete: boolean}>}
   */
  async isVaultEligibleForCleanup(vaultData) {
    try {
      const vault = typeof vaultData === 'string'
        ? await Vault.findOne({ where: { address: vaultData } })
        : vaultData;

      if (!vault) {
        return {
          isEligible: false,
          reason: 'Vault not found',
          vestingComplete: false
        };
      }

      // Get all sub-schedules for this vault
      const subSchedules = await SubSchedule.findAll({
        where: { vault_id: vault.id }
      });

      if (subSchedules.length === 0) {
        return {
          isEligible: false,
          reason: 'No vesting schedules found for vault',
          vestingComplete: false
        };
      }

      // Check if all schedules are complete
      const now = new Date();
      const allSchedulesComplete = subSchedules.every(schedule => {
        const endDate = new Date(schedule.end_timestamp);
        return now >= endDate;
      });

      if (!allSchedulesComplete) {
        const nextVestingEnd = subSchedules
          .map(s => new Date(s.end_timestamp))
          .sort((a, b) => a - b)[0];
        
        return {
          isEligible: false,
          reason: `Vesting not yet complete. Next completion date: ${nextVestingEnd.toISOString()}`,
          vestingComplete: false,
          nextVestingEnd
        };
      }

      // Enforce the 4-year vesting journey rule
      const startDates = subSchedules.map(s => new Date(s.vesting_start_date || s.start_timestamp));
      const earliestStart = new Date(Math.min(...startDates.map(d => d.getTime())));
      const fourYearsMs = 4 * 365 * 24 * 60 * 60 * 1000; // approx 4 years
      if (now.getTime() - earliestStart.getTime() < fourYearsMs) {
        return {
          isEligible: false,
          reason: `Vesting period has not reached 4 years from first start date (${earliestStart.toISOString()})`,
          vestingComplete: true,
          vestingStartDate: earliestStart
        };
      }

      // Check if vault is empty (all tokens withdrawn)
      const totalAllocated = parseFloat(vault.total_amount) || 0;
      const totalWithdrawn = await this._getTotalWithdrawn(vault.id);
      const remainingBalance = totalAllocated - totalWithdrawn;

      if (remainingBalance > 0.0001) { // Small epsilon for floating point
        return {
          isEligible: false,
          reason: `Vault not empty. Remaining balance: ${remainingBalance}`,
          vestingComplete: true,
          remainingBalance
        };
      }

      // All checks passed
      return {
        isEligible: true,
        reason: 'Vault is eligible for cleanup reward',
        vestingComplete: true
      };

    } catch (error) {
      logger.error('Error checking cleanup eligibility:', error);
      throw error;
    }
  }

  /**
   * Create a cleanup task for an eligible vault
   * This prepares the vault for finalization and tracks the bounty reward
   * 
   * @param {Object} data - cleanup task data
   * @param {string} data.vault_address - vault address
   * @param {string} data.platform_fee_paid - platform fee paid for this vault
   * @param {number} [data.bounty_percentage] - bounty percentage (default 10%)
   * @param {string} [data.admin_address] - admin creating the task
   * @returns {Promise<CleanupTask>}
   */
  async createCleanupTask(data) {
    const transaction = await sequelize.transaction();
    
    try {
      const {
        vault_address,
        platform_fee_paid = 0,
        bounty_percentage = CleanupService.DEFAULT_BOUNTY_PERCENTAGE,
        admin_address = 'system'
      } = data;

      // Verify vault exists
      const vault = await Vault.findOne({
        where: { address: vault_address },
        transaction
      });

      if (!vault) {
        throw new Error(`Vault not found: ${vault_address}`);
      }

      // Check eligibility
      const eligibility = await this.isVaultEligibleForCleanup(vault);
      if (!eligibility.isEligible) {
        throw new Error(`Vault not eligible for cleanup: ${eligibility.reason}`);
      }

      // Calculate bounty reward
      const platformFee = parseFloat(platform_fee_paid) || 0;
      const bountyReward = (platformFee * bounty_percentage) / 100;

      // Prevent duplicate pending cleanup task for same vault
      const existingTask = await CleanupTask.findOne({
        where: {
          vault_id: vault.id,
          status: 'pending'
        },
        transaction
      });

      if (existingTask) {
        throw new Error(`Cleanup task already pending for vault: ${vault_address}`);
      }

      // Get vesting completion date
      const subSchedules = await SubSchedule.findAll({
        where: { vault_id: vault.id },
        transaction
      });

      const vestingCompletionDate = subSchedules.length > 0
        ? new Date(Math.max(...subSchedules.map(s => new Date(s.end_timestamp).getTime())))
        : new Date();

      // Get total vested amount
      const totalVested = parseFloat(vault.total_amount) || 0;

      // Create cleanup task
      const cleanupTask = await CleanupTask.create({
        vault_id: vault.id,
        vault_address,
        owner_address: vault.owner_address,
        total_vested_amount: String(totalVested),
        vesting_completion_date: vestingCompletionDate,
        platform_fee_paid: String(platformFee),
        bounty_reward_amount: String(bountyReward),
        bounty_percentage,
        status: 'pending',
        is_empty_vault: true
      }, { transaction });

      // Audit log
      auditLogger.logAction(admin_address, 'CREATE_CLEANUP_TASK', vault_address, {
        cleanupTaskId: cleanupTask.id,
        bountyReward: String(bountyReward),
        bountyPercentage: bounty_percentage,
        platformFee: String(platformFee)
      });

      await transaction.commit();
      return cleanupTask;

    } catch (error) {
      await transaction.rollback();
      logger.error('Error creating cleanup task:', error);
      throw error;
    }
  }

  /**
   * Retrieve available cleanup rewards for a user
   * Returns all pending cleanup tasks that the user is eligible to claim
   * 
   * @param {string} userAddress - user wallet address
   * @param {Object} [options] - filter options
   * @param {string} [options.status] - filter by status (pending, claimed, cancelled)
   * @param {boolean} [options.includeDetails] - include detailed vault info
   * @returns {Promise<Array>}
   */
  async getAvailableRewards(userAddress, options = {}) {
    try {
      const {
        status = 'pending',
        includeDetails = true
      } = options;

      const where = { status };

      if (userAddress) {
        where.owner_address = userAddress;
      }

      const tasks = await CleanupTask.findAll({
        where,
        include: includeDetails ? [{
          model: Vault,
          as: 'vault',
          attributes: ['id', 'address', 'token_address', 'total_amount', 'name', 'tag']
        }] : [],
        order: [['created_at', 'DESC']]
      });

      return tasks;

      return tasks;

    } catch (error) {
      logger.error('Error getting available rewards:', error);
      throw error;
    }
  }

  /**
   * Claim cleanup reward for a vault
   * This processes the reward transfer for a cleanup task
   * 
   * @param {Object} data - claim data
   * @param {string} data.cleanup_task_id - cleanup task ID
   * @param {string} data.claimer_address - address claiming the reward
   * @param {string} data.transaction_hash - Stellar transaction hash
   * @param {number} [data.ledger_sequence] - Stellar ledger sequence
   * @param {Date} [data.block_timestamp] - blockchain timestamp
   * @returns {Promise<CleanupReward>}
   */
  async claimReward(data) {
    const transaction = await sequelize.transaction();
    
    try {
      const {
        cleanup_task_id,
        claimer_address,
        transaction_hash,
        ledger_sequence,
        block_timestamp = new Date()
      } = data;

      // Verify cleanup task exists and is pending
      const cleanupTask = await CleanupTask.findOne({
        where: { id: cleanup_task_id },
        transaction
      });

      if (!cleanupTask) {
        throw new Error(`Cleanup task not found: ${cleanup_task_id}`);
      }

      if (cleanupTask.status !== 'pending') {
        throw new Error(`Cleanup task already ${cleanupTask.status}: ${cleanup_task_id}`);
      }

      const rewardAmount = parseFloat(cleanupTask.bounty_reward_amount);

      // Create reward record
      const reward = await CleanupReward.create({
        cleanup_task_id,
        vault_id: cleanupTask.vault_id,
        claimer_address,
        reward_amount: String(rewardAmount),
        transaction_hash,
        ledger_sequence,
        block_timestamp,
        reward_status: 'pending'
      }, { transaction });

      // Update cleanup task status
      await cleanupTask.update({
        status: 'claimed',
        claimed_by_address: claimer_address,
        claimed_at: new Date(),
        transaction_hash
      }, { transaction });

      // Audit log
      auditLogger.logAction(claimer_address, 'CLAIM_CLEANUP_REWARD', cleanupTask.vault_address, {
        cleanupTaskId: cleanup_task_id,
        rewardAmount: String(rewardAmount),
        transactionHash: transaction_hash
      });

      await transaction.commit();
      return reward;

    } catch (error) {
      await transaction.rollback();
      logger.error('Error claiming reward:', error);
      throw error;
    }
  }

  /**
   * Update reward confirmation status from blockchain
   * Called after transaction is confirmed on-chain
   * 
   * @param {string} transaction_hash - Stellar transaction hash
   * @param {string} status - 'confirmed' or 'failed'
   * @param {number} [ledger_sequence] - Stellar ledger sequence
   * @returns {Promise<CleanupReward>}
   */
  async updateRewardStatus(transaction_hash, status, ledger_sequence = null) {
    try {
      if (!['confirmed', 'failed'].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }

      const reward = await CleanupReward.findOne({
        where: { transaction_hash }
      });

      if (!reward) {
        throw new Error(`Reward not found for transaction: ${transaction_hash}`);
      }

      await reward.update({
        reward_status: status,
        ledger_sequence: ledger_sequence || reward.ledger_sequence
      });

      return reward;

    } catch (error) {
      logger.error('Error updating reward status:', error);
      throw error;
    }
  }

  /**
   * Get cleanup statistics and metrics
   * Returns overview of cleanup tasks and rewards
   * 
   * @param {Object} [filters] - optional filters
   * @returns {Promise<Object>}
   */
  async getCleanupStats(filters = {}) {
    try {
      const totalTasks = await CleanupTask.count();
      const pendingTasks = await CleanupTask.count({
        where: { status: 'pending' }
      });
      const claimedTasks = await CleanupTask.count({
        where: { status: 'claimed' }
      });
      const cancelledTasks = await CleanupTask.count({
        where: { status: 'cancelled' }
      });

      // Total rewards distributed
      const confirmedRewards = await CleanupReward.findAll({
        where: { reward_status: 'confirmed' }
      });

      const totalRewardsDistributed = confirmedRewards.reduce((sum, reward) => {
        return sum + (parseFloat(reward.reward_amount) || 0);
      }, 0);

      // Get top claimers
      const topClaimers = await CleanupReward.sequelize.query(`
        SELECT claimer_address, COUNT(*) as claim_count, SUM(CAST(reward_amount AS NUMERIC)) as total_claimed
        FROM cleanup_rewards
        WHERE reward_status = 'confirmed'
        GROUP BY claimer_address
        ORDER BY total_claimed DESC
        LIMIT 10
      `, { type: 'SELECT' });

      return {
        totalTasks,
        taskStatus: {
          pending: pendingTasks,
          claimed: claimedTasks,
          cancelled: cancelledTasks
        },
        rewards: {
          totalDistributed: String(totalRewardsDistributed),
          confirmedCount: confirmedRewards.length
        },
        topClaimers
      };

    } catch (error) {
      logger.error('Error getting cleanup stats:', error);
      throw error;
    }
  }

  /**
   * Internal helper: get total withdrawn amount for a vault
   * @private
   */
  async _getTotalWithdrawn(vaultId) {
    try {
      const beneficiaries = await Beneficiary.findAll({
        where: { vault_id: vaultId }
      });

      return beneficiaries.reduce((total, b) => {
        return total + (parseFloat(b.total_withdrawn) || 0);
      }, 0);

    } catch (error) {
      logger.error('Error calculating total withdrawn:', error);
      return 0;
    }
  }

  /**
   * Cancel a cleanup task (admin only)
   * Used if cleanup is no longer needed
   * 
   * @param {string} cleanup_task_id - cleanup task ID
   * @param {string} reason - reason for cancellation
   * @param {string} [admin_address] - admin performing the action
   * @returns {Promise<CleanupTask>}
   */
  async cancelCleanupTask(cleanup_task_id, reason, admin_address = 'system') {
    try {
      const task = await CleanupTask.findOne({
        where: { id: cleanup_task_id }
      });

      if (!task) {
        throw new Error(`Cleanup task not found: ${cleanup_task_id}`);
      }

      if (task.status === 'claimed') {
        throw new Error('Cannot cancel a claimed cleanup task');
      }

      await task.update({
        status: 'cancelled'
      });

      // Audit log
      auditLogger.logAction(admin_address, 'CANCEL_CLEANUP_TASK', task.vault_address, {
        cleanupTaskId: cleanup_task_id,
        reason
      });

      return task;

    } catch (error) {
      logger.error('Error cancelling cleanup task:', error);
      throw error;
    }
  }
}

module.exports = new CleanupService();
