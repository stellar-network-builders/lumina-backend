const logger = require('../utils/logger');
const { VestingMilestone, HistoricalTokenPrice, CostBasisReport, Vault, SubSchedule, Beneficiary } = require('../models');
const stellarDexPriceService = require('./stellarDexPriceService');
const priceService = require('./priceService');
const { Op } = require('sequelize');

/**
 * Service for tracking historical prices at vesting milestones for tax reporting
 */
class HistoricalPriceTrackingService {
  constructor() {
    this.priceCache = new Map();
    this.cacheTTL = 3600000; // 1 hour cache
  }

  /**
   * Generate vesting milestones for a vault and fetch historical prices
   * @param {string} vaultId - Vault UUID
   * @param {Object} options - Options for milestone generation
   * @returns {Promise<Array>} Array of created milestones
   */
  async generateVestingMilestones(vaultId, options = {}) {
    const { 
      startDate = null, 
      endDate = null, 
      incrementDays = 30,
      forceRefresh = false 
    } = options;

    try {
      // Get vault with related data
      const vault = await Vault.findByPk(vaultId, {
        include: [
          {
            model: SubSchedule,
            as: 'subSchedules',
            where: { is_active: true }
          },
          {
            model: Beneficiary,
            as: 'beneficiaries'
          }
        ]
      });

      if (!vault) {
        throw new Error(`Vault not found: ${vaultId}`);
      }

      const milestones = [];

      // Generate milestones for each beneficiary and sub-schedule combination
      for (const beneficiary of vault.beneficiaries) {
        for (const subSchedule of vault.subSchedules) {
          const subMilestones = await this.generateSubScheduleMilestones(
            vault, 
            subSchedule, 
            beneficiary, 
            { startDate, endDate, incrementDays, forceRefresh }
          );
          milestones.push(...subMilestones);
        }
      }

      // Fetch prices for all milestones
      await this.fetchPricesForMilestones(milestones);

      return milestones;
    } catch (error) {
      logger.error(`Error generating vesting milestones for vault ${vaultId}:`, error);
      throw error;
    }
  }

  /**
   * Generate milestones for a specific sub-schedule and beneficiary
   * @private
   */
  async generateSubScheduleMilestones(vault, subSchedule, beneficiary, options) {
    const milestones = [];
    const { startDate, endDate, incrementDays, forceRefresh } = options;

    // Calculate beneficiary's allocation ratio
    const totalVaultAmount = parseFloat(vault.total_amount) || 0;
    const beneficiaryAllocation = parseFloat(beneficiary.total_allocated) || 0;
    const allocationRatio = totalVaultAmount > 0 ? beneficiaryAllocation / totalVaultAmount : 0;

    // Skip if no allocation
    if (allocationRatio === 0) return milestones;

    const vestingStart = new Date(subSchedule.vesting_start_date);
    const vestingEnd = new Date(subSchedule.end_timestamp);
    const cliffDate = subSchedule.cliff_date ? new Date(subSchedule.cliff_date) : null;

    // Filter by date range if provided
    const effectiveStart = startDate ? new Date(Math.max(vestingStart, new Date(startDate))) : vestingStart;
    const effectiveEnd = endDate ? new Date(Math.min(vestingEnd, new Date(endDate))) : vestingEnd;

    // Cliff end milestone
    if (cliffDate && cliffDate >= effectiveStart && cliffDate <= effectiveEnd) {
      const cliffAmount = parseFloat(subSchedule.top_up_amount) * allocationRatio;
      
      const milestone = await this.createOrUpdateMilestone({
        vault_id: vault.id,
        sub_schedule_id: subSchedule.id,
        beneficiary_id: beneficiary.id,
        milestone_date: cliffDate,
        milestone_type: 'cliff_end',
        vested_amount: cliffAmount,
        cumulative_vested: cliffAmount,
        token_address: vault.token_address
      }, forceRefresh);

      if (milestone) milestones.push(milestone);
    }

    // Vesting increment milestones (monthly by default)
    const incrementMs = incrementDays * 24 * 60 * 60 * 1000;
    let currentDate = new Date(Math.max(effectiveStart, cliffDate || vestingStart));
    
    while (currentDate < effectiveEnd) {
      currentDate = new Date(currentDate.getTime() + incrementMs);
      
      if (currentDate > effectiveEnd) {
        currentDate = effectiveEnd;
      }

      // Calculate vested amount at this date
      const { vestedAmount, cumulativeVested } = this.calculateVestedAtDate(
        subSchedule, 
        currentDate, 
        allocationRatio
      );

      if (vestedAmount > 0) {
        const milestoneType = currentDate.getTime() === vestingEnd.getTime() 
          ? 'vesting_complete' 
          : 'vesting_increment';

        const milestone = await this.createOrUpdateMilestone({
          vault_id: vault.id,
          sub_schedule_id: subSchedule.id,
          beneficiary_id: beneficiary.id,
          milestone_date: currentDate,
          milestone_type: milestoneType,
          vested_amount: vestedAmount,
          cumulative_vested: cumulativeVested,
          token_address: vault.token_address
        }, forceRefresh);

        if (milestone) milestones.push(milestone);
      }

      if (currentDate.getTime() === effectiveEnd.getTime()) break;
    }

    return milestones;
  }

