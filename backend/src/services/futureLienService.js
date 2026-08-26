'use strict';

const logger = require('../utils/logger');
const { GrantStream, FutureLien, LienRelease, LienMilestone, Vault, Beneficiary, sequelize } = require('../models');
const vestingService = require('./vestingService');
const auditLogger = require('./auditLogger');

class FutureLienService {
  /**
   * Create a new future lien - commit future vesting tokens to a grant stream
   * 
   * @param {Object} data - Lien creation data
   * @param {string} data.vault_address - Address of the vesting vault
   * @param {string} data.beneficiary_address - Address of the beneficiary committing tokens
   * @param {number} data.grant_stream_id - ID of the grant stream
   * @param {number} data.committed_amount - Amount to commit (in token units)
   * @param {Date} data.release_start_date - When releases can start
   * @param {Date} data.release_end_date - When releases must end
   * @param {string} data.release_rate_type - 'linear', 'milestone', or 'immediate'
   * @param {Array} data.milestones - Milestone definitions (for milestone-based releases)
   * @param {string} data.transaction_hash - Transaction hash for lien creation
   * @param {string} data.contract_interaction_hash - Contract interaction hash
   * @param {string} creator_address - Address creating the lien
   * @returns {Promise<Object>} Created lien with details
   */
  async createFutureLien(data, creatorAddress) {
    const transaction = await sequelize.transaction();
    
    try {
      const {
        vault_address,
        beneficiary_address,
        grant_stream_id,
        committed_amount,
        release_start_date,
        release_end_date,
        release_rate_type = 'linear',
        milestones = [],
        transaction_hash,
        contract_interaction_hash,
        metadata = {}
      } = data;

      // Validate vault and beneficiary
      const vault = await Vault.findOne({
        where: { address: vault_address },
        include: [{ model: Beneficiary, as: 'beneficiaries' }],
        transaction
      });
      
      if (!vault) {
        throw new Error(`Vault not found: ${vault_address}`);
      }
      
      if (vault.is_blacklisted) {
        throw new Error(`Vault ${vault_address} is blacklisted due to integrity failure`);
      }

      const beneficiary = vault.beneficiaries.find(b => b.address === beneficiary_address);
      if (!beneficiary) {
        throw new Error(`Beneficiary ${beneficiary_address} not found in vault ${vault_address}`);
      }

      // Validate grant stream
      const grantStream = await GrantStream.findByPk(grant_stream_id, { transaction });
      if (!grantStream) {
        throw new Error(`Grant stream not found: ${grant_stream_id}`);
      }
      
      if (!grantStream.is_active) {
        throw new Error(`Grant stream ${grant_stream_id} is not active`);
      }

      // Check for existing lien
      const existingLien = await FutureLien.findOne({
        where: {
          vault_address,
          beneficiary_address,
          grant_stream_id
        },
        transaction
      });
      
      if (existingLien) {
        throw new Error(`Lien already exists for vault ${vault_address}, beneficiary ${beneficiary_address}, grant stream ${grant_stream_id}`);
      }

      // Validate committed amount against beneficiary allocation
      const beneficiaryAllocation = parseFloat(beneficiary.total_allocated) || 0;
      if (committed_amount > beneficiaryAllocation) {
        throw new Error(`Committed amount ${committed_amount} exceeds beneficiary allocation ${beneficiaryAllocation}`);
      }

      // Get vesting schedule for validation
      const vestingSchedule = await vestingService.getVestingSchedule(vault_address, beneficiary_address);
      const vestingEndDate = new Date(Math.max(...vestingSchedule.subSchedules.map(s => new Date(s.end_timestamp))));
      
      // Validate release dates
      const releaseStart = new Date(release_start_date);
      const releaseEnd = new Date(release_end_date);
      
      if (releaseEnd <= releaseStart) {
        throw new Error('Release end date must be after release start date');
      }
      
      if (releaseStart < new Date()) {
        throw new Error('Release start date cannot be in the past');
      }

      // Create the lien
      const lien = await FutureLien.create({
        vault_address,
        beneficiary_address,
        grant_stream_id,
        committed_amount,
        released_amount: 0,
        vesting_start_date: vestingSchedule.subSchedules[0]?.vesting_start_date || new Date(),
        vesting_end_date: vestingEndDate,
        cliff_date: vestingSchedule.subSchedules[0]?.cliff_date,
        release_start_date: releaseStart,
        release_end_date: releaseEnd,
        release_rate_type,
        status: 'pending',
        is_active: true,
        creation_transaction_hash: transaction_hash,
        contract_interaction_hash,
        metadata
      }, { transaction });

      // Create milestones if milestone-based release
      if (release_rate_type === 'milestone' && milestones.length > 0) {
        const totalPercentage = milestones.reduce((sum, m) => sum + parseFloat(m.percentage_of_total), 0);
        if (Math.abs(totalPercentage - 100) > 0.01) {
          throw new Error(`Milestone percentages must sum to 100%, got ${totalPercentage}%`);
        }

        for (const milestone of milestones) {
          await LienMilestone.create({
            lien_id: lien.id,
            name: milestone.name,
            description: milestone.description,
            target_date: milestone.target_date,
            percentage_of_total: milestone.percentage_of_total,
            is_completed: false
          }, { transaction });
        }
      }

      await transaction.commit();

      // Log the action
      auditLogger.logAction(creatorAddress, 'CREATE_FUTURE_LIEN', lien.id, {
        vault_address,
        beneficiary_address,
        grant_stream_id,
        committed_amount,
        release_rate_type,
        transaction_hash
      });

      // Return the created lien with associations
      const result = await FutureLien.findByPk(lien.id, {
        include: [
          { model: GrantStream, as: 'grantStream' },
          { model: LienMilestone, as: 'milestones' }
        ]
      });

      return {
        success: true,
        lien: result.toJSON(),
        message: 'Future lien created successfully'
      };

    } catch (error) {
      await transaction.rollback();
      logger.error('Error creating future lien:', error);
      throw error;
    }
  }

