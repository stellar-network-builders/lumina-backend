'use strict';

const logger = require('../utils/logger');
const { Vault, Beneficiary, SubSchedule } = require('../models');
const { sequelize } = require('../database/connection');
const auditLogger = require('./auditLogger');

class AccountConsolidationService {
  /**
   * Get consolidated vesting information for a beneficiary across all vaults
   * 
   * @param {string} beneficiaryAddress - The wallet address of the beneficiary
   * @param {Object} options - Optional filters
   * @param {string} options.organizationId - Filter by specific organization
   * @param {string} options.tokenAddress - Filter by specific token
   * @param {Array<string>} options.vaultAddresses - Filter by specific vaults
   * @param {Date} options.asOfDate - Calculate as of specific date (default: now)
   * @returns {Promise<Object>} Consolidated vesting information
   */
  async getConsolidatedView(beneficiaryAddress, options = {}) {
    const {
      organizationId,
      tokenAddress,
      vaultAddresses,
      asOfDate = new Date()
    } = options;

    try {
      // Build query conditions
      const whereConditions = {
        address: beneficiaryAddress
      };

      const vaultWhereConditions = {};
      if (organizationId) {
        vaultWhereConditions.org_id = organizationId;
      }
      if (tokenAddress) {
        vaultWhereConditions.token_address = tokenAddress;
      }
      if (vaultAddresses && vaultAddresses.length > 0) {
        vaultWhereConditions.address = vaultAddresses;
      }

      // Find all beneficiary records across all vaults
      const beneficiaries = await Beneficiary.findAll({
        where: whereConditions,
        include: [{
          model: Vault,
          as: 'vault',
          where: vaultWhereConditions,
          include: [{
            model: SubSchedule,
            as: 'subSchedules',
            where: { is_active: true }
          }]
        }]
      });

      if (!beneficiaries || beneficiaries.length === 0) {
        return {
          beneficiary_address: beneficiaryAddress,
          total_vaults: 0,
          total_allocated: '0',
          total_withdrawn: '0',
          total_withdrawable: '0',
          total_vested: '0',
          weighted_average_cliff_date: null,
          weighted_average_end_date: null,
          vaults: [],
          consolidation_summary: {
            original_vesting_tracks: 0,
            consolidated_tracks: 0,
            consolidation_efficiency: 0
          }
        };
      }

      // Process each vault and calculate consolidated metrics
      const vaultDetails = [];
      let totalAllocated = 0;
      let totalWithdrawn = 0;
      let totalWithdrawable = 0;
      let totalVested = 0;
      let totalVestingDuration = 0;
      let totalCliffWeight = 0;
      let totalEndWeight = 0;

      for (const beneficiary of beneficiaries) {
        const vault = beneficiary.vault;
        
        // Skip blacklisted vaults
        if (vault.is_blacklisted) {
          continue;
        }

        const vaultAllocated = parseFloat(beneficiary.total_allocated) || 0;
        const vaultWithdrawn = parseFloat(beneficiary.total_withdrawn) || 0;

        // Calculate vault-specific withdrawable amount
        const vaultWithdrawableInfo = await this._calculateVaultWithdrawable(
          vault, 
          beneficiaryAddress, 
          asOfDate
        );

        const vaultWithdrawable = vaultWithdrawableInfo.withdrawable;
        const vaultVested = vaultWithdrawableInfo.total_vested;

        // Calculate weighted average dates for this vault
        const vaultWeightedDates = this._calculateVaultWeightedDates(
          vault.subSchedules,
          vaultAllocated
        );

        // Accumulate totals
        totalAllocated += vaultAllocated;
        totalWithdrawn += vaultWithdrawn;
        totalWithdrawable += vaultWithdrawable;
        totalVested += vaultVested;

        // For weighted averages, use allocation as weight
        if (vaultAllocated > 0) {
          totalCliffWeight += vaultWeightedDates.cliffWeight;
          totalEndWeight += vaultWeightedDates.endWeight;
          totalVestingDuration += vaultWeightedDates.duration * vaultAllocated;
        }

        vaultDetails.push({
          vault_address: vault.address,
          vault_name: vault.name,
          token_address: vault.token_address,
          organization_id: vault.org_id,
          allocated: vaultAllocated.toString(),
          withdrawn: vaultWithdrawn.toString(),
          withdrawable: vaultWithdrawable.toString(),
          vested: vaultVested.toString(),
          cliff_date: vaultWeightedDates.cliffDate,
          end_date: vaultWeightedDates.endDate,
          vesting_duration_seconds: vaultWeightedDates.duration,
          sub_schedules_count: vault.subSchedules.length,
          tag: vault.tag
        });
      }

      // Calculate final weighted averages
      const weightedAverageCliffDate = totalCliffWeight > 0 
        ? new Date(totalCliffWeight / totalAllocated)
        : null;

      const weightedAverageEndDate = totalEndWeight > 0
        ? new Date(totalEndWeight / totalAllocated)
        : null;

      const averageVestingDuration = totalAllocated > 0
        ? totalVestingDuration / totalAllocated
        : 0;

      return {
        beneficiary_address: beneficiaryAddress,
        as_of_date: asOfDate.toISOString(),
        total_vaults: vaultDetails.length,
        total_allocated: totalAllocated.toString(),
        total_withdrawn: totalWithdrawn.toString(),
        total_withdrawable: totalWithdrawable.toString(),
        total_vested: totalVested.toString(),
        weighted_average_cliff_date: weightedAverageCliffDate?.toISOString() || null,
        weighted_average_end_date: weightedAverageEndDate?.toISOString() || null,
        average_vesting_duration_seconds: Math.round(averageVestingDuration),
        vaults: vaultDetails,
        consolidation_summary: {
          original_vesting_tracks: vaultDetails.reduce((sum, v) => sum + v.sub_schedules_count, 0),
          consolidated_tracks: vaultDetails.length,
          consolidation_efficiency: vaultDetails.length > 0 
            ? Math.round((1 - vaultDetails.length / vaultDetails.reduce((sum, v) => sum + v.sub_schedules_count, 0)) * 100)
            : 0
        }
      };

    } catch (error) {
      logger.error('Error in getConsolidatedView:', error);
      throw error;
    }
  }

