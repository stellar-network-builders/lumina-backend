'use strict';

const logger = require('../utils/logger');
const futureLienService = require('./futureLienService');
const futureLienContractService = require('./futureLienContractService');
const vestingService = require('./vestingService');
const auditLogger = require('./auditLogger');

class FutureLienProcessorService {
  constructor() {
    this.isProcessing = false;
    this.processingInterval = null;
    this.processIntervalMs = parseInt(process.env.LIEN_PROCESSING_INTERVAL_MS) || 60000; // 1 minute default
  }

  /**
   * Start the background processor
   */
  start() {
    if (this.isProcessing) {
      logger.info('Future lien processor is already running');
      return;
    }

    logger.info('Starting future lien processor...');
    this.isProcessing = true;
    
    // Process immediately on start
    this.processPendingReleases();
    
    // Set up interval for regular processing
    this.processingInterval = setInterval(() => {
      this.processPendingReleases();
    }, this.processIntervalMs);
  }

  /**
   * Stop the background processor
   */
  stop() {
    if (!this.isProcessing) {
      logger.info('Future lien processor is not running');
      return;
    }

    logger.info('Stopping future lien processor...');
    this.isProcessing = false;
    
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }

  /**
   * Process all pending lien releases
   */
  async processPendingReleases() {
    if (!this.isProcessing) {
      return;
    }

    try {
      logger.info('Processing pending lien releases...');
      
      // Get all active liens that are within release period
      const activeLiens = await futureLienService.getActiveLienSummary();
      
      for (const lien of activeLiens) {
        try {
          await this.processIndividualLien(lien);
        } catch (error) {
          logger.error(`Error processing lien ${lien.id}:`, error);
          
          // Log the processing error
          auditLogger.logAction('system', 'LIEN_PROCESSING_ERROR', lien.id, {
            error: error.message,
            lien_details: lien
          });
        }
      }
      
      logger.info(`Processed ${activeLiens.length} active liens`);
      
    } catch (error) {
      logger.error('Error in lien processing cycle:', error);
      
      // Log the cycle error
      auditLogger.logAction('system', 'LIEN_PROCESSING_CYCLE_ERROR', null, {
        error: error.message
      });
    }
  }

  /**
   * Process an individual lien for potential releases
   * 
   * @param {Object} lien - Lien object with calculated fields
   */
  async processIndividualLien(lien) {
    const now = new Date();
    
    // Check if lien is within release period
    if (!lien.is_within_release_period) {
      return;
    }

    // Calculate available amount for release
    const availableAmount = lien.available_for_release;
    
    if (availableAmount <= 0) {
      return;
    }

    // Get current vesting calculation for the beneficiary
    const vestingCalculation = await vestingService.calculateWithdrawableAmount(
      lien.vault_address,
      lien.beneficiary_address,
      now
    );

    // Ensure we don't release more than what's actually vested
    const totalVested = vestingCalculation.total_vested;
    const alreadyReleased = parseFloat(lien.released_amount);
    const maxReleasable = Math.min(availableAmount, totalVested - alreadyReleased);

    if (maxReleasable <= 0) {
      return;
    }

    // Handle different release types
    let releaseAmount = 0;
    let releaseData = {};

    switch (lien.release_rate_type) {
      case 'immediate':
        releaseAmount = maxReleasable;
        break;
      
      case 'linear':
        releaseAmount = await this.calculateLinearRelease(lien, maxReleasable, now);
        break;
      
      case 'milestone':
        releaseAmount = await this.checkMilestoneReleases(lien, maxReleasable, now);
        break;
      
      default:
        logger.warn(`Unknown release rate type: ${lien.release_rate_type}`);
        return;
    }

    if (releaseAmount > 0) {
      // Process the release
      await this.executeLienRelease(lien, releaseAmount, releaseData);
    }
  }

  /**
   * Calculate linear release amount based on time progression
   * 
   * @param {Object} lien - Lien object
   * @param {number} maxReleasable - Maximum amount that can be released
   * @param {Date} now - Current timestamp
   * @returns {Promise<number>} Amount to release
   */
  async calculateLinearRelease(lien, maxReleasable, now) {
    const releaseStart = new Date(lien.release_start_date);
    const releaseEnd = new Date(lien.release_end_date);
    const totalDuration = releaseEnd - releaseStart;
    const elapsed = now - releaseStart;
    
    // Calculate progress through the release period
    const progress = Math.max(0, Math.min(1, elapsed / totalDuration));
    
    // Total amount that should have been released by now
    const targetReleasedAmount = parseFloat(lien.committed_amount) * progress;
    const alreadyReleased = parseFloat(lien.released_amount);
    
    // Amount to release now
    const releaseAmount = targetReleasedAmount - alreadyReleased;
    
    // Don't exceed the maximum releasable amount
    return Math.min(releaseAmount, maxReleasable);
  }