  /**
   * Get all liens for a specific beneficiary
   * 
   * @param {string} beneficiaryAddress - Beneficiary address
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Array of liens
   */
  async getBeneficiaryLiens(beneficiaryAddress, options = {}) {
    const { status, includeInactive = false } = options;
    
    const whereClause = { beneficiary_address: beneficiaryAddress };
    if (status) {
      whereClause.status = status;
    }
    if (!includeInactive) {
      whereClause.is_active = true;
    }

    const liens = await FutureLien.findAll({
      where: whereClause,
      include: [
        { model: GrantStream, as: 'grantStream' },
        { model: LienRelease, as: 'releases' },
        { model: LienMilestone, as: 'milestones' }
      ],
      order: [['created_at', 'DESC']]
    });

    return liens.map(lien => ({
      ...lien.toJSON(),
      available_for_release: lien.calculateAvailableForRelease(),
      remaining_amount: lien.getRemainingAmount()
    }));
  }

  /**
   * Get all liens for a specific vault
   * 
   * @param {string} vaultAddress - Vault address
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Array of liens
   */
  async getVaultLiens(vaultAddress, options = {}) {
    const { status, includeInactive = false } = options;
    
    const whereClause = { vault_address: vaultAddress };
    if (status) {
      whereClause.status = status;
    }
    if (!includeInactive) {
      whereClause.is_active = true;
    }

    const liens = await FutureLien.findAll({
      where: whereClause,
      include: [
        { model: GrantStream, as: 'grantStream' },
        { model: LienRelease, as: 'releases' },
        { model: LienMilestone, as: 'milestones' }
      ],
      order: [['created_at', 'DESC']]
    });

    return liens.map(lien => ({
      ...lien.toJSON(),
      available_for_release: lien.calculateAvailableForRelease(),
      remaining_amount: lien.getRemainingAmount()
    }));
  }

  /**
   * Get all liens for a grant stream
   * 
   * @param {number} grantStreamId - Grant stream ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Array of liens
   */
  async getGrantStreamLiens(grantStreamId, options = {}) {
    const { status, includeInactive = false } = options;
    
    const whereClause = { grant_stream_id: grantStreamId };
    if (status) {
      whereClause.status = status;
    }
    if (!includeInactive) {
      whereClause.is_active = true;
    }

    const liens = await FutureLien.findAll({
      where: whereClause,
      include: [
        { model: GrantStream, as: 'grantStream' },
        { model: LienRelease, as: 'releases' },
        { model: LienMilestone, as: 'milestones' }
      ],
      order: [['created_at', 'DESC']]
    });

    return liens.map(lien => ({
      ...lien.toJSON(),
      available_for_release: lien.calculateAvailableForRelease(),
      remaining_amount: lien.getRemainingAmount()
    }));
  }

