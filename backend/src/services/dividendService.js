const logger = require('../utils/logger');
const { DividendRound, DividendDistribution, DividendSnapshot, Vault, Beneficiary, SubSchedule } = require('../models');
const { sequelize } = require('../database/connection');
const Sentry = require('@sentry/node');
const slackWebhookService = require('./slackWebhookService');
const auditLogger = require('./auditLogger');
const axios = require('axios');

class DividendService {
  constructor() {
    this.defaultVestedTreatment = 'full';
    this.defaultUnvestedMultiplier = 1.0;
    this.distributionBatchSize = 50;
    this.rpcTimeout = 10000;
  }

  /**
   * Create a new dividend round
   */
  async createDividendRound(tokenAddress, totalAmount, dividendToken, vestedTreatment, unvestedMultiplier, createdBy) {
    const transaction = await sequelize.transaction();
    
    try {
      // Validate inputs
      if (!tokenAddress || !totalAmount || !dividendToken || !createdBy) {
        throw new Error('Token address, amount, dividend token, and creator are required');
      }

      const amount = parseFloat(totalAmount);
      if (amount <= 0) {
        throw new Error('Dividend amount must be greater than 0');
      }

      // Validate vested treatment
      const validTreatments = ['full', 'proportional', 'vested_only'];
      if (!validTreatments.includes(vestedTreatment)) {
        throw new Error('Invalid vested treatment. Must be: full, proportional, or vested_only');
      }

      // Validate unvested multiplier
      const multiplier = parseFloat(unvestedMultiplier || this.defaultUnvestedMultiplier);
      if (multiplier < 0 || multiplier > 1) {
        throw new Error('Unvested multiplier must be between 0 and 1');
      }

      // Create dividend round
      const dividendRound = await DividendRound.create({
        token_address: tokenAddress,
        total_dividend_amount: amount.toString(),
        dividend_token: dividendToken,
        snapshot_timestamp: new Date(),
        vested_treatment: vestedTreatment,
        unvested_multiplier: multiplier,
        status: 'pending',
        created_by: createdBy
      }, { transaction });

      await transaction.commit();

      // Log the action
      await auditLogger.log({
        action: 'CREATE_DIVIDEND_ROUND',
        actor: createdBy,
        target: tokenAddress,
        details: {
          dividendRoundId: dividendRound.id,
          totalAmount: amount.toString(),
          dividendToken,
          vestedTreatment,
          unvestedMultiplier
        }
      });

      logger.info(`✅ Dividend round created: ${dividendRound.id}`);
      return dividendRound;

    } catch (error) {
      await transaction.rollback();
      logger.error('❌ Error creating dividend round:', error);
      Sentry.captureException(error, {
        tags: { service: 'dividend-service' },
        extra: { tokenAddress, totalAmount, dividendToken, createdBy }
      });
      throw error;
    }
  }