  /**
   * Merge multiple beneficiary addresses into a single primary address
   * This is useful when a user changes their wallet address
   * 
   * @param {string} primaryAddress - The main wallet address to consolidate into
   * @param {Array<string>} addressesToMerge - Addresses to merge into primary
   * @param {string} adminAddress - Admin performing the merge
   * @returns {Promise<Object>} Merge results
   */
  async mergeBeneficiaryAddresses(primaryAddress, addressesToMerge, adminAddress) {
    const transaction = await sequelize.transaction();
    
    try {
      // Validate primary address exists
      const primaryBeneficiaries = await Beneficiary.findAll({
        where: { address: primaryAddress },
        transaction
      });

      if (primaryBeneficiaries.length === 0) {
        throw new Error(`Primary beneficiary address not found: ${primaryAddress}`);
      }

      const mergeResults = {
        primary_address: primaryAddress,
        merged_addresses: [],
        vaults_updated: 0,
        total_allocation_transferred: '0',
        total_withdrawal_transferred: '0'
      };

      let totalAllocationTransferred = 0;
      let totalWithdrawalTransferred = 0;

      for (const addressToMerge of addressesToMerge) {
        // Find all beneficiary records for the address to merge
        const beneficiariesToMerge = await Beneficiary.findAll({
          where: { address: addressToMerge },
          include: [{
            model: Vault,
            as: 'vault'
          }],
          transaction
        });

        if (beneficiariesToMerge.length === 0) {
          continue; // Skip if no records found
        }

        for (const beneficiaryToMerge of beneficiariesToMerge) {
          const vault = beneficiaryToMerge.vault;
          
          // Check if primary address already has a beneficiary record for this vault
          const existingPrimary = await Beneficiary.findOne({
            where: {
              vault_id: vault.id,
              address: primaryAddress
            },
            transaction
          });

          if (existingPrimary) {
            // Merge into existing record
            const newAllocation = parseFloat(existingPrimary.total_allocated) + parseFloat(beneficiaryToMerge.total_allocated);
            const newWithdrawn = parseFloat(existingPrimary.total_withdrawn) + parseFloat(beneficiaryToMerge.total_withdrawn);
            
            await existingPrimary.update({
              total_allocated: newAllocation.toString(),
              total_withdrawn: newWithdrawn.toString()
            }, { transaction });

            totalAllocationTransferred += parseFloat(beneficiaryToMerge.total_allocated);
            totalWithdrawalTransferred += parseFloat(beneficiaryToMerge.total_withdrawn);
          } else {
            // Create new beneficiary record for primary address
            await Beneficiary.create({
              vault_id: vault.id,
              address: primaryAddress,
              total_allocated: beneficiaryToMerge.total_allocated,
              total_withdrawn: beneficiaryToMerge.total_withdrawn,
              email: beneficiaryToMerge.email,
              email_valid: beneficiaryToMerge.email_valid
            }, { transaction });

            totalAllocationTransferred += parseFloat(beneficiaryToMerge.total_allocated);
            totalWithdrawalTransferred += parseFloat(beneficiaryToMerge.total_withdrawn);
          }

          // Delete the old beneficiary record
          await beneficiaryToMerge.destroy({ transaction });
        }

        mergeResults.merged_addresses.push(addressToMerge);
        mergeResults.vaults_updated += beneficiariesToMerge.length;
      }

      mergeResults.total_allocation_transferred = totalAllocationTransferred.toString();
      mergeResults.total_withdrawal_transferred = totalWithdrawalTransferred.toString();

      // Log the merge operation
      await auditLogger.logAction(adminAddress, 'MERGE_BENEFICIARY_ADDRESSES', primaryAddress, {
        merged_addresses: addressesToMerge,
        vaults_updated: mergeResults.vaults_updated,
        total_allocation_transferred: mergeResults.total_allocation_transferred
      });

      await transaction.commit();

      return mergeResults;

    } catch (error) {
      await transaction.rollback();
      logger.error('Error in mergeBeneficiaryAddresses:', error);
      throw error;
    }
  }