  /**
   * Process a release from a lien to the grant stream
   * 
   * @param {Object} data - Release data
   * @param {number} data.lien_id - ID of the lien
   * @param {number} data.amount - Amount to release (optional, calculated if not provided)
   * @param {number} data.milestone_id - Milestone ID (for milestone-based releases)
   * @param {string} data.transaction_hash - Transaction hash
   * @param {number} data.block_number - Block number
   * @param {string} processor_address - Address processing the release
   * @returns {Promise<Object>} Release result
   */
  async processLienRelease(data, processorAddress) {
    const transaction = await sequelize.transaction();
    
    try {
      const {
        lien_id,
        amount,
        milestone_id,
        transaction_hash,
        block_number
      } = data;

      // Get the lien
      const lien = await FutureLien.findByPk(lien_id, {
        include: [
          { model: GrantStream, as: 'grantStream' },
          { model: LienRelease, as: 'releases' },
          { model: LienMilestone, as: 'milestones' }
        ],
        transaction
      });

      if (!lien) {
        throw new Error(`Lien not found: ${lien_id}`);
      }

      if (!lien.is_active) {
        throw new Error(`Lien ${lien_id} is not active`);
      }

      if (lien.status === 'completed') {
        throw new Error(`Lien ${lien_id} is already completed`);
      }

      if (lien.status === 'cancelled') {
        throw new Error(`Lien ${lien_id} is cancelled`);
      }

      // Calculate current vested amount
      const vestingCalculation = await vestingService.calculateWithdrawableAmount(
        lien.vault_address,
        lien.beneficiary_address
      );

      const totalVested = vestingCalculation.total_vested;
      const totalReleased = parseFloat(lien.released_amount);
      const availableForRelease = Math.min(
        totalVested - totalReleased,
        lien.getRemainingAmount()
      );

      if (availableForRelease <= 0) {
        throw new Error(`No tokens available for release from lien ${lien_id}`);
      }

      let releaseAmount = amount;
      
      // Handle different release types
      if (lien.release_rate_type === 'milestone') {
        if (!milestone_id) {
          throw new Error('Milestone ID required for milestone-based releases');
        }
        
        const milestone = lien.milestones.find(m => m.id === milestone_id);
        if (!milestone) {
          throw new Error(`Milestone ${milestone_id} not found for lien ${lien_id}`);
        }
        
        if (milestone.is_completed) {
          throw new Error(`Milestone ${milestone_id} is already completed`);
        }
        
        releaseAmount = milestone.calculateAmount(lien.committed_amount);
        
        if (releaseAmount > availableForRelease) {
          throw new Error(`Milestone amount ${releaseAmount} exceeds available ${availableForRelease}`);
        }
        
        // Mark milestone as completed
        await milestone.update({
          is_completed: true,
          completion_date: new Date(),
          release_transaction_hash: transaction_hash
        }, { transaction });
        
      } else {
        // For linear and immediate releases
        if (!releaseAmount) {
          releaseAmount = lien.calculateAvailableForRelease();
        }
        
        if (releaseAmount > availableForRelease) {
          releaseAmount = availableForRelease;
        }
      }

      // Create the release record
      const release = await LienRelease.create({
        lien_id,
        amount: releaseAmount,
        vested_at_release: totalVested,
        previously_released: totalReleased,
        available_for_release: availableForRelease,
        transaction_hash,
        block_number,
        metadata: {
          processor_address,
          release_type: lien.release_rate_type,
          milestone_id
        }
      }, { transaction });

      // Update lien
      const newReleasedAmount = totalReleased + releaseAmount;
      const newStatus = newReleasedAmount >= parseFloat(lien.committed_amount) ? 'completed' : 'active';
      
      await lien.update({
        released_amount: newReleasedAmount,
        status: newStatus,
        last_released_at: new Date()
      }, { transaction });

      await transaction.commit();

      // Log the action
      auditLogger.logAction(processorAddress, 'PROCESS_LIEN_RELEASE', lien_id, {
        amount: releaseAmount,
        transaction_hash,
        block_number,
        milestone_id,
        total_released: newReleasedAmount,
        lien_status: newStatus
      });

      return {
        success: true,
        release: release.toJSON(),
        lien: {
          id: lien.id,
          committed_amount: lien.committed_amount,
          released_amount: newReleasedAmount,
          remaining_amount: lien.getRemainingAmount(),
          status: newStatus
        },
        message: `Successfully released ${releaseAmount} tokens to grant stream`
      };

    } catch (error) {
      await transaction.rollback();
      logger.error('Error processing lien release:', error);
      throw error;
    }
  }