  /**
   * Take snapshot of all vault holders for a dividend round
   */
  async takeDividendSnapshot(dividendRoundId) {
    const transaction = await sequelize.transaction();
    
    try {
      const dividendRound = await DividendRound.findByPk(dividendRoundId, { transaction });
      
      if (!dividendRound) {
        throw new Error('Dividend round not found');
      }

      if (dividendRound.status !== 'pending') {
        throw new Error('Dividend round must be in pending status to take snapshot');
      }

      // Update status to calculating
      await dividendRound.update({ status: 'calculating' }, { transaction });

      // Get all vaults for the token
      const vaults = await Vault.findAll({
        where: { token_address: dividendRound.token_address },
        include: [
          {
            model: Beneficiary,
            as: 'beneficiaries',
            include: [
              {
                model: SubSchedule,
                as: 'subSchedules'
              }
            ]
          }
        ],
        transaction
      });

      logger.info(`📸 Taking snapshot for ${vaults.length} vaults`);

      let totalEligibleHolders = 0;
      let totalEligibleBalance = 0;
      const snapshotTimestamp = dividendRound.snapshot_timestamp;

      // Process each vault and beneficiary
      for (const vault of vaults) {
        for (const beneficiary of vault.beneficiaries) {
          try {
            const snapshotData = await this.calculateBeneficiarySnapshot(
              beneficiary,
              vault,
              snapshotTimestamp,
              transaction
            );

            if (snapshotData.isEligible) {
              totalEligibleHolders++;
              totalEligibleBalance += parseFloat(snapshotData.totalBalance);
            }

          } catch (error) {
            logger.error(`❌ Error processing beneficiary ${beneficiary.address}:`, error);
            // Continue processing other beneficiaries
          }
        }
      }

      // Update dividend round with snapshot results
      await dividendRound.update({
        total_eligible_holders: totalEligibleHolders,
        total_eligible_balance: totalEligibleBalance.toString(),
        calculation_timestamp: new Date(),
        status: 'ready'
      }, { transaction });

      await transaction.commit();

      logger.info(`✅ Snapshot completed: ${totalEligibleHolders} eligible holders, ${totalEligibleBalance} total balance`);

      // Send notification
      await this.notifySnapshotCompleted(dividendRound, totalEligibleHolders, totalEligibleBalance);

      return {
        dividendRoundId,
        eligibleHolders: totalEligibleHolders,
        eligibleBalance: totalEligibleBalance.toString()
      };

    } catch (error) {
      await transaction.rollback();
      
      // Mark round as failed
      await DividendRound.update(
        { status: 'failed' },
        { where: { id: dividendRoundId } }
      );

      logger.error('❌ Error taking dividend snapshot:', error);
      Sentry.captureException(error, {
        tags: { service: 'dividend-service' },
        extra: { dividendRoundId }
      });
      throw error;
    }
  }

  /**
   * Calculate beneficiary snapshot data
   */
  async calculateBeneficiarySnapshot(beneficiary, vault, snapshotTimestamp, transaction) {
    try {
      // Calculate vested and unvested balances at snapshot time
      const vestingCalculation = await this.calculateVestingAtTimestamp(
        beneficiary,
        vault,
        snapshotTimestamp
      );

      // Determine eligibility
      const isEligible = vestingCalculation.totalBalance > 0;
      const ineligibilityReason = !isEligible ? 'No balance held at snapshot time' : null;

      // Create snapshot record
      const snapshot = await DividendSnapshot.create({
        dividend_round_id: vault.currentDividendRoundId, // This would be set during snapshot process
        vault_address: vault.address,
        beneficiary_address: beneficiary.address,
        total_balance: vestingCalculation.totalBalance.toString(),
        vested_balance: vestingCalculation.vestedBalance.toString(),
        unvested_balance: vestingCalculation.unvestedBalance.toString(),
        cliff_date: vestingCalculation.cliffDate,
        vesting_start_date: vestingCalculation.vestingStartDate,
        vesting_end_date: vestingCalculation.vestingEndDate,
        vesting_percentage: vestingCalculation.vestingPercentage,
        is_eligible: isEligible,
        ineligibility_reason: ineligibilityReason,
        snapshot_timestamp: snapshotTimestamp
      }, { transaction });

      return {
        snapshotId: snapshot.id,
        beneficiaryAddress: beneficiary.address,
        totalBalance: vestingCalculation.totalBalance,
        vestedBalance: vestingCalculation.vestedBalance,
        unvestedBalance: vestingCalculation.unvestedBalance,
        vestingPercentage: vestingCalculation.vestingPercentage,
        isEligible
      };

    } catch (error) {
      logger.error(`❌ Error calculating snapshot for beneficiary ${beneficiary.address}:`, error);
      throw error;
    }
  }