  /**
   * Calculate vested amount at a specific date
   * @private
   */
  calculateVestedAtDate(subSchedule, date, allocationRatio) {
    const vestingStart = new Date(subSchedule.vesting_start_date);
    const vestingEnd = new Date(subSchedule.end_timestamp);
    const totalAmount = parseFloat(subSchedule.top_up_amount) * allocationRatio;

    if (date < vestingStart) {
      return { vestedAmount: 0, cumulativeVested: 0 };
    }

    if (date >= vestingEnd) {
      return { vestedAmount: totalAmount, cumulativeVested: totalAmount };
    }

    // Linear vesting calculation
    const vestingDuration = vestingEnd.getTime() - vestingStart.getTime();
    const elapsedTime = date.getTime() - vestingStart.getTime();
    const vestingRatio = elapsedTime / vestingDuration;
    
    const cumulativeVested = totalAmount * vestingRatio;
    
    return { 
      vestedAmount: cumulativeVested, // For incremental milestones, this represents cumulative
      cumulativeVested 
    };
  }

  /**
   * Create or update a vesting milestone
   * @private
   */
  async createOrUpdateMilestone(milestoneData, forceRefresh = false) {
    try {
      const existing = await VestingMilestone.findOne({
        where: {
          vault_id: milestoneData.vault_id,
          sub_schedule_id: milestoneData.sub_schedule_id,
          beneficiary_id: milestoneData.beneficiary_id,
          milestone_date: milestoneData.milestone_date,
          milestone_type: milestoneData.milestone_type
        }
      });

      if (existing && !forceRefresh) {
        return existing;
      }

      if (existing) {
        await existing.update(milestoneData);
        return existing;
      } else {
        return await VestingMilestone.create(milestoneData);
      }
    } catch (error) {
      logger.error('Error creating/updating milestone:', error);
      return null;
    }
  }

  /**
   * Fetch prices for milestones that don't have price data
   * @param {Array} milestones - Array of milestone objects
   */
  async fetchPricesForMilestones(milestones) {
    const milestonesNeedingPrices = milestones.filter(m => !m.price_usd || !m.vwap_24h_usd);
    
    if (milestonesNeedingPrices.length === 0) return;

    logger.info(`Fetching prices for ${milestonesNeedingPrices.length} milestones`);

    // Group by token and date to minimize API calls
    const priceRequests = new Map();
    
    for (const milestone of milestonesNeedingPrices) {
      const dateStr = milestone.milestone_date.toISOString().split('T')[0];
      const key = `${milestone.token_address}-${dateStr}`;
      
      if (!priceRequests.has(key)) {
        priceRequests.set(key, {
          token_address: milestone.token_address,
          date: milestone.milestone_date,
          milestones: []
        });
      }
      
      priceRequests.get(key).milestones.push(milestone);
    }

    // Fetch prices in batches
    const batchSize = 5;
    const requestEntries = Array.from(priceRequests.entries());
    
    for (let i = 0; i < requestEntries.length; i += batchSize) {
      const batch = requestEntries.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async ([key, request]) => {
        try {
          const priceData = await this.getHistoricalPrice(request.token_address, request.date);
          
          // Update all milestones for this token/date
          for (const milestone of request.milestones) {
            await milestone.update({
              price_usd: priceData.price_usd,
              vwap_24h_usd: priceData.vwap_24h_usd,
              price_source: priceData.price_source,
              price_fetched_at: new Date()
            });
          }
        } catch (error) {
          logger.error(`Error fetching price for ${key}:`, error.message);
        }
      }));

      // Rate limiting delay
      if (i + batchSize < requestEntries.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Get historical price for a token on a specific date
   * @param {string} tokenAddress - Token contract address
   * @param {Date} date - Date to get price for
   * @returns {Promise<Object>} Price data
   */
  async getHistoricalPrice(tokenAddress, date) {
    const dateStr = date.toISOString().split('T')[0];
    const cacheKey = `${tokenAddress}-${dateStr}`;

    // Check cache first
    if (this.priceCache.has(cacheKey)) {
      const cached = this.priceCache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTTL) {
        return cached.data;
      }
    }

    // Check database cache
    const cachedPrice = await HistoricalTokenPrice.findOne({
      where: {
        token_address: tokenAddress,
        price_date: dateStr
      },
      order: [['data_quality', 'DESC'], ['created_at', 'DESC']]
    });

    if (cachedPrice) {
      const priceData = {
        price_usd: parseFloat(cachedPrice.price_usd),
        vwap_24h_usd: parseFloat(cachedPrice.vwap_24h_usd),
        price_source: cachedPrice.price_source
      };
      
      this.priceCache.set(cacheKey, {
        data: priceData,
        timestamp: Date.now()
      });
      
      return priceData;
    }

    // Fetch from external sources
    let priceData = null;
    
    try {
      // Try Stellar DEX first for VWAP
      priceData = await stellarDexPriceService.getTokenVWAP(tokenAddress, date);
    } catch (stellarError) {
      logger.info(`Stellar DEX failed for ${tokenAddress}, trying fallback...`);
      
      try {
        // Fallback to existing price service
        const price = await priceService.getTokenPrice(tokenAddress, date);
        priceData = {
          price_usd: price,
          vwap_24h_usd: price, // Use regular price as VWAP fallback
          price_source: 'coingecko_fallback',
          data_quality: 'fair'
        };
      } catch (fallbackError) {
        logger.error(`All price sources failed for ${tokenAddress}:`, fallbackError.message);
        throw new Error(`Unable to fetch price for ${tokenAddress} on ${dateStr}`);
      }
    }

    // Cache in database
    try {
      await HistoricalTokenPrice.create({
        token_address: tokenAddress,
        price_date: dateStr,
        price_usd: priceData.price_usd,
        vwap_24h_usd: priceData.vwap_24h_usd,
        volume_24h_usd: priceData.volume_24h_usd || null,
        market_cap_usd: priceData.market_cap_usd || null,
        price_source: priceData.price_source,
        data_quality: priceData.data_quality || 'good'
      });
    } catch (dbError) {
      logger.error('Error caching price in database:', dbError.message);
    }

    // Cache in memory
    this.priceCache.set(cacheKey, {
      data: priceData,
      timestamp: Date.now()
    });

    return priceData;
  }

  /**
   * Generate cost basis report for a beneficiary
   * @param {string} userAddress - Beneficiary wallet address
   * @param {string} tokenAddress - Token contract address
   * @param {number} year - Tax year
   * @returns {Promise<Object>} Cost basis report
   */
  async generateCostBasisReport(userAddress, tokenAddress, year) {
    try {
      // Get all vesting milestones for the user/token/year
      const startDate = new Date(year, 0, 1);
      const endDate = new Date(year, 11, 31, 23, 59, 59);

      const milestones = await VestingMilestone.findAll({
        where: {
          token_address: tokenAddress,
          milestone_date: {
            [Op.between]: [startDate, endDate]
          }
        },
        include: [
          {
            model: Beneficiary,
            as: 'beneficiary',
            where: { address: userAddress }
          },
          {
            model: Vault,
            as: 'vault'
          },
          {
            model: SubSchedule,
            as: 'subSchedule'
          }
        ],
        order: [['milestone_date', 'ASC']]
      });

      if (milestones.length === 0) {
        throw new Error(`No vesting milestones found for ${userAddress} in ${year}`);
      }

      // Calculate totals
      let totalVestedAmount = 0;
      let totalCostBasisUSD = 0;
      const milestoneDetails = [];

      for (const milestone of milestones) {
        const vestedAmount = parseFloat(milestone.vested_amount);
        const priceUSD = parseFloat(milestone.vwap_24h_usd || milestone.price_usd || 0);
        const costBasis = vestedAmount * priceUSD;

        totalVestedAmount += vestedAmount;
        totalCostBasisUSD += costBasis;

        milestoneDetails.push({
          date: milestone.milestone_date,
          milestone_type: milestone.milestone_type,
          vested_amount: vestedAmount,
          price_usd: priceUSD,
          cost_basis_usd: costBasis,
          price_source: milestone.price_source,
          vault_address: milestone.vault.address,
          vault_name: milestone.vault.name
        });
      }

      const reportData = {
        user_address: userAddress,
        token_address: tokenAddress,
        report_year: year,
        total_vested_amount: totalVestedAmount,
        total_cost_basis_usd: totalCostBasisUSD,
        total_milestones: milestones.length,
        milestones: milestoneDetails,
        generated_at: new Date(),
        summary: {
          average_price_usd: totalVestedAmount > 0 ? totalCostBasisUSD / totalVestedAmount : 0,
          first_vesting_date: milestoneDetails[0]?.date,
          last_vesting_date: milestoneDetails[milestoneDetails.length - 1]?.date
        }
      };

      // Save report to database
      const [report] = await CostBasisReport.upsert({
        user_address: userAddress,
        token_address: tokenAddress,
        report_year: year,
        total_vested_amount: totalVestedAmount,
        total_cost_basis_usd: totalCostBasisUSD,
        total_milestones: milestones.length,
        report_data: reportData,
        generated_at: new Date()
      });

      return reportData;
    } catch (error) {
      logger.error(`Error generating cost basis report:`, error);
      throw error;
    }
  }