  /**
   * Calculate withdrawable amount for a specific vault
   * @private
   */
  async _calculateVaultWithdrawable(vault, beneficiaryAddress, asOfDate) {
    const beneficiary = vault.beneficiaries?.find(b => b.address === beneficiaryAddress);
    if (!beneficiary) {
      return { withdrawable: 0, total_vested: 0 };
    }

    const totalAllocated = parseFloat(beneficiary.total_allocated) || 0;
    const totalVaultAmount = parseFloat(vault.total_amount) || 0;
    const allocationRatio = totalVaultAmount > 0 ? Math.min(1, totalAllocated / totalVaultAmount) : 0;

    let totalVested = 0;
    const checkTime = new Date(asOfDate);

    for (const schedule of vault.subSchedules) {
      const cliffEnd = new Date(schedule.vesting_start_date);
      const startTime = new Date(schedule.vesting_start_date).getTime();
      const end = new Date(schedule.end_timestamp);
      const topUpAmount = parseFloat(schedule.top_up_amount) || 0;

      if (checkTime < cliffEnd) {
        continue; // Before cliff end
      }

      if (checkTime >= end) {
        totalVested += topUpAmount; // Fully vested
      } else {
        // Linear vesting from cliffEnd
        const base = cliffEnd.getTime();
        const elapsed = checkTime.getTime() - base;
        const totalDuration = end.getTime() - base;
        
        const ratio = totalDuration > 0 ? (elapsed / totalDuration) : 1;
        totalVested += topUpAmount * Math.min(1, Math.max(0, ratio));
      }
    }

    const beneficiaryVested = totalVested * allocationRatio;
    const alreadyWithdrawn = parseFloat(beneficiary.total_withdrawn) || 0;
    const withdrawable = Math.max(0, beneficiaryVested - alreadyWithdrawn);

    return {
      withdrawable,
      total_vested: beneficiaryVested
    };
  }

  /**
   * Calculate weighted average cliff and end dates for a vault's sub-schedules
   * @private
   */
  _calculateVaultWeightedDates(subSchedules, totalAllocation) {
    if (!subSchedules || subSchedules.length === 0 || totalAllocation === 0) {
      return {
        cliffDate: null,
        endDate: null,
        duration: 0,
        cliffWeight: 0,
        endWeight: 0
      };
    }

    let cliffWeightSum = 0;
    let endWeightSum = 0;
    let totalDuration = 0;
    let totalWeight = 0;

    for (const schedule of subSchedules) {
      const amount = parseFloat(schedule.top_up_amount) || 0;
      const weight = amount; // Use amount as weight
      
      if (weight > 0) {
        const cliffDate = schedule.cliff_date ? new Date(schedule.cliff_date).getTime() : new Date(schedule.vesting_start_date).getTime();
        const endDate = new Date(schedule.end_timestamp).getTime();
        const duration = parseFloat(schedule.vesting_duration) || 0;

        cliffWeightSum += cliffDate * weight;
        endWeightSum += endDate * weight;
        totalDuration += duration * weight;
        totalWeight += weight;
      }
    }

    return {
      cliffDate: totalWeight > 0 ? new Date(cliffWeightSum / totalWeight) : null,
      endDate: totalWeight > 0 ? new Date(endWeightSum / totalWeight) : null,
      duration: totalWeight > 0 ? totalDuration / totalWeight : 0,
      cliffWeight: cliffWeightSum,
      endWeight: endWeightSum
    };
  }
}

module.exports = new AccountConsolidationService();