  /**
   * Calculate vested and unvested balances at a specific timestamp
   */
  async calculateVestingAtTimestamp(beneficiary, vault, timestamp) {
    try {
      const totalAllocated = parseFloat(beneficiary.total_allocated);
      const totalWithdrawn = parseFloat(beneficiary.total_withdrawn);
      const currentBalance = totalAllocated - totalWithdrawn;

      if (currentBalance <= 0) {
        return {
          totalBalance: 0,
          vestedBalance: 0,
          unvestedBalance: 0,
          vestingPercentage: 0,
          cliffDate: null,
          vestingStartDate: null,
          vestingEndDate: null
        };
      }

      // Get vesting schedules
      const schedules = beneficiary.subSchedules || [];
      
      if (schedules.length === 0) {
        // No vesting schedule - assume fully vested
        return {
          totalBalance: currentBalance,
          vestedBalance: currentBalance,
          unvestedBalance: 0,
          vestingPercentage: 1.0,
          cliffDate: null,
          vestingStartDate: null,
          vestingEndDate: null
        };
      }

      // Calculate vested amount based on schedules
      let totalVested = 0;
      let earliestCliffDate = null;
      let earliestVestingStart = null;
      let latestVestingEnd = null;

      for (const schedule of schedules) {
        if (schedule.is_active) {
          const scheduleVested = this.calculateScheduleVesting(schedule, timestamp);
          totalVested += scheduleVested;

          // Track dates
          if (schedule.cliff_date && (!earliestCliffDate || schedule.cliff_date < earliestCliffDate)) {
            earliestCliffDate = schedule.cliff_date;
          }
          if (schedule.vesting_start_date && (!earliestVestingStart || schedule.vesting_start_date < earliestVestingStart)) {
            earliestVestingStart = schedule.vesting_start_date;
          }
          if (schedule.vesting_end_date && (!latestVestingEnd || schedule.vesting_end_date > latestVestingEnd)) {
            latestVestingEnd = schedule.vesting_end_date;
          }
        }
      }

      // Ensure vested amount doesn't exceed current balance
      totalVested = Math.min(totalVested, currentBalance);
      const unvested = currentBalance - totalVested;
      const vestingPercentage = currentBalance > 0 ? totalVested / currentBalance : 0;

      return {
        totalBalance: currentBalance,
        vestedBalance: totalVested,
        unvestedBalance: unvested,
        vestingPercentage,
        cliffDate: earliestCliffDate,
        vestingStartDate: earliestVestingStart,
        vestingEndDate: latestVestingEnd
      };

    } catch (error) {
      logger.error('❌ Error calculating vesting:', error);
      throw error;
    }
  }

  /**
   * Calculate vested amount for a specific schedule at timestamp
   */
  calculateScheduleVesting(schedule, timestamp) {
    try {
      const { cliff_date, vesting_start_date, vesting_duration, start_timestamp, end_timestamp, top_up_amount } = schedule;
      
      const scheduleAmount = parseFloat(top_up_amount);
      const currentTime = timestamp.getTime();
      
      // Before cliff date
      if (cliff_date && currentTime < cliff_date.getTime()) {
        return 0;
      }
      
      // Before vesting starts
      if (vesting_start_date && currentTime < vesting_start_date.getTime()) {
        return 0;
      }
      
      // After vesting ends
      if (end_timestamp && currentTime >= end_timestamp.getTime()) {
        return scheduleAmount;
      }
      
      // During vesting period
      if (start_timestamp && end_timestamp && vesting_duration) {
        const startTime = start_timestamp.getTime();
        const endTime = end_timestamp.getTime();
        const elapsed = currentTime - startTime;
        const totalDuration = endTime - startTime;
        
        if (elapsed >= totalDuration) {
          return scheduleAmount;
        }
        
        const vestingProgress = elapsed / totalDuration;
        return scheduleAmount * vestingProgress;
      }
      
      return 0;

    } catch (error) {
      logger.error('❌ Error calculating schedule vesting:', error);
      return 0;
    }
  }