  /**
   * Cancel a future lien
   * 
   * @param {number} lienId - ID of the lien to cancel
   * @param {string} cancellerAddress - Address cancelling the lien
   * @param {string} reason - Reason for cancellation
   * @returns {Promise<Object>} Cancellation result
   */
  async cancelFutureLien(lienId, cancellerAddress, reason = '') {
    const transaction = await sequelize.transaction();
    
    try {
      const lien = await FutureLien.findByPk(lienId, { transaction });
      
      if (!lien) {
        throw new Error(`Lien not found: ${lienId}`);
      }

      if (lien.status === 'cancelled') {
        throw new Error(`Lien ${lienId} is already cancelled`);
      }

      if (lien.status === 'completed') {
        throw new Error(`Cannot cancel completed lien ${lienId}`);
      }

      // Check if any releases have been made
      const releasesCount = await LienRelease.count({
        where: { lien_id: lienId },
        transaction
      });

      if (releasesCount > 0) {
        throw new Error(`Cannot cancel lien ${lienId} as releases have already been processed`);
      }

      await lien.update({
        status: 'cancelled',
        is_active: false,
        metadata: {
          ...lien.metadata,
          cancellation_reason: reason,
          cancelled_by: cancellerAddress,
          cancelled_at: new Date().toISOString()
        }
      }, { transaction });

      await transaction.commit();

      // Log the action
      auditLogger.logAction(cancellerAddress, 'CANCEL_FUTURE_LIEN', lienId, {
        reason
      });

      return {
        success: true,
        lien: lien.toJSON(),
        message: 'Future lien cancelled successfully'
      };

    } catch (error) {
      await transaction.rollback();
      logger.error('Error cancelling future lien:', error);
      throw error;
    }
  }

  /**
   * Get a summary of all active liens with calculated release amounts
   * 
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Array of lien summaries
   */
  async getActiveLienSummary(options = {}) {
    const { vault_address, beneficiary_address, grant_stream_id } = options;
    
    const whereClause = {
      is_active: true,
      status: ['pending', 'active']
    };
    
    if (vault_address) whereClause.vault_address = vault_address;
    if (beneficiary_address) whereClause.beneficiary_address = beneficiary_address;
    if (grant_stream_id) whereClause.grant_stream_id = grant_stream_id;

    const liens = await FutureLien.findAll({
      where: whereClause,
      include: [
        { model: GrantStream, as: 'grantStream' },
        { model: LienRelease, as: 'releases' }
      ],
      order: [['release_start_date', 'ASC']]
    });

    return liens.map(lien => {
      const availableForRelease = lien.calculateAvailableForRelease();
      const remainingAmount = lien.getRemainingAmount();
      
      return {
        ...lien.toJSON(),
        available_for_release: availableForRelease,
        remaining_amount: remainingAmount,
        is_within_release_period: lien.isWithinReleasePeriod(),
        days_until_release_start: Math.max(0, Math.ceil((lien.release_start_date - new Date()) / (1000 * 60 * 60 * 24))),
        days_until_release_end: Math.max(0, Math.ceil((lien.release_end_date - new Date()) / (1000 * 60 * 60 * 24)))
      };
    });
  }

  /**
   * Create a new grant stream
   * 
   * @param {Object} data - Grant stream data
   * @param {string} data.address - Contract address
   * @param {string} data.name - Project name
   * @param {string} data.description - Project description
   * @param {string} data.owner_address - Owner address
   * @param {string} data.token_address - Token address
   * @param {number} data.target_amount - Target funding amount
   * @param {Date} data.end_date - End date for funding
   * @param {string} creatorAddress - Address creating the grant stream
   * @returns {Promise<Object>} Created grant stream
   */
  async createGrantStream(data, creatorAddress) {
    try {
      const grantStream = await GrantStream.create({
        ...data,
        is_active: true,
        current_amount: 0
      });

      // Log the action
      auditLogger.logAction(creatorAddress, 'CREATE_GRANT_STREAM', grantStream.id, {
        address: data.address,
        name: data.name,
        owner_address: data.owner_address,
        target_amount: data.target_amount
      });

      return {
        success: true,
        grant_stream: grantStream.toJSON(),
        message: 'Grant stream created successfully'
      };

    } catch (error) {
      logger.error('Error creating grant stream:', error);
      throw error;
    }
  }

  /**
   * Get all active grant streams
   * 
   * @returns {Promise<Array>} Array of grant streams
   */
  async getActiveGrantStreams() {
    const grantStreams = await GrantStream.findAll({
      where: { is_active: true },
      include: [
        {
          model: FutureLien,
          as: 'liens',
          where: { is_active: true },
          required: false
        }
      ],
      order: [['created_at', 'DESC']]
    });

    return grantStreams.map(stream => ({
      ...stream.toJSON(),
      total_committed: stream.liens.reduce((sum, lien) => sum + parseFloat(lien.committed_amount), 0),
      total_released: stream.liens.reduce((sum, lien) => sum + parseFloat(lien.released_amount), 0),
      active_liens_count: stream.liens.length
    }));
  }
}

module.exports = new FutureLienService();