  /**
   * Check for milestone-based releases
   * 
   * @param {Object} lien - Lien object
   * @param {number} maxReleasable - Maximum amount that can be released
   * @param {Date} now - Current timestamp
   * @returns {Promise<number>} Amount to release
   */
  async checkMilestoneReleases(lien, maxReleasable, now) {
    // Get milestones for this lien
    const lienWithMilestones = await futureLienService.getBeneficiaryLiens(lien.beneficiary_address, {
      includeInactive: true
    });
    
    const fullLien = lienWithMilestones.find(l => l.id === lien.id);
    
    if (!fullLien || !fullLien.milestones) {
      return 0;
    }

    let totalReleaseAmount = 0;
    const completedMilestones = [];

    // Check each milestone
    for (const milestone of fullLien.milestones) {
      if (milestone.is_completed) {
        continue;
      }

      // Check if milestone target date has passed
      if (milestone.target_date && new Date(milestone.target_date) <= now) {
        const milestoneAmount = milestone.calculateAmount(lien.committed_amount);
        
        if (milestoneAmount <= maxReleasable - totalReleaseAmount) {
          totalReleaseAmount += milestoneAmount;
          completedMilestones.push({
            id: milestone.id,
            amount: milestoneAmount
          });
        }
      }
    }

    return totalReleaseAmount;
  }

  /**
   * Execute a lien release both on-chain and in database
   * 
   * @param {Object} lien - Lien object
   * @param {number} releaseAmount - Amount to release
   * @param {Object} releaseData - Additional release data
   */
  async executeLienRelease(lien, releaseAmount, releaseData = {}) {
    try {
      logger.info(`Executing release of ${releaseAmount} tokens for lien ${lien.id}`);

      // For now, we'll only process the database release
      // In a production environment, you would also:
      // 1. Call the smart contract to execute the release
      // 2. Wait for transaction confirmation
      // 3. Update the database with the transaction details

      const processorAddress = 'system'; // In production, this would be a dedicated processor address
      
      const releaseResult = await futureLienService.processLienRelease({
        lien_id: lien.id,
        amount: releaseAmount,
        ...releaseData
      }, processorAddress);

      logger.info(`Successfully processed release for lien ${lien.id}:`, releaseResult);

      // In production, you would also execute the on-chain release:
      /*
      if (process.env.ENABLE_CONTRACT_RELEASES === 'true') {
        const contractResult = await futureLienContractService.processLienReleaseOnChain({
          lienId: lien.id.toString(),
          amount: Math.floor(releaseAmount * 1e7), // Convert to stroops
          signerPrivateKey: process.env.PROCESSOR_PRIVATE_KEY
        });
        
        // Update the release record with contract transaction details
        await this.updateReleaseWithContractDetails(releaseResult.release.id, contractResult);
      }
      */

    } catch (error) {
      logger.error(`Error executing release for lien ${lien.id}:`, error);
      throw error;
    }
  }

  /**
   * Update release record with contract transaction details
   * 
   * @param {number} releaseId - Release record ID
   * @param {Object} contractResult - Contract transaction result
   */
  async updateReleaseWithContractDetails(releaseId, contractResult) {
    try {
      const { LienRelease } = require('../models');
      
      await LienRelease.update({
        transaction_hash: contractResult.transactionHash,
        block_number: contractResult.ledger,
        metadata: {
          contract_result: contractResult.contractResult,
          processed_by: 'future_lien_processor'
        }
      }, {
        where: { id: releaseId }
      });
      
    } catch (error) {
      logger.error('Error updating release with contract details:', error);
      throw error;
    }
  }

  /**
   * Manually trigger processing for a specific lien
   * 
   * @param {number} lienId - Lien ID to process
   * @returns {Promise<Object>} Processing result
   */
  async processSpecificLien(lienId) {
    try {
      // Get the lien details
      const liens = await futureLienService.getActiveLienSummary();
      const lien = liens.find(l => l.id === lienId);
      
      if (!lien) {
        throw new Error(`Active lien not found: ${lienId}`);
      }

      // Process the individual lien
      await this.processIndividualLien(lien);
      
      return {
        success: true,
        message: `Successfully processed lien ${lienId}`,
        lien_id: lienId
      };
      
    } catch (error) {
      logger.error(`Error processing specific lien ${lienId}:`, error);
      throw error;
    }
  }

  /**
   * Get processing statistics
   * 
   * @returns {Promise<Object>} Processing statistics
   */
  async getProcessingStats() {
    try {
      const activeLiens = await futureLienService.getActiveLienSummary();
      
      const stats = {
        is_processing: this.isProcessing,
        processing_interval_ms: this.processIntervalMs,
        total_active_liens: activeLiens.length,
        liens_within_release_period: activeLiens.filter(l => l.is_within_release_period).length,
        total_available_for_release: activeLiens.reduce((sum, l) => sum + (l.available_for_release || 0), 0),
        last_processing_time: new Date().toISOString()
      };

      // Breakdown by release type
      stats.by_release_type = {
        linear: activeLiens.filter(l => l.release_rate_type === 'linear').length,
        milestone: activeLiens.filter(l => l.release_rate_type === 'milestone').length,
        immediate: activeLiens.filter(l => l.release_rate_type === 'immediate').length
      };

      // Breakdown by status
      stats.by_status = {
        pending: activeLiens.filter(l => l.status === 'pending').length,
        active: activeLiens.filter(l => l.status === 'active').length
      };

      return stats;
      
    } catch (error) {
      logger.error('Error getting processing stats:', error);
      throw error;
    }
  }

  /**
   * Health check for the processor service
   * 
   * @returns {Promise<Object>} Health status
   */
  async healthCheck() {
    try {
      const stats = await this.getProcessingStats();
      
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        processor: {
          is_running: this.isProcessing,
          uptime: process.uptime(),
          memory_usage: process.memoryUsage()
        },
        statistics: stats
      };
      
    } catch (error) {
      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error.message
      };
    }
  }
}

module.exports = new FutureLienProcessorService();