  /**
   * Calculate dividend distributions for all eligible beneficiaries
   */
  async calculateDividendDistributions(dividendRoundId) {
    const transaction = await sequelize.transaction();
    
    try {
      const dividendRound = await DividendRound.findByPk(dividendRoundId, { transaction });
      
      if (!dividendRound) {
        throw new Error('Dividend round not found');
      }

      if (dividendRound.status !== 'ready') {
        throw new Error('Dividend round must be in ready status to calculate distributions');
      }

      // Update status to calculating
      await dividendRound.update({ status: 'calculating' }, { transaction });

      // Get all eligible snapshots
      const snapshots = await DividendSnapshot.findAll({
        where: {
          dividend_round_id: dividendRoundId,
          is_eligible: true
        },
        order: [['eligible_balance', 'DESC']],
        transaction
      });

      logger.info(`💰 Calculating distributions for ${snapshots.length} eligible beneficiaries`);

      const totalDividendAmount = parseFloat(dividendRound.total_dividend_amount);
      const totalEligibleBalance = parseFloat(dividendRound.total_eligible_balance);

      if (totalEligibleBalance === 0) {
        throw new Error('No eligible balance found for dividend distribution');
      }

      let distributions = [];

      // Calculate distribution for each beneficiary
      for (const snapshot of snapshots) {
        const distribution = await this.calculateBeneficiaryDistribution(
          dividendRound,
          snapshot,
          totalDividendAmount,
          totalEligibleBalance,
          transaction
        );

        distributions.push(distribution);
      }

      // Update dividend round status
      await dividendRound.update({
        calculation_timestamp: new Date(),
        status: 'ready'
      }, { transaction });

      await transaction.commit();

      logger.info(`✅ Distribution calculations completed for ${distributions.length} beneficiaries`);

      // Send notification
      await this.notifyCalculationsCompleted(dividendRound, distributions.length);

      return distributions;

    } catch (error) {
      await transaction.rollback();
      
      // Mark round as failed
      await DividendRound.update(
        { status: 'failed' },
        { where: { id: dividendRoundId } }
      );

      logger.error('❌ Error calculating dividend distributions:', error);
      Sentry.captureException(error, {
        tags: { service: 'dividend-service' },
        extra: { dividendRoundId }
      });
      throw error;
    }
  }

  /**
   * Calculate dividend distribution for a single beneficiary
   */
  async calculateBeneficiaryDistribution(dividendRound, snapshot, totalDividendAmount, totalEligibleBalance, transaction) {
    try {
      const heldBalance = parseFloat(snapshot.total_balance);
      const vestedBalance = parseFloat(snapshot.vested_balance);
      const unvestedBalance = parseFloat(snapshot.unvested_balance);

      // Apply vested treatment rules
      let eligibleBalance = 0;

      switch (dividendRound.vested_treatment) {
        case 'full':
          // Both vested and unvested tokens get full dividend
          eligibleBalance = heldBalance;
          break;
          
        case 'proportional':
          // Vested tokens get full dividend, unvested get reduced amount
          eligibleBalance = vestedBalance + (unvestedBalance * dividendRound.unvested_multiplier);
          break;
          
        case 'vested_only':
          // Only vested tokens get dividend
          eligibleBalance = vestedBalance;
          break;
      }

      // Calculate pro-rata share
      const proRataShare = eligibleBalance / totalEligibleBalance;
      const dividendAmount = totalDividendAmount * proRataShare;

      // Create distribution record
      const distribution = await DividendDistribution.create({
        dividend_round_id: dividendRound.id,
        vault_address: snapshot.vault_address,
        beneficiary_address: snapshot.beneficiary_address,
        held_balance: heldBalance.toString(),
        vested_balance: vestedBalance.toString(),
        unvested_balance: unvestedBalance.toString(),
        eligible_balance: eligibleBalance.toString(),
        pro_rata_share: proRataShare,
        dividend_amount: dividendAmount.toString(),
        status: 'calculated'
      }, { transaction });

      return {
        distributionId: distribution.id,
        beneficiaryAddress: snapshot.beneficiary_address,
        heldBalance: heldBalance.toString(),
        eligibleBalance: eligibleBalance.toString(),
        proRataShare: proRataShare,
        dividendAmount: dividendAmount.toString()
      };

    } catch (error) {
      logger.error(`❌ Error calculating distribution for beneficiary ${snapshot.beneficiary_address}:`, error);
      throw error;
    }
  }

