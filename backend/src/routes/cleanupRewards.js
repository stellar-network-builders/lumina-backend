const express = require('express');
const router = express.Router();
const cleanupService = require('../services/cleanupService');
const Sentry = require('@sentry/node');
const logger = require('../utils/logger');

/**
 * POST /api/cleanup/check-eligibility
 * Check if a vault is eligible for cleanup
 * 
 * Request body:
 * {
 *   "vault_address": "0x..."
 * }
 */
router.post('/check-eligibility', async (req, res) => {
  try {
    const { vault_address } = req.body;

    if (!vault_address) {
      return res.status(400).json({
        success: false,
        error: 'vault_address is required'
      });
    }

    const eligibility = await cleanupService.isVaultEligibleForCleanup(vault_address);

    res.json({
      success: true,
      data: {
        vault_address,
        ...eligibility
      }
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error checking cleanup eligibility:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/cleanup/create-task
 * Create a cleanup task for an eligible vault
 * 
 * Request body:
 * {
 *   "vault_address": "0x...",
 *   "platform_fee_paid": "100.50",
 *   "bounty_percentage": 10,
 *   "admin_address": "0x..."
 * }
 */
router.post('/create-task', async (req, res) => {
  try {
    const {
      vault_address,
      platform_fee_paid,
      bounty_percentage,
      admin_address
    } = req.body;

    if (!vault_address) {
      return res.status(400).json({
        success: false,
        error: 'vault_address is required'
      });
    }

    const cleanupTask = await cleanupService.createCleanupTask({
      vault_address,
      platform_fee_paid: platform_fee_paid || 0,
      bounty_percentage: bounty_percentage || cleanupService.DEFAULT_BOUNTY_PERCENTAGE,
      admin_address: admin_address || 'system'
    });

    res.status(201).json({
      success: true,
      data: {
        id: cleanupTask.id,
        vault_address: cleanupTask.vault_address,
        owner_address: cleanupTask.owner_address,
        bounty_reward_amount: cleanupTask.bounty_reward_amount,
        bounty_percentage: cleanupTask.bounty_percentage,
        status: cleanupTask.status,
        created_at: cleanupTask.created_at
      },
      message: `Cleanup task created. Bounty reward: ${cleanupTask.bounty_reward_amount}`
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error creating cleanup task:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cleanup/available-rewards/:userAddress
 * Get available cleanup rewards for a user
 * 
 * Query parameters:
 * - status: 'pending', 'claimed', 'cancelled' (default: 'pending')
 * - includeDetails: true/false (default: true)
 */
router.get('/available-rewards/:userAddress', async (req, res) => {
  try {
    const { userAddress } = req.params;
    const { status = 'pending', includeDetails = 'true' } = req.query;

    const rewards = await cleanupService.getAvailableRewards(userAddress, {
      status,
      includeDetails: includeDetails === 'true'
    });

    const pendingRewards = rewards.filter(r => r.status === status);
    const totalPendingReward = pendingRewards.reduce((sum, r) => {
      return sum + (parseFloat(r.bounty_reward_amount) || 0);
    }, 0);

    res.json({
      success: true,
      data: {
        user_address: userAddress,
        total_available_rewards: String(totalPendingReward),
        reward_count: pendingRewards.length,
        rewards: pendingRewards.map(r => ({
          id: r.id,
          vault_address: r.vault_address,
          bounty_reward_amount: r.bounty_reward_amount,
          bounty_percentage: r.bounty_percentage,
          vesting_completion_date: r.vesting_completion_date,
          status: r.status,
          created_at: r.created_at,
          vault: r.vault ? {
            address: r.vault.address,
            name: r.vault.name,
            token_address: r.vault.token_address,
            tag: r.vault.tag
          } : null
        }))
      }
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error getting available rewards:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/cleanup/claim-reward
 * Claim a cleanup reward for a completed vault
 * 
 * Request body:
 * {
 *   "cleanup_task_id": "uuid",
 *   "claimer_address": "0x...",
 *   "transaction_hash": "0x...",
 *   "ledger_sequence": 12345678
 * }
 */
router.post('/claim-reward', async (req, res) => {
  try {
    const {
      cleanup_task_id,
      claimer_address,
      transaction_hash,
      ledger_sequence,
      block_timestamp
    } = req.body;

    if (!cleanup_task_id || !claimer_address || !transaction_hash) {
      return res.status(400).json({
        success: false,
        error: 'cleanup_task_id, claimer_address, and transaction_hash are required'
      });
    }

    const reward = await cleanupService.claimReward({
      cleanup_task_id,
      claimer_address,
      transaction_hash,
      ledger_sequence,
      block_timestamp: block_timestamp || new Date()
    });

    res.status(201).json({
      success: true,
      data: {
        id: reward.id,
        cleanup_task_id: reward.cleanup_task_id,
        claimer_address: reward.claimer_address,
        reward_amount: reward.reward_amount,
        transaction_hash: reward.transaction_hash,
        reward_status: reward.reward_status,
        claimed_at: reward.claimed_at
      },
      message: `Cleanup reward claimed successfully! Amount: ${reward.reward_amount}`
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error claiming reward:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PATCH /api/cleanup/reward-status
 * Update reward confirmation status from blockchain
 * 
 * Request body:
 * {
 *   "transaction_hash": "0x...",
 *   "status": "confirmed" | "failed",
 *   "ledger_sequence": 12345678
 * }
 */
router.patch('/reward-status', async (req, res) => {
  try {
    const { transaction_hash, status, ledger_sequence } = req.body;

    if (!transaction_hash || !status) {
      return res.status(400).json({
        success: false,
        error: 'transaction_hash and status are required'
      });
    }

    const reward = await cleanupService.updateRewardStatus(
      transaction_hash,
      status,
      ledger_sequence
    );

    res.json({
      success: true,
      data: {
        id: reward.id,
        transaction_hash: reward.transaction_hash,
        reward_status: reward.reward_status,
        ledger_sequence: reward.ledger_sequence,
        updated_at: reward.updated_at
      },
      message: `Reward status updated to: ${status}`
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error updating reward status:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cleanup/stats
 * Get cleanup statistics and metrics
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await cleanupService.getCleanupStats();

    res.json({
      success: true,
      data: {
        ...stats,
        message: `Total cleanup tasks: ${stats.totalTasks}, Pending: ${stats.taskStatus.pending}, Claimed: ${stats.taskStatus.claimed}`
      }
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error getting cleanup stats:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/cleanup/task/:cleanupTaskId
 * Cancel a cleanup task (admin only)
 * 
 * Request body:
 * {
 *   "reason": "reason for cancellation",
 *   "admin_address": "0x..."
 * }
 */
router.delete('/task/:cleanupTaskId', async (req, res) => {
  try {
    const { cleanupTaskId } = req.params;
    const { reason = '', admin_address = 'system' } = req.body;

    const task = await cleanupService.cancelCleanupTask(
      cleanupTaskId,
      reason,
      admin_address
    );

    res.json({
      success: true,
      data: {
        id: task.id,
        vault_address: task.vault_address,
        status: task.status,
        cancelled_at: task.updated_at
      },
      message: 'Cleanup task cancelled successfully'
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error cancelling cleanup task:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cleanup/task/:cleanupTaskId
 * Get details of a cleanup task
 */
router.get('/task/:cleanupTaskId', async (req, res) => {
  try {
    const { cleanupTaskId } = req.params;
    const { CleanupTask } = require('../models');

    const task = await CleanupTask.findOne({
      where: { id: cleanupTaskId },
      include: [{
        model: require('../models').Vault,
        as: 'vault',
        attributes: ['address', 'name', 'token_address', 'total_amount']
      }]
    });

    if (!task) {
      return res.status(404).json({
        success: false,
        error: 'Cleanup task not found'
      });
    }

    res.json({
      success: true,
      data: {
        id: task.id,
        vault_address: task.vault_address,
        owner_address: task.owner_address,
        total_vested_amount: task.total_vested_amount,
        bounty_reward_amount: task.bounty_reward_amount,
        bounty_percentage: task.bounty_percentage,
        status: task.status,
        claimed_by_address: task.claimed_by_address,
        claimed_at: task.claimed_at,
        vesting_completion_date: task.vesting_completion_date,
        created_at: task.created_at,
        vault: task.vault ? {
          address: task.vault.address,
          name: task.vault.name,
          token_address: task.vault.token_address,
          total_amount: task.vault.total_amount
        } : null
      }
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error getting cleanup task:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
