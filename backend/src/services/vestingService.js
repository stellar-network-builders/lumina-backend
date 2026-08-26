'use strict';

const logger = require('../utils/logger');
const { Vault, Beneficiary, SubSchedule } = require('../models');
const { sequelize } = require('../database/connection');
const auditLogger = require('./auditLogger');
const cacheInvalidationService = require('./cacheInvalidationService');

class VestingService {
  /**
   * Create a new vault.
   *
   * Supports two calling patterns for backward compatibility:
   *  1. Object parameter:     createVault({ address, owner_address, token_address, ... })
   *  2. Individual parameters: createVault(adminAddress, vaultAddress, ownerAddress, ...)
   */
  async createVault(
    adminAddressOrData,
    vaultAddress,
    ownerAddress,
    tokenAddress,
    totalAmount,
    startDate,
    endDate,
    cliffDate = null,
    tokenType = 'static'
  ) {
    try {
      let vaultData;
      let adminAddress;

      if (typeof adminAddressOrData === 'object' && adminAddressOrData !== null) {
        // ── Object-based call ──────────────────────────────────────────────
        vaultData = adminAddressOrData;
        adminAddress = vaultData.adminAddress || 'system';

        if (vaultData.token_type && !['static', 'dynamic'].includes(vaultData.token_type)) {
          throw new Error(`Invalid token type: ${vaultData.token_type}. Must be 'static' or 'dynamic'`);
        }

        const vault = await Vault.create({
          address: vaultData.address || vaultData.vault_address || vaultData.vaultAddress,
          name: vaultData.name,
          owner_address: vaultData.owner_address || vaultData.ownerAddress,
          token_address: vaultData.token_address || vaultData.tokenAddress,
          total_amount: vaultData.initial_amount || vaultData.total_amount || vaultData.initialAmount || 0,
          token_type: vaultData.token_type || vaultData.tokenType || 'static',
          tag: vaultData.tag,
          org_id: vaultData.org_id,
        });

        // Create beneficiaries if provided
        if (Array.isArray(vaultData.beneficiaries) && vaultData.beneficiaries.length > 0) {
          const beneficiaries = await Promise.all(
            vaultData.beneficiaries.map((b) =>
              Beneficiary.create({
                vault_id: vault.id,
                address: b.address,
                total_allocated: b.allocation || 0,
              })
            )
          );

          // Invalidate cache for each beneficiary
          await Promise.all(
            beneficiaries.map(beneficiary =>
              cacheInvalidationService.invalidateCacheAfterGrantIssuance({
                beneficiaryAddress: beneficiary.address,
                vaultId: vault.id,
                orgId: vault.org_id
              })
            )
          );
        }

        auditLogger.logAction(adminAddress, 'CREATE_VAULT', vault.address, {
          ownerAddress: vault.owner_address,
          tokenAddress: vault.token_address,
          totalAmount: vault.total_amount,
          tokenType: vault.token_type,
          name: vault.name,
          tag: vault.tag,
        });

        // Invalidate cache for vault creation
        await cacheInvalidationService.invalidateCacheForEvent('vault_created', {
          vaultId: vault.id,
          orgId: vault.org_id
        });

        return vault;
      } else {
        // ── Individual-parameter call ─────────────────────────────────────
        adminAddress = adminAddressOrData;

        if (tokenType && !['static', 'dynamic'].includes(tokenType)) {
          throw new Error(`Invalid token type: ${tokenType}. Must be 'static' or 'dynamic'`);
        }

        const vault = await Vault.create({
          address: vaultAddress,
          owner_address: ownerAddress,
          token_address: tokenAddress,
          total_amount: totalAmount || 0,
          token_type: tokenType || 'static',
        });

        auditLogger.logAction(adminAddress, 'CREATE_VAULT', vaultAddress, {
          ownerAddress,
          tokenAddress,
          totalAmount,
          tokenType: vault.token_type,
          startDate,
          endDate,
          cliffDate,
        });

        // Immutable Audit Log
        await AuditService.logAction({
          adminPubkey: adminAddress,
          action: AuditService.ACTIONS.CREATE_VESTING_SCHEDULE,
          ipAddress: 'unknown',
          payload: { vaultAddress, ownerAddress, tokenAddress, totalAmount, startDate, endDate, cliffDate },
          resourceId: vaultAddress
        });

        return {
          success: true,
          message: 'Vault created successfully',
          vault: {
            id: vault.id,
            address: vault.address,
            owner_address: vault.owner_address,
            token_address: vault.token_address,
            total_amount: vault.total_amount,
            token_type: vault.token_type,
            created_at: vault.created_at,
          },
          adminAddress,
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      logger.error('Error in createVault:', error);
      throw error;
    }
  }

  /**
   * Process a top-up for an existing vault.
   *
   * @param {Object} data
   * @param {string} data.vault_address
   * @param {string|number} data.amount
   * @param {number} data.cliff_duration_seconds
   * @param {number} data.vesting_duration_seconds
   * @param {string} data.transaction_hash
   * @param {number} [data.block_number]
   * @param {Date|string} [data.timestamp]
   * @returns {Promise<SubSchedule>}
   */
  async processTopUp(topUpData) {
    const { vault_address, vaultAddress, amount, transaction_hash, transactionHash, block_number, blockNumber, timestamp, event_index = 0 } = topUpData;
    const address = vault_address || vaultAddress;
    const txHash = transaction_hash || transactionHash;
    const blockNum = block_number || blockNumber;
    const cliff_duration = topUpData.cliff_duration !== undefined ? topUpData.cliff_duration : topUpData.cliff_duration_seconds;
    const vesting_duration = topUpData.vesting_duration !== undefined ? topUpData.vesting_duration : topUpData.vesting_duration_seconds;

    const vault = await Vault.findOne({ where: { address } });
    if (!vault) {
      throw new Error(`Vault not found: ${address}`);
    }

    if (vault.is_blacklisted) {
      throw new Error(`Vault ${address} is blacklisted due to integrity failure. Operations are disabled.`);
    }

    const topUpTimestamp = timestamp ? new Date(timestamp) : new Date();
    let cliffDate = null;
    let vestingStartDate = topUpTimestamp;

    const cliff_dur = topUpData.cliff_duration !== undefined ? topUpData.cliff_duration : topUpData.cliff_duration_seconds;
    const vesting_dur = topUpData.vesting_duration !== undefined ? topUpData.vesting_duration : topUpData.vesting_duration_seconds;

    if (cliff_dur && cliff_dur > 0) {
      cliffDate = new Date(topUpTimestamp.getTime() + cliff_dur * 1000);
      vestingStartDate = cliffDate;
    }

    const endTimestamp = new Date(vestingStartDate.getTime() + (vesting_dur || 0) * 1000);

    let subSchedule;
    try {
      subSchedule = await SubSchedule.create({
        vault_id: vault.id,
        top_up_amount: String(amount),
        cliff_duration: cliff_dur || 0,
        cliff_date: cliffDate,
        vesting_start_date: vestingStartDate,
        vesting_duration: vesting_dur || 0,
        start_timestamp: vestingStartDate,
        end_timestamp: endTimestamp,
        transaction_hash: txHash,
        event_index,
        block_number: blockNum || 0,
        amount_withdrawn: 0,
        amount_released: 0,
        is_active: true,
      });
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') {
        const existing = await SubSchedule.findOne({
          where: { transaction_hash: txHash, event_index }
        });
        if (existing) {
          logger.info(`Duplicate top-up detected: ${txHash}:${event_index}, returning existing record`);
          return existing;
        }
      }
      throw error;
    }

    // Update vault total_amount
    const currentTotal = parseFloat(vault.total_amount) || 0;
    const addAmount = parseFloat(amount) || 0;
    await vault.update({ total_amount: String(currentTotal + addAmount) });

    // Schedule unlock events in the priority queue
    const vestingUnlockSyncService = require('./vestingUnlockSyncService');
    if (subSchedule.cliff_date) {
      vestingUnlockSyncService.scheduleEvent({
        type: 'CLIFF_REACHED',
        subScheduleId: subSchedule.id,
        vaultId: vault.id
      }, subSchedule.cliff_date);
    }
    
    if (subSchedule.end_timestamp) {
      vestingUnlockSyncService.scheduleEvent({
        type: 'VESTING_COMPLETE',
        subScheduleId: subSchedule.id,
        vaultId: vault.id
      }, subSchedule.end_timestamp);
    }

    return subSchedule;
  }

  /**
   * Retrieve the full vesting schedule for a vault.
   *
   * @param {string} vaultAddress
   * @param {string} [beneficiaryAddress] - Optional filter
   * @returns {Promise<Object>}
   */
  async getVestingSchedule(vaultAddress, beneficiaryAddress = null) {
    const vault = await Vault.findOne({ where: { address: vaultAddress } });
    if (!vault) {
      throw new Error(`Vault not found: ${vaultAddress}`);
    }

    if (vault.is_blacklisted) {
      throw new Error(`Vault ${vaultAddress} is blacklisted due to integrity failure.`);
    }

    const subSchedules = await SubSchedule.findAll({ where: { vault_id: vault.id } });

    const bWhere = { vault_id: vault.id };
    if (beneficiaryAddress) {
      bWhere.address = beneficiaryAddress;
    }
    const beneficiaries = await Beneficiary.findAll({ where: bWhere });

    return {
      address: vault.address,
      name: vault.name,
      token_address: vault.token_address,
      owner_address: vault.owner_address,
      total_amount: vault.total_amount,
      subSchedules: subSchedules.map((s) => s.toJSON()),
      beneficiaries: beneficiaries.map((b) => b.toJSON()),
    };
  }

  /**
   * Calculate how much a beneficiary can withdraw right now.
   *
   * @param {string} vaultAddress
   * @param {string} beneficiaryAddress
   * @param {Date} [now]
   * @returns {Promise<{withdrawable: number, total_vested: number, already_withdrawn: number}>}
   */
  async calculateWithdrawableAmount(vaultAddress, beneficiaryAddress, now = new Date()) {
    const checkTime = new Date(now);

    const vault = await Vault.findOne({ where: { address: vaultAddress } });
    if (!vault) throw new Error(`Vault not found: ${vaultAddress}`);

    if (vault.is_blacklisted) {
      throw new Error(`Vault ${vaultAddress} is blacklisted due to integrity failure. Operations are disabled.`);
    }

    const beneficiary = await Beneficiary.findOne({
      where: { vault_id: vault.id, address: beneficiaryAddress },
    });
    if (!beneficiary) throw new Error(`Beneficiary not found: ${beneficiaryAddress}`);

    const subSchedules = await SubSchedule.findAll({ where: { vault_id: vault.id, is_active: true } });

    const totalAllocated = parseFloat(beneficiary.total_allocated) || 0;
    const totalVaultAmount = parseFloat(vault.total_amount) || 0;
    // Cap ratio at 1.0 to handle cases where allocation > total (e.g. single beneficiary tests)
    const allocationRatio = totalVaultAmount > 0 ? Math.min(1, totalAllocated / totalVaultAmount) : 0;

    let totalVested = 0;
    for (const schedule of subSchedules) {
      const cliffEnd = new Date(schedule.vesting_start_date);
      const startTime = new Date(schedule.vesting_start_date).getTime();
      const end = new Date(schedule.end_timestamp);
      const topUpAmount = parseFloat(schedule.top_up_amount) || 0;

      if (checkTime < cliffEnd) {
        // Before cliff end — nothing vested
        continue;
      }

      if (checkTime >= end) {
        // Fully vested
        totalVested += topUpAmount;
      } else {
        // Linear vesting from cliffEnd
        const base = cliffEnd.getTime();
        const elapsed = checkTime.getTime() - base;
        const totalDuration = end.getTime() - base;
        
        const ratio = totalDuration > 0 ? (elapsed / totalDuration) : 1;
        totalVested += topUpAmount * Math.min(1, Math.max(0, ratio));
      }
    }

    // Scale by beneficiary allocation ratio
    const beneficiaryVested = totalVested * allocationRatio;
    const alreadyWithdrawn = parseFloat(beneficiary.total_withdrawn) || 0;
    const withdrawable = Math.max(0, beneficiaryVested - alreadyWithdrawn);

    return {
      withdrawable,
      total_vested: beneficiaryVested,
      already_withdrawn: alreadyWithdrawn,
    };
  }

  /**
   * Process a withdrawal for a beneficiary.
   * Updated to track cumulative claimed amounts to prevent dust loss.
   *
   * @param {Object} data
   * @param {string} data.vault_address
   * @param {string} data.beneficiary_address
   * @param {string|number} data.amount
   * @param {string} data.transaction_hash
   * @param {number} [data.block_number]
   * @param {Date|string} [data.timestamp]
   * @returns {Promise<{success: boolean, amount_withdrawn: number, distribution: Array}>}
   */
  async processWithdrawal(data) {
    const {
      vault_address,
      beneficiary_address,
      amount,
      transaction_hash,
      block_number = 0,
      timestamp,
    } = data;

    const withdrawTime = timestamp ? new Date(timestamp) : new Date();
    const withdrawAmount = parseFloat(amount);

    const { withdrawable } = await this.calculateWithdrawableAmount(
      vault_address,
      beneficiary_address,
      withdrawTime
    );

    if (withdrawAmount > withdrawable + 0.0001) {
      // small epsilon for float rounding
      throw new Error(
        `Insufficient vested amount. Requested: ${withdrawAmount}, Available: ${withdrawable.toFixed(6)}`
      );
    }

    const vault = await Vault.findOne({ where: { address: vault_address } });
    const beneficiary = await Beneficiary.findOne({
      where: { vault_id: vault.id, address: beneficiary_address },
    });

    // Update beneficiary total_withdrawn (legacy field)
    const newWithdrawn = parseFloat(beneficiary.total_withdrawn) + withdrawAmount;
    await beneficiary.update({ total_withdrawn: String(newWithdrawn) });

    // Update subschedule cumulative_claimed_amount to prevent dust loss
    const subSchedules = await SubSchedule.findAll({ 
      where: { vault_id: vault.id, is_active: true } 
    });

    // Distribute withdrawal proportionally across subschedules
    const totalVested = subSchedules.reduce((total, schedule) => {
      const vested = this._calculateScheduleVestedAmount(schedule, withdrawTime);
      return total + vested;
    }, 0);

    const distribution = [];
    for (const schedule of subSchedules) {
      const scheduleVested = this._calculateScheduleVestedAmount(schedule, withdrawTime);
      if (totalVested > 0 && scheduleVested > 0) {
        const proportion = scheduleVested / totalVested;
        const scheduleWithdrawAmount = withdrawAmount * proportion;
        
        // Update cumulative claimed amount for this subschedule
        const currentCumulative = parseFloat(schedule.cumulative_claimed_amount || 0);
        const newCumulative = currentCumulative + scheduleWithdrawAmount;
        await schedule.update({ cumulative_claimed_amount: String(newCumulative) });

        distribution.push({
          subschedule_id: schedule.id,
          amount: scheduleWithdrawAmount,
          transaction_hash,
        });
      }
    }

    auditLogger.logAction(beneficiary_address, 'WITHDRAWAL', vault_address, {
      amount: withdrawAmount,
      transaction_hash,
      block_number,
      timestamp: withdrawTime,
    });

    // Accumulate protocol sustainability fee (0.1% by default)
    try {
        const feeDistributorService = require('./feeDistributorService');
        await feeDistributorService.accumulateFeeForVault(vault.id, withdrawAmount);
    } catch (feeError) {
        logger.warn('Failed to accumulate protocol fee:', feeError.message);
    }

    return {
      success: true,
      amount_withdrawn: withdrawAmount,
      distribution,
    };
  }

  /**
   * Helper method to calculate vested amount for a subschedule
   * Uses the same logic as ClaimCalculator to prevent dust loss
   * @private
   */
  _calculateScheduleVestedAmount(subSchedule, currentTime) {
    const asOfDate = currentTime instanceof Date ? currentTime : new Date(currentTime);
    
    // Check if cliff has passed
    if (subSchedule.cliff_date && asOfDate < subSchedule.cliff_date) {
      return 0;
    }

    // Check if vesting hasn't started
    if (asOfDate < subSchedule.vesting_start_date) {
      return 0;
    }

    // Check if vesting has fully completed
    const vestingEnd = new Date(
      subSchedule.vesting_start_date.getTime() + subSchedule.vesting_duration * 1000
    );
    if (asOfDate >= vestingEnd) {
      return parseFloat(subSchedule.top_up_amount);
    }

    // Calculate vested amount using the new formula: Total_Vested = (Elapsed_Time * Total_Allocation) / Total_Duration
    const elapsedTimeInSeconds = Math.floor((asOfDate - subSchedule.vesting_start_date) / 1000);
    const totalAllocation = parseFloat(subSchedule.top_up_amount);
    const totalDurationInSeconds = subSchedule.vesting_duration;
    
    const totalVested = (elapsedTimeInSeconds * totalAllocation) / totalDurationInSeconds;
    return totalVested;
  }

  /**
   * Calculate a clean break payout for a terminated beneficiary.
   *
   * Returns two-part instructions:
   *  1) accrued earned tokens to employee
   *  2) unearned tokens back to treasury
   */
  async calculateCleanBreak(vaultAddress, beneficiaryAddress, terminationTime = new Date(), treasuryAddress = null) {
    const terminationDate = new Date(terminationTime);

    const vault = await Vault.findOne({ where: { address: vaultAddress } });
    if (!vault) {
      throw new Error(`Vault not found: ${vaultAddress}`);
    }
    if (vault.is_blacklisted) {
      throw new Error(`Vault ${vaultAddress} is blacklisted due to integrity failure. Operations are disabled.`);
    }

    const beneficiary = await Beneficiary.findOne({ where: { vault_id: vault.id, address: beneficiaryAddress } });
    if (!beneficiary) {
      throw new Error(`Beneficiary not found: ${beneficiaryAddress}`);
    }

    // Calculate direct vesting from active sub-schedules at terminationDate.
    const subSchedules = await SubSchedule.findAll({ where: { vault_id: vault.id, is_active: true } });

    let rawVestedAmount = 0;
    let totalScheduleAmount = 0;

    for (const schedule of subSchedules) {
      const topUpAmount = parseFloat(schedule.top_up_amount) || 0;
      const cliffEnd = new Date(schedule.vesting_start_date);
      const startTime = cliffEnd.getTime();
      const endTime = new Date(schedule.end_timestamp).getTime();

      totalScheduleAmount += topUpAmount;

      if (terminationDate < cliffEnd) {
        continue;
      }

      if (terminationDate >= endTime) {
        rawVestedAmount += topUpAmount;
      } else {
        const elapsed = terminationDate.getTime() - startTime;
        const duration = endTime - startTime;
        const vestedRatio = duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 1;
        rawVestedAmount += topUpAmount * vestedRatio;
      }
    }

    const totalAllocated = parseFloat(beneficiary.total_allocated) || 0;
    const allocationRatio = totalScheduleAmount > 0 ? Math.min(1, totalAllocated / totalScheduleAmount) : 0;

    const totalVested = rawVestedAmount * allocationRatio;
    const alreadyWithdrawn = parseFloat(beneficiary.total_withdrawn) || 0;

    const accruedSinceLastClaim = Math.max(0, totalVested - alreadyWithdrawn);
    const unearnedAmount = Math.max(0, totalAllocated - totalVested);

    const employeeTransfer = {
      from: vault.owner_address,
      to: beneficiary.address,
      amount: parseFloat(accruedSinceLastClaim).toString(),
      type: 'CLEAN_BREAK_EARNED_PAYOUT',
      memo: 'Pro-rata vested accrued amount at termination',
    };

    const treasuryTransfer = {
      from: vault.owner_address,
      to: treasuryAddress || vault.owner_address,
      amount: parseFloat(unearnedAmount).toString(),
      type: 'CLEAN_BREAK_UNEARNED_RETURN',
      memo: 'Unvested amount returned to treasury on termination',
    };

    return {
      vault_address: vaultAddress,
      beneficiary_address: beneficiaryAddress,
      termination_timestamp: terminationDate.toISOString(),
      accrued_since_last_claim: accruedSinceLastClaim,
      total_vested_at_termination: totalVested,
      total_allocated: totalAllocated,
      unearned_amount: unearnedAmount,
      treasury_address: treasuryAddress || vault.owner_address,
      transactions: {
        employee_transfer: employeeTransfer,
        treasury_transfer: treasuryTransfer,
      },
    };
  }

  /**
   * Get a compact summary of a vault.
   *
   * @param {string} vaultAddress
   * @returns {Promise<Object>}
   */
  async getVaultSummary(vaultAddress) {
    const vault = await Vault.findOne({ where: { address: vaultAddress } });
    if (!vault) throw new Error(`Vault not found: ${vaultAddress}`);

    const subSchedules = await SubSchedule.findAll({ where: { vault_id: vault.id } });
    const beneficiaries = await Beneficiary.findAll({ where: { vault_id: vault.id } });

    const totalAmount = subSchedules.reduce(
      (sum, s) => sum + (parseFloat(s.top_up_amount) || 0),
      0
    );

    return {
      vault_address: vault.address,
      name: vault.name,
      token_address: vault.token_address,
      owner_address: vault.owner_address,
      total_amount: totalAmount,
      total_top_ups: subSchedules.length,
      total_beneficiaries: beneficiaries.length,
      sub_schedules: subSchedules.map((s) => s.toJSON()),
      beneficiaries: beneficiaries.map((b) => b.toJSON()),
    };
  }
}

module.exports = new VestingService();