  /**
   * Distribute dividends via side-drip mechanism
   */
  async distributeDividends(dividendRoundId) {
    try {
      const dividendRound = await DividendRound.findByPk(dividendRoundId);
      
      if (!dividendRound) {
        throw new Error('Dividend round not found');
      }

      if (dividendRound.status !== 'ready') {
        throw new Error('Dividend round must be in ready status to distribute');
      }

      // Update status to distributing
      await dividendRound.update({ status: 'distributing' });

      // Get all calculated distributions
      const distributions = await DividendDistribution.findAll({
        where: {
          dividend_round_id: dividendRoundId,
          status: 'calculated'
        },
        order: [['dividend_amount', 'DESC']]
      });

      logger.info(`💸 Starting distribution of ${distributions.length} dividend payments`);

      let successCount = 0;
      let failureCount = 0;
      const totalAmount = parseFloat(dividendRound.total_dividend_amount);

      // Process distributions in batches
      for (let i = 0; i < distributions.length; i += this.distributionBatchSize) {
        const batch = distributions.slice(i, i + this.distributionBatchSize);
        
        const batchResults = await Promise.allSettled(
          batch.map(distribution => this.processSingleDistribution(distribution, dividendRound))
        );

        // Process batch results
        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            successCount++;
          } else {
            failureCount++;
            logger.error('❌ Distribution failed:', result.reason);
          }
        }

        // Small delay between batches to avoid overwhelming the network
        if (i + this.distributionBatchSize < distributions.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      // Update dividend round status
      const finalStatus = failureCount === 0 ? 'completed' : 'partial';
      await dividendRound.update({
        status: finalStatus,
        distribution_timestamp: new Date()
      });

      logger.info(`✅ Distribution completed: ${successCount} successful, ${failureCount} failed`);

      // Send notification
      await this.notifyDistributionCompleted(dividendRound, successCount, failureCount, totalAmount);

      return {
        dividendRoundId,
        status: finalStatus,
        successCount,
        failureCount,
        totalAmount: totalAmount.toString()
      };

    } catch (error) {
      logger.error('❌ Error distributing dividends:', error);
      
      // Mark round as failed
      await DividendRound.update(
        { status: 'failed' },
        { where: { id: dividendRoundId } }
      );

      Sentry.captureException(error, {
        tags: { service: 'dividend-service' },
        extra: { dividendRoundId }
      });
      throw error;
    }
  }

  /**
   * Process a single dividend distribution
   */
  async processSingleDistribution(distribution, dividendRound) {
    try {
      const dividendAmount = parseFloat(distribution.dividend_amount);
      const recipientAddress = distribution.beneficiary_address;
      const dividendToken = dividendRound.dividend_token;

      if (dividendAmount <= 0) {
        throw new Error('Dividend amount must be greater than 0');
      }

      // Send the dividend (side-drip)
      const transactionHash = await this.sendSideDripPayment(
        recipientAddress,
        dividendAmount,
        dividendToken
      );

      // Update distribution record
      await distribution.update({
        status: 'sent',
        transaction_hash: transactionHash,
        distributed_at: new Date()
      });

      logger.info(`💰 Sent ${dividendAmount} ${dividendToken} to ${recipientAddress} (tx: ${transactionHash})`);

      return {
        success: true,
        distributionId: distribution.id,
        transactionHash,
        amount: dividendAmount.toString()
      };

    } catch (error) {
      // Mark distribution as failed
      await distribution.update({
        status: 'failed',
        error_message: error.message
      });

      logger.error(`❌ Failed to send dividend to ${distribution.beneficiary_address}:`, error);
      throw error;
    }
  }

  /**
   * Send side-drip payment (mock implementation)
   */
  async sendSideDripPayment(recipientAddress, amount, token) {
    try {
      // This would integrate with Stellar/Soroban SDK or other blockchain
      // For now, we'll return a mock transaction hash
      
      logger.info(`🔄 Sending side-drip payment:`);
      logger.info(`   Recipient: ${recipientAddress}`);
      logger.info(`   Amount: ${amount} ${token}`);
      logger.info(`   Method: side-drip`);

      // Simulate transaction processing
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Mock transaction hash
      const mockTxHash = `0x${crypto.randomBytes(32).toString('hex')}`;

      return mockTxHash;

    } catch (error) {
      logger.error('❌ Error sending side-drip payment:', error);
      throw error;
    }
  }

  /**
   * Get dividend round details
   */
  async getDividendRound(dividendRoundId) {
    try {
      const dividendRound = await DividendRound.findByPk(dividendRoundId, {
        include: [
          {
            model: DividendDistribution,
            as: 'distributions'
          }
        ]
      });

      if (!dividendRound) {
        throw new Error('Dividend round not found');
      }

      return dividendRound;

    } catch (error) {
      logger.error('❌ Error getting dividend round:', error);
      throw error;
    }
  }

