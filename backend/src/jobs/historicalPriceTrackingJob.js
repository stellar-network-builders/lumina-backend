const logger = require('../utils/logger');
const cron = require('node-cron');
const historicalPriceTrackingService = require('../services/historicalPriceTrackingService');
const { Vault, SubSchedule } = require('../models');
const { Op } = require('sequelize');

/**
 * Job for automated historical price tracking and milestone generation
 */
class HistoricalPriceTrackingJob {
  constructor() {
    this.isRunning = false;
    this.cronJob = null;
    this.lastRun = null;
    this.stats = {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      milestonesGenerated: 0,
      pricesBackfilled: 0,
      dailyPricesSynced: 0
    };
  }

  /**
   * Start the cron job
   * Runs daily at 2 AM to generate milestones and backfill prices
   */
  start() {
    if (this.cronJob) {
      logger.info('Historical price tracking job is already running');
      return;
    }

    // Run daily at 2 AM
    this.cronJob = cron.schedule('0 2 * * *', async () => {
      await this.run();
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    logger.info('📊 Historical Price Tracking Job scheduled to run daily at 2 AM UTC');
  }

  /**
   * Stop the cron job
   */
  stop() {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      logger.info('Historical price tracking job stopped');
    }
  }

  /**
   * Run the job manually
   */
  async run() {
    if (this.isRunning) {
      logger.info('Historical price tracking job is already running, skipping...');
      return;
    }

    this.isRunning = true;
    this.stats.totalRuns++;
    const startTime = Date.now();

    try {
      logger.info('🚀 Starting historical price tracking job...');

      // Step 1: Generate milestones for active vaults
      const milestonesGenerated = await this.generateMilestonesForActiveVaults();
      this.stats.milestonesGenerated += milestonesGenerated;

      // Step 2: Backfill missing prices
      const pricesBackfilled = await this.backfillMissingPrices();
      this.stats.pricesBackfilled += pricesBackfilled;

      // Step 3: Sync daily prices for all tokens (SEP-40)
      const dailyPriceSyncResults = await historicalPriceTrackingService.syncDailyPricesForAllTokens();
      this.stats.dailyPricesSynced += dailyPriceSyncResults.success;

      // Step 4: Generate cost basis reports for completed years
      const reportsGenerated = await this.generateCostBasisReports();

      const duration = Date.now() - startTime;
      this.lastRun = new Date();
      this.stats.successfulRuns++;

      logger.info(`✅ Historical price tracking job completed successfully in ${duration}ms`);
      logger.info(`📈 Generated ${milestonesGenerated} milestones, backfilled ${pricesBackfilled} prices, generated ${reportsGenerated} reports`);

    } catch (error) {
      this.stats.failedRuns++;
      logger.error('❌ Historical price tracking job failed:', error);
      
      // Send error to monitoring service if available
      if (global.Sentry) {
        global.Sentry.captureException(error, {
          tags: { job: 'historical-price-tracking' }
        });
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Generate milestones for all active vaults
   * @private
   */
  async generateMilestonesForActiveVaults() {
    try {
      // Get all active vaults with recent activity
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 7); // Last 7 days

      const activeVaults = await Vault.findAll({
        include: [
          {
            model: SubSchedule,
            as: 'subSchedules',
            where: {
              is_active: true,
              [Op.or]: [
                { created_at: { [Op.gte]: cutoffDate } },
                { updated_at: { [Op.gte]: cutoffDate } }
              ]
            },
            required: true
          }
        ]
      });

      logger.info(`📋 Found ${activeVaults.length} active vaults for milestone generation`);

      let totalMilestones = 0;

      // Process vaults in batches to avoid overwhelming the system
      const batchSize = 5;
      for (let i = 0; i < activeVaults.length; i += batchSize) {
        const batch = activeVaults.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (vault) => {
          try {
            const milestones = await historicalPriceTrackingService.generateVestingMilestones(
              vault.id,
              {
                incrementDays: 30, // Monthly milestones
                forceRefresh: false // Don't overwrite existing milestones
              }
            );
            totalMilestones += milestones.length;
            logger.info(`📊 Generated ${milestones.length} milestones for vault ${vault.address}`);
          } catch (error) {
            logger.error(`Error generating milestones for vault ${vault.id}:`, error.message);
          }
        }));

        // Rate limiting delay between batches
        if (i + batchSize < activeVaults.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      return totalMilestones;
    } catch (error) {
      logger.error('Error in generateMilestonesForActiveVaults:', error);
      return 0;
    }
  }

  /**
   * Backfill missing prices for existing milestones
   * @private
   */
  async backfillMissingPrices() {
    try {
      logger.info('🔄 Starting price backfill process...');

      // Backfill prices for the last 30 days
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);

      const backfilledCount = await historicalPriceTrackingService.backfillMissingPrices({
        startDate,
        batchSize: 100
      });

      logger.info(`💰 Backfilled prices for ${backfilledCount} milestones`);
      return backfilledCount;
    } catch (error) {
      logger.error('Error in backfillMissingPrices:', error);
      return 0;
    }
  }

  /**
   * Generate cost basis reports for completed years
   * @private
   */
  async generateCostBasisReports() {
    try {
      // Only generate reports for previous years (completed tax years)
      const currentYear = new Date().getFullYear();
      const previousYear = currentYear - 1;

      // Get unique user/token combinations that have milestones in the previous year
      const { VestingMilestone, Beneficiary } = require('../models');
      
      const userTokenCombos = await VestingMilestone.findAll({
        attributes: ['token_address'],
        include: [
          {
            model: Beneficiary,
            as: 'beneficiary',
            attributes: ['address']
          }
        ],
        where: {
          milestone_date: {
            [Op.between]: [
              new Date(previousYear, 0, 1),
              new Date(previousYear, 11, 31, 23, 59, 59)
            ]
          }
        },
        group: ['token_address', 'beneficiary.address'],
        raw: true
      });

      logger.info(`📋 Found ${userTokenCombos.length} user/token combinations for ${previousYear} reports`);

      let reportsGenerated = 0;

      // Generate reports in batches
      const batchSize = 10;
      for (let i = 0; i < userTokenCombos.length; i += batchSize) {
        const batch = userTokenCombos.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (combo) => {
          try {
            await historicalPriceTrackingService.generateCostBasisReport(
              combo['beneficiary.address'],
              combo.token_address,
              previousYear
            );
            reportsGenerated++;
          } catch (error) {
            logger.error(`Error generating report for ${combo['beneficiary.address']}/${combo.token_address}:`, error.message);
          }
        }));

        // Rate limiting delay
        if (i + batchSize < userTokenCombos.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      logger.info(`📊 Generated ${reportsGenerated} cost basis reports for ${previousYear}`);
      return reportsGenerated;
    } catch (error) {
      logger.error('Error in generateCostBasisReports:', error);
      return 0;
    }
  }

  /**
   * Get job statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      nextRun: this.cronJob ? this.cronJob.nextDate() : null
    };
  }

  /**
   * Run a specific task manually
   */
  async runTask(taskName) {
    if (this.isRunning) {
      throw new Error('Job is already running');
    }

    this.isRunning = true;
    try {
      switch (taskName) {
        case 'milestones':
          return await this.generateMilestonesForActiveVaults();
        case 'backfill':
          return await this.backfillMissingPrices();
        case 'reports':
          return await this.generateCostBasisReports();
        default:
          throw new Error(`Unknown task: ${taskName}`);
      }
    } finally {
      this.isRunning = false;
    }
  }
}

module.exports = new HistoricalPriceTrackingJob();