  /**
   * Backfill missing prices for existing milestones
   * @param {Object} options - Backfill options
   * @returns {Promise<number>} Number of milestones updated
   */
  async backfillMissingPrices(options = {}) {
    const { tokenAddress = null, startDate = null, endDate = null, batchSize = 50 } = options;

    const whereClause = {
      [Op.or]: [
        { price_usd: null },
        { vwap_24h_usd: null }
      ]
    };

    if (tokenAddress) {
      whereClause.token_address = tokenAddress;
    }

    if (startDate || endDate) {
      whereClause.milestone_date = {};
      if (startDate) whereClause.milestone_date[Op.gte] = new Date(startDate);
      if (endDate) whereClause.milestone_date[Op.lte] = new Date(endDate);
    }

    const milestones = await VestingMilestone.findAll({
      where: whereClause,
      order: [['milestone_date', 'ASC']],
      limit: batchSize
    });

    if (milestones.length === 0) {
      return 0;
    }

    logger.info(`Backfilling prices for ${milestones.length} milestones`);
    
    await this.fetchPricesForMilestones(milestones);
    
    return milestones.length;
  }

  /**
   * Sync daily closing prices for all tracked tokens
   * @param {Date} date - Date to sync prices for (defaults to yesterday)
   * @returns {Promise<Object>} Summary of the sync process
   */
  async syncDailyPricesForAllTokens(date = null) {
    const syncDate = date ? new Date(date) : new Date();
    if (!date) syncDate.setDate(syncDate.getDate() - 1); // Default to yesterday
    
    const dateStr = syncDate.toISOString().split('T')[0];
    logger.info(`🕒 Starting daily price sync for all tokens on ${dateStr}`);

    try {
      // Get all unique tokens from the database
      const tokens = await Token.findAll({
        attributes: ['address', 'symbol']
      });

      logger.info(`🔍 Found ${tokens.length} tokens to sync`);

      const results = {
        total: tokens.length,
        success: 0,
        failed: 0,
        skipped: 0,
        errors: []
      };

      // Process tokens in batches
      const batchSize = 5;
      for (let i = 0; i < tokens.length; i += batchSize) {
        const batch = tokens.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (token) => {
          try {
            // Check if price already exists for this date
            const existing = await HistoricalTokenPrice.findOne({
              where: {
                token_address: token.address,
                price_date: dateStr
              }
            });

            if (existing) {
              results.skipped++;
              return;
            }

            // Fetch and store price
            await this.getHistoricalPrice(token.address, syncDate);
            results.success++;
            logger.info(`✅ Synced price for ${token.symbol} (${token.address})`);
          } catch (error) {
            results.failed++;
            results.errors.push({ token: token.symbol, address: token.address, error: error.message });
            logger.error(`❌ Failed to sync price for ${token.symbol}:`, error.message);
          }
        }));

        // Rate limiting delay
        if (i + batchSize < tokens.length) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      return results;
    } catch (error) {
      logger.error('Error in syncDailyPricesForAllTokens:', error);
      throw error;
    }
  }

  /**
   * Clear price cache
   */
  clearCache() {
    this.priceCache.clear();
  }
}

module.exports = new HistoricalPriceTrackingService();