  /**
   * Get dividend rounds for a token
   */
  async getDividendRounds(tokenAddress, status = null) {
    try {
      const whereClause = { token_address: tokenAddress };
      if (status) {
        whereClause.status = status;
      }

      const rounds = await DividendRound.findAll({
        where: whereClause,
        order: [['created_at', 'DESC']]
      });

      return rounds;

    } catch (error) {
      logger.error('❌ Error getting dividend rounds:', error);
      throw error;
    }
  }

  /**
   * Get user's dividend history
   */
  async getUserDividendHistory(userAddress, limit = 50) {
    try {
      const distributions = await DividendDistribution.findAll({
        where: { beneficiary_address: userAddress },
        include: [
          {
            model: DividendRound,
            as: 'dividendRound'
          }
        ],
        order: [['created_at', 'DESC']],
        limit
      });

      return distributions;

    } catch (error) {
      logger.error('❌ Error getting user dividend history:', error);
      throw error;
    }
  }

  /**
   * Notification methods
   */
  async notifySnapshotCompleted(dividendRound, eligibleHolders, eligibleBalance) {
    try {
      const message = `📸 **Dividend Snapshot Completed**

**Dividend Round:** ${dividendRound.id}
**Token:** ${dividendRound.token_address}
**Total Amount:** ${dividendRound.total_dividend_amount} ${dividendRound.dividend_token}
**Eligible Holders:** ${eligibleHolders}
**Eligible Balance:** ${eligibleBalance}
**Vested Treatment:** ${dividendRound.vested_treatment}

Next: Calculate pro-rata distributions for each holder.`;

      await slackWebhookService.sendAlert(message, {
        channel: '#dividends',
        username: 'Dividend Service',
        priority: 'medium'
      });

    } catch (error) {
      logger.error('❌ Error sending snapshot notification:', error);
    }
  }

  async notifyCalculationsCompleted(dividendRound, distributionCount) {
    try {
      const message = `💰 **Dividend Calculations Completed**

**Dividend Round:** ${dividendRound.id}
**Distributions Calculated:** ${distributionCount}
**Ready for Distribution:** Yes

Next: Begin side-drip distribution to beneficiaries.`;

      await slackWebhookService.sendAlert(message, {
        channel: '#dividends',
        username: 'Dividend Service',
        priority: 'medium'
      });

    } catch (error) {
      logger.error('❌ Error sending calculations notification:', error);
    }
  }

  async notifyDistributionCompleted(dividendRound, successCount, failureCount, totalAmount) {
    try {
      const message = `💸 **Dividend Distribution Completed**

**Dividend Round:** ${dividendRound.id}
**Status:** ${failureCount === 0 ? '✅ Success' : '⚠️ Partial'}
**Successful:** ${successCount}
**Failed:** ${failureCount}
**Total Amount:** ${totalAmount} ${dividendRound.dividend_token}

${failureCount > 0 ? 'Some distributions failed. Please review error logs.' : 'All distributions completed successfully!'}`;

      await slackWebhookService.sendAlert(message, {
        channel: '#dividends',
        username: 'Dividend Service',
        priority: failureCount > 0 ? 'high' : 'medium'
      });

    } catch (error) {
      logger.error('❌ Error sending distribution notification:', error);
    }
  }

  /**
   * Get service statistics
   */
  async getStats() {
    try {
      const stats = await DividendRound.findAll({
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('id')), 'total'],
          [sequelize.fn('COUNT', sequelize.literal('CASE WHEN status = "pending" THEN 1 END')), 'pending'],
          [sequelize.fn('COUNT', sequelize.literal('CASE WHEN status = "ready" THEN 1 END')), 'ready'],
          [sequelize.fn('COUNT', sequelize.literal('CASE WHEN status = "completed" THEN 1 END')), 'completed'],
          [sequelize.fn('COUNT', sequelize.literal('CASE WHEN status = "failed" THEN 1 END')), 'failed'],
          [sequelize.fn('SUM', sequelize.col('total_dividend_amount')), 'totalDistributed']
        ],
        raw: true
      });

      return {
        rounds: stats[0],
        totalDistributed: stats[0].totalDistributed || '0'
      };

    } catch (error) {
      logger.error('❌ Error getting stats:', error);
      throw error;
    }
  }
}

module.exports = new DividendService();
