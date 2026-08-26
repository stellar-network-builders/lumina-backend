const logger = require('../utils/logger');
const { sequelize } = require('../database/connection');
const { Vault, Beneficiary, GrantStream } = require('../models');
const HistoricalTokenPrice = require('../models/historicalTokenPrice');
const priceService = require('./priceService');
const stellarDexPriceService = require('./stellarDexPriceService');

/**
 * ROI Analytics Service
 * Tracks token price at grant time vs current market price
 * Calculates Return on Investment (ROI) and Unrealized Gains
 */
class RoiAnalyticsService {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes cache
  }

  buildUserCacheKey(userAddress, options = {}) {
    const includeGrants = options.include_grants !== false;
    const includeVaults = options.include_vaults !== false;
    return `roi-${userAddress}-${includeGrants ? 'g1' : 'g0'}-${includeVaults ? 'v1' : 'v0'}`;
  }

  /**
   * Get comprehensive ROI analytics for a user
   * @param {string} userAddress - User wallet address
   * @param {Object} options - Query options
   * @returns {Promise<Object>} ROI analytics data
   */
  async getUserRoiAnalytics(userAddress, options = {}) {
    const cacheKey = this.buildUserCacheKey(userAddress, options);
    
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      const ageMs = Date.now() - cached.timestamp;
      if (ageMs < this.cacheTimeout) {
        return cached.data;
      }

      if (options.allowStaleCache) {
        const staleData = {
          ...cached.data,
          metadata: {
            ...(cached.data && cached.data.metadata ? cached.data.metadata : {}),
            cache: {
              stale: true,
              ageMs
            },
            degraded: true
          }
        };
        return staleData;
      }
    }

    try {
      const {
        vaults = await this.getUserVaults(userAddress),
        grantStreams = await this.getUserGrantStreams(userAddress),
        currentTime = new Date()
      } = options;

      // Calculate ROI for vaults
      const vaultRoiData = await this.calculateVaultsRoi(vaults, currentTime);
      
      // Calculate ROI for grant streams
      const grantRoiData = await this.calculateGrantStreamsRoi(grantStreams, currentTime);

      // Aggregate overall metrics
      const overallMetrics = this.calculateOverallMetrics(vaultRoiData, grantRoiData);

      const analyticsData = {
        user_address: userAddress,
        timestamp: currentTime,
        vaults: vaultRoiData,
        grant_streams: grantRoiData,
        overall_metrics: overallMetrics,
        summary: this.generateSummary(overallMetrics)
      };

      // Cache the result
      this.cache.set(cacheKey, {
        data: analyticsData,
        timestamp: Date.now()
      });

      return analyticsData;
    } catch (error) {
      logger.error(`Error calculating ROI analytics for user ${userAddress}:`, error);
      throw error;
    }
  }

  /**
   * Get ROI analytics for a specific vault
   * @param {string} vaultAddress - Vault contract address
   * @returns {Promise<Object>} Vault ROI analytics
   */
  async getVaultRoiAnalytics(vaultAddress) {
    try {
      const vault = await Vault.findOne({
        where: { address: vaultAddress },
        include: [
          {
            model: Beneficiary,
            as: 'beneficiaries'
          }
        ]
      });

      if (!vault) {
        throw new Error(`Vault not found: ${vaultAddress}`);
      }

      return await this.calculateSingleVaultRoi(vault);
    } catch (error) {
      logger.error(`Error calculating vault ROI for ${vaultAddress}:`, error);
      throw error;
    }
  }

  /**
   * Get ROI analytics for a specific grant stream
   * @param {string} grantStreamAddress - Grant stream contract address
   * @returns {Promise<Object>} Grant stream ROI analytics
   */
  async getGrantStreamRoiAnalytics(grantStreamAddress) {
    try {
      const grantStream = await GrantStream.findOne({
        where: { address: grantStreamAddress }
      });

      if (!grantStream) {
        throw new Error(`Grant stream not found: ${grantStreamAddress}`);
      }

      return await this.calculateSingleGrantStreamRoi(grantStream);
    } catch (error) {
      logger.error(`Error calculating grant stream ROI for ${grantStreamAddress}:`, error);
      throw error;
    }
  }

  /**
   * Calculate ROI for multiple vaults
   * @private
   */
  async calculateVaultsRoi(vaults, currentTime) {
    const vaultRoiData = [];

    for (const vault of vaults) {
      try {
        const vaultRoi = await this.calculateSingleVaultRoi(vault, currentTime);
        vaultRoiData.push(vaultRoi);
      } catch (error) {
        logger.error(`Error calculating ROI for vault ${vault.address}:`, error);
        // Continue with other vaults
      }
    }

    return vaultRoiData;
  }

  /**
   * Calculate ROI for a single vault
   * @private
   */
  async calculateSingleVaultRoi(vault, currentTime = new Date()) {
    const tokenAddress = vault.token_address;
    const createdAt = vault.created_at;

    // Get grant price (price at vault creation)
    const grantPrice = await this.getGrantPrice(tokenAddress, createdAt);
    
    // Get current market price
    const currentPrice = await this.getCurrentMarketPrice(tokenAddress);

    // Calculate total allocated and withdrawn amounts
    const totalAllocated = vault.total_amount || '0';
    const totalWithdrawn = await this.getTotalWithdrawnForVault(vault.id);
    const currentBalance = parseFloat(totalAllocated) - parseFloat(totalWithdrawn);

    // Calculate ROI metrics
    const roiMetrics = this.calculateRoiMetrics(
      parseFloat(grantPrice),
      parseFloat(currentPrice),
      parseFloat(totalAllocated),
      parseFloat(totalWithdrawn),
      currentBalance
    );

    return {
      vault_address: vault.address,
      vault_name: vault.name,
      token_address: tokenAddress,
      grant_date: createdAt,
      grant_price_usd: grantPrice,
      current_price_usd: currentPrice,
      total_allocated: totalAllocated,
      total_withdrawn: totalWithdrawn.toString(),
      current_balance: currentBalance.toString(),
      price_change_percentage: roiMetrics.priceChangePercentage,
      roi_percentage: roiMetrics.roiPercentage,
      unrealized_gains_usd: roiMetrics.unrealizedGains,
      realized_gains_usd: roiMetrics.realizedGains,
      total_value_usd: roiMetrics.totalValue,
      investment_value_usd: roiMetrics.investmentValue,
      data_quality: roiMetrics.dataQuality
    };
  }

  /**
   * Calculate ROI for multiple grant streams
   * @private
   */
  async calculateGrantStreamsRoi(grantStreams, currentTime) {
    const grantRoiData = [];

    for (const grantStream of grantStreams) {
      try {
        const grantRoi = await this.calculateSingleGrantStreamRoi(grantStream, currentTime);
        grantRoiData.push(grantRoi);
      } catch (error) {
        logger.error(`Error calculating ROI for grant stream ${grantStream.address}:`, error);
        // Continue with other grant streams
      }
    }

    return grantRoiData;
  }

  /**
   * Calculate ROI for a single grant stream
   * @private
   */
  async calculateSingleGrantStreamRoi(grantStream, currentTime = new Date()) {
    const tokenAddress = grantStream.token_address;
    const startDate = grantStream.start_date;

    // Get grant price (price at grant stream start)
    const grantPrice = await this.getGrantPrice(tokenAddress, startDate);
    
    // Get current market price
    const currentPrice = await this.getCurrentMarketPrice(tokenAddress);

    // Calculate ROI metrics
    const roiMetrics = this.calculateRoiMetrics(
      parseFloat(grantPrice),
      parseFloat(currentPrice),
      parseFloat(grantStream.current_amount || '0'),
      0, // Grant streams typically don't track withdrawals
      parseFloat(grantStream.current_amount || '0')
    );

    return {
      grant_stream_address: grantStream.address,
      grant_stream_name: grantStream.name,
      token_address: tokenAddress,
      grant_date: startDate,
      grant_price_usd: grantPrice,
      current_price_usd: currentPrice,
      current_amount: grantStream.current_amount || '0',
      target_amount: grantStream.target_amount || '0',
      price_change_percentage: roiMetrics.priceChangePercentage,
      roi_percentage: roiMetrics.roiPercentage,
      unrealized_gains_usd: roiMetrics.unrealizedGains,
      total_value_usd: roiMetrics.totalValue,
      investment_value_usd: roiMetrics.investmentValue,
      data_quality: roiMetrics.dataQuality
    };
  }

  /**
   * Get price at grant time
   * @private
   */
  async getGrantPrice(tokenAddress, grantDate) {
    try {
      // First try to get historical price from database
      const historicalPrice = await HistoricalTokenPrice.findOne({
        where: {
          token_address: tokenAddress,
          price_date: grantDate.toISOString().split('T')[0] // YYYY-MM-DD format
        },
        order: [['created_at', 'DESC']]
      });

      if (historicalPrice) {
        return parseFloat(historicalPrice.price_usd);
      }

      // If not in database, try to fetch from price service
      const price = await priceService.getTokenPrice(tokenAddress, grantDate.getTime());
      return parseFloat(price);
    } catch (error) {
      logger.error(`Error fetching grant price for ${tokenAddress} at ${grantDate}:`, error);
      
      // Fallback: use current price as approximation
      try {
        const currentPrice = await this.getCurrentMarketPrice(tokenAddress);
        logger.warn(`Using current price as fallback for grant price of ${tokenAddress}`);
        return currentPrice;
      } catch (fallbackError) {
        throw new Error(`Unable to determine grant price for ${tokenAddress}: ${error.message}`);
      }
    }
  }

  /**
   * Get current market price from DEX oracle
   * @private
   */
  async getCurrentMarketPrice(tokenAddress) {
    try {
      // Try Stellar DEX first for more accurate pricing
      const dexPriceData = await stellarDexPriceService.getTokenVWAP(tokenAddress);
      return parseFloat(dexPriceData.price_usd);
    } catch (error) {
      logger.error(`Error fetching DEX price for ${tokenAddress}:`, error);
      
      // Fallback to standard price service
      try {
        const price = await priceService.getTokenPrice(tokenAddress);
        return parseFloat(price);
      } catch (fallbackError) {
        throw new Error(`Unable to determine current market price for ${tokenAddress}: ${fallbackError.message}`);
      }
    }
  }

  /**
   * Calculate ROI metrics
   * @private
   */
  calculateRoiMetrics(grantPrice, currentPrice, totalAllocated, totalWithdrawn, currentBalance) {
    const priceChange = currentPrice - grantPrice;
    const priceChangePercentage = grantPrice > 0 ? (priceChange / grantPrice) * 100 : 0;

    const investmentValue = totalAllocated * grantPrice;
    const currentValue = currentBalance * currentPrice;
    const realizedValue = totalWithdrawn * currentPrice; // Simplified: using current price for realized gains
    const totalValue = currentValue + realizedValue;

    const unrealizedGains = currentValue - (currentBalance * grantPrice);
    const realizedGains = realizedValue - (totalWithdrawn * grantPrice);
    const totalGains = unrealizedGains + realizedGains;

    const roiPercentage = investmentValue > 0 ? (totalGains / investmentValue) * 100 : 0;

    // Assess data quality based on price sources and availability
    const dataQuality = this.assessDataQuality(grantPrice, currentPrice);

    return {
      priceChange,
      priceChangePercentage,
      investmentValue,
      currentValue,
      realizedValue,
      totalValue,
      unrealizedGains,
      realizedGains,
      totalGains,
      roiPercentage,
      dataQuality
    };
  }

  /**
   * Assess data quality based on price sources
   * @private
   */
  assessDataQuality(grantPrice, currentPrice) {
    if (!grantPrice || !currentPrice) return 'poor';
    if (grantPrice === 0 || currentPrice === 0) return 'poor';
    
    // If we have both prices from reliable sources
    return 'good';
  }

  /**
   * Calculate overall metrics across all investments
   * @private
   */
  calculateOverallMetrics(vaultRoiData, grantRoiData) {
    const allInvestments = [...vaultRoiData, ...grantRoiData];
    
    if (allInvestments.length === 0) {
      return {
        total_investment_usd: 0,
        total_current_value_usd: 0,
        total_unrealized_gains_usd: 0,
        total_realized_gains_usd: 0,
        overall_roi_percentage: 0,
        average_price_change_percentage: 0,
        investment_count: 0,
        profitable_investments: 0,
        losing_investments: 0
      };
    }

    const totalInvestment = allInvestments.reduce((sum, inv) => sum + parseFloat(inv.investment_value_usd || 0), 0);
    const totalCurrentValue = allInvestments.reduce((sum, inv) => sum + parseFloat(inv.total_value_usd || 0), 0);
    const totalUnrealizedGains = allInvestments.reduce((sum, inv) => sum + parseFloat(inv.unrealized_gains_usd || 0), 0);
    const totalRealizedGains = allInvestments.reduce((sum, inv) => sum + parseFloat(inv.realized_gains_usd || 0), 0);
    const totalGains = totalUnrealizedGains + totalRealizedGains;
    
    const overallRoiPercentage = totalInvestment > 0 ? (totalGains / totalInvestment) * 100 : 0;
    const avgPriceChange = allInvestments.reduce((sum, inv) => sum + parseFloat(inv.price_change_percentage || 0), 0) / allInvestments.length;
    
    const profitableInvestments = allInvestments.filter(inv => parseFloat(inv.total_value_usd || 0) > parseFloat(inv.investment_value_usd || 0)).length;
    const losingInvestments = allInvestments.filter(inv => parseFloat(inv.total_value_usd || 0) < parseFloat(inv.investment_value_usd || 0)).length;

    return {
      total_investment_usd: totalInvestment,
      total_current_value_usd: totalCurrentValue,
      total_unrealized_gains_usd: totalUnrealizedGains,
      total_realized_gains_usd: totalRealizedGains,
      overall_roi_percentage: overallRoiPercentage,
      average_price_change_percentage: avgPriceChange,
      investment_count: allInvestments.length,
      profitable_investments: profitableInvestments,
      losing_investments: losingInvestments
    };
  }

  /**
   * Generate summary text
   * @private
   */
  generateSummary(overallMetrics) {
    const roi = overallMetrics.overall_roi_percentage;
    const totalGains = overallMetrics.total_unrealized_gains_usd + overallMetrics.total_realized_gains_usd;
    
    if (roi > 0) {
      return `Your investments have gained ${roi.toFixed(2)}% ($${totalGains.toFixed(2)}) overall.`;
    } else if (roi < 0) {
      return `Your investments have lost ${Math.abs(roi).toFixed(2)}% ($${Math.abs(totalGains).toFixed(2)}) overall.`;
    } else {
      return 'Your investments are at break-even.';
    }
  }

  /**
   * Get user's vaults
   * @private
   */
  async getUserVaults(userAddress) {
    return await Vault.findAll({
      where: { owner_address: userAddress },
      include: [
        {
          model: Beneficiary,
          as: 'beneficiaries'
        }
      ]
    });
  }

  /**
   * Get user's grant streams
   * @private
   */
  async getUserGrantStreams(userAddress) {
    return await GrantStream.findAll({
      where: { owner_address: userAddress }
    });
  }

  /**
   * Get total withdrawn amount for a vault
   * @private
   */
  async getTotalWithdrawnForVault(vaultId) {
    const beneficiaries = await Beneficiary.findAll({
      where: { vault_id: vaultId }
    });

    return beneficiaries.reduce((total, beneficiary) => {
      return total + parseFloat(beneficiary.total_withdrawn || 0);
    }, 0);
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get ROI analytics for multiple users (batch operation)
   * @param {Array<string>} userAddresses - Array of user addresses
   * @returns {Promise<Array>} Array of ROI analytics data
   */
  async getBatchUserRoiAnalytics(userAddresses) {
    const results = [];
    
    for (const userAddress of userAddresses) {
      try {
        const analytics = await this.getUserRoiAnalytics(userAddress);
        results.push(analytics);
      } catch (error) {
        logger.error(`Error getting batch ROI analytics for ${userAddress}:`, error);
        results.push({
          user_address: userAddress,
          error: error.message,
          timestamp: new Date()
        });
      }
    }

    return results;
  }

  /**
   * Get market overview for all tokens in the system
   * @returns {Promise<Object>} Market overview data
   */
  async getMarketOverview() {
    try {
      // Get unique token addresses from vaults and grant streams
      const vaultTokens = await Vault.findAll({
        attributes: [[sequelize.fn('DISTINCT', sequelize.col('token_address')), 'token_address']],
        raw: true
      });

      const grantTokens = await GrantStream.findAll({
        attributes: [[sequelize.fn('DISTINCT', sequelize.col('token_address')), 'token_address']],
        raw: true
      });

      const uniqueTokens = [...new Set([
        ...vaultTokens.map(t => t.token_address),
        ...grantTokens.map(t => t.token_address)
      ])];

      const tokenData = [];
      
      for (const tokenAddress of uniqueTokens) {
        try {
          const currentPrice = await this.getCurrentMarketPrice(tokenAddress);
          const historicalPrice = await HistoricalTokenPrice.findOne({
            where: { token_address: tokenAddress },
            order: [['price_date', 'DESC']]
          });

          tokenData.push({
            token_address: tokenAddress,
            current_price_usd: currentPrice,
            last_known_price_usd: historicalPrice ? parseFloat(historicalPrice.price_usd) : null,
            price_updated: new Date()
          });
        } catch (error) {
          logger.error(`Error getting market data for token ${tokenAddress}:`, error);
        }
      }

      return {
        timestamp: new Date(),
        total_tokens: uniqueTokens.length,
        tokens: tokenData
      };
    } catch (error) {
      logger.error('Error getting market overview:', error);
      throw error;
    }
  }
}

module.exports = new RoiAnalyticsService();
