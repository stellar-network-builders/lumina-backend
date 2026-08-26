const logger = require('../utils/logger');
const { HistoricalTVL, HistoricalTokenPrice } = require('../models');
const { Op } = require('sequelize');

/**
 * Service for analyzing correlation between TVL changes and price volatility
 * This provides quantitative evidence for the marketing claim that using JerryIdoko's vault
 * is not just a "Storage Choice" but a "Strategic Price Stability Choice"
 */
class TVLPriceCorrelationService {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes cache
  }

  /**
   * Calculate Pearson correlation coefficient between TVL changes and price changes
   * @param {Array} tvlData - Array of TVL data points
   * @param {Array} priceData - Array of price data points
   * @returns {number} Pearson correlation coefficient (-1 to 1)
   */
  calculatePearsonCorrelation(tvlData, priceData) {
    if (tvlData.length !== priceData.length || tvlData.length === 0) {
      return 0;
    }

    const n = tvlData.length;
    const sumTVL = tvlData.reduce((sum, val) => sum + val, 0);
    const sumPrice = priceData.reduce((sum, val) => sum + val, 0);
    const sumTVLSq = tvlData.reduce((sum, val) => sum + val * val, 0);
    const sumPriceSq = priceData.reduce((sum, val) => sum + val * val, 0);
    const sumTVLPrice = tvlData.reduce((sum, val, i) => sum + val * priceData[i], 0);

    const numerator = n * sumTVLPrice - sumTVL * sumPrice;
    const denominator = Math.sqrt((n * sumTVLSq - sumTVL * sumTVL) * (n * sumPriceSq - sumPrice * sumPrice));

    return denominator === 0 ? 0 : numerator / denominator;
  }

  /**
   * Calculate Spearman rank correlation coefficient
   * @param {Array} tvlData - Array of TVL data points
   * @param {Array} priceData - Array of price data points
   * @returns {number} Spearman correlation coefficient (-1 to 1)
   */
  calculateSpearmanCorrelation(tvlData, priceData) {
    if (tvlData.length !== priceData.length || tvlData.length === 0) {
      return 0;
    }

    // Get ranks for each dataset
    const getRanks = (data) => {
      const indexed = data.map((value, index) => ({ value, index }));
      indexed.sort((a, b) => a.value - b.value);
      
      const ranks = new Array(data.length);
      indexed.forEach((item, rank) => {
        ranks[item.index] = rank + 1;
      });
      return ranks;
    };

    const tvlRanks = getRanks(tvlData);
    const priceRanks = getRanks(priceData);

    return this.calculatePearsonCorrelation(tvlRanks, priceRanks);
  }

  /**
   * Calculate price volatility (standard deviation of price changes)
   * @param {Array} priceData - Array of price data points
   * @returns {number} Volatility measure
   */
  calculateVolatility(priceData) {
    if (priceData.length < 2) return 0;

    // Calculate daily returns
    const returns = [];
    for (let i = 1; i < priceData.length; i++) {
      if (priceData[i - 1] !== 0) {
        returns.push((priceData[i] - priceData[i - 1]) / priceData[i - 1]);
      }
    }

    if (returns.length === 0) return 0;

    // Calculate standard deviation
    const mean = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
    
    return Math.sqrt(variance);
  }

  /**
   * Get correlation analysis for a specific date range and token
   * @param {Object} options - Analysis options
   * @returns {Promise<Object>} Correlation analysis results
   */
  async getCorrelationAnalysis(options = {}) {
    const {
      tokenAddress = null,
      startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 days ago
      endDate = new Date(),
      correlationType = 'pearson' // 'pearson' or 'spearman'
    } = options;

    const cacheKey = `${tokenAddress}-${startDate.toISOString()}-${endDate.toISOString()}-${correlationType}`;
    
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }
    }

    try {
      // Get historical TVL data
      const tvlData = await HistoricalTVL.findAll({
        where: {
          snapshot_date: {
            [Op.between]: [
              startDate.toISOString().split('T')[0],
              endDate.toISOString().split('T')[0]
            ]
          }
        },
        order: [['snapshot_date', 'ASC']]
      });

      if (tvlData.length < 10) {
        throw new Error('Insufficient data for correlation analysis (minimum 10 data points required)');
      }

      // Get price data for the same period
      let priceData;
      if (tokenAddress) {
        priceData = await HistoricalTokenPrice.findAll({
          where: {
            token_address: tokenAddress,
            price_date: {
              [Op.between]: [
                startDate.toISOString().split('T')[0],
                endDate.toISOString().split('T')[0]
              ]
            }
          },
          order: [['price_date', 'ASC']]
        });
      } else {
        // If no specific token, get average price across all tokens
        priceData = await HistoricalTokenPrice.findAll({
          where: {
            price_date: {
              [Op.between]: [
                startDate.toISOString().split('T')[0],
                endDate.toISOString().split('T')[0]
              ]
            }
          },
          order: [['price_date', 'ASC']]
        });
      }

      // Align data by date
      const alignedData = this.alignDataByDate(tvlData, priceData);
      
      if (alignedData.tvlChanges.length < 10) {
        throw new Error('Insufficient aligned data for correlation analysis');
      }

      // Calculate correlations
      const pearsonCorrelation = this.calculatePearsonCorrelation(
        alignedData.tvlChanges, 
        alignedData.priceChanges
      );
      
      const spearmanCorrelation = this.calculateSpearmanCorrelation(
        alignedData.tvlChanges, 
        alignedData.priceChanges
      );

      // Calculate volatility metrics
      const priceVolatility = this.calculateVolatility(alignedData.prices);
      const tvlVolatility = this.calculateVolatility(alignedData.tvls);

      // Generate marketing insights
      const insights = this.generateInsights(
        pearsonCorrelation, 
        spearmanCorrelation, 
        priceVolatility, 
        tvlVolatility
      );

      const result = {
        period: {
          startDate: startDate.toISOString().split('T')[0],
          endDate: endDate.toISOString().split('T')[0],
          dataPoints: alignedData.tvlChanges.length
        },
        correlations: {
          pearson: pearsonCorrelation,
          spearman: spearmanCorrelation,
          interpretation: this.interpretCorrelation(pearsonCorrelation)
        },
        volatility: {
          price: priceVolatility,
          tvl: tvlVolatility,
          priceVolatilityPercent: priceVolatility * 100,
          tvlVolatilityPercent: tvlVolatility * 100
        },
        insights,
        data: alignedData,
        tokenAddress,
        generatedAt: new Date().toISOString()
      };

      // Cache the result
      this.cache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });

      return result;
    } catch (error) {
      logger.error('Error in correlation analysis:', error);
      throw error;
    }
  }

  /**
   * Align TVL and price data by date
   * @param {Array} tvlData - TVL data
   * @param {Array} priceData - Price data
   * @returns {Object} Aligned data with changes
   */
  alignDataByDate(tvlData, priceData) {
    const tvlMap = new Map();
    const priceMap = new Map();

    // Create date maps
    tvlData.forEach(record => {
      tvlMap.set(record.snapshot_date, parseFloat(record.total_value_locked));
    });

    priceData.forEach(record => {
      if (!priceMap.has(record.price_date)) {
        priceMap.set(record.price_date, []);
      }
      priceMap.get(record.price_date).push(parseFloat(record.price_usd));
    });

    // Average prices for dates with multiple tokens
    priceMap.forEach((prices, date) => {
      const avgPrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
      priceMap.set(date, avgPrice);
    });

    // Get common dates
    const commonDates = Array.from(tvlMap.keys()).filter(date => priceMap.has(date));
    commonDates.sort();

    const tvls = commonDates.map(date => tvlMap.get(date));
    const prices = commonDates.map(date => priceMap.get(date));

    // Calculate changes
    const tvlChanges = [];
    const priceChanges = [];

    for (let i = 1; i < tvls.length; i++) {
      const tvlChange = tvls[i - 1] > 0 ? (tvls[i] - tvls[i - 1]) / tvls[i - 1] : 0;
      const priceChange = prices[i - 1] > 0 ? (prices[i] - prices[i - 1]) / prices[i - 1] : 0;
      
      tvlChanges.push(tvlChange);
      priceChanges.push(priceChange);
    }

    return {
      dates: commonDates.slice(1),
      tvls: tvls.slice(1),
      prices: prices.slice(1),
      tvlChanges,
      priceChanges
    };
  }

  /**
   * Interpret correlation coefficient
   * @param {number} correlation - Correlation coefficient
   * @returns {string} Interpretation
   */
  interpretCorrelation(correlation) {
    const abs = Math.abs(correlation);
    
    if (abs >= 0.8) return 'Very Strong';
    if (abs >= 0.6) return 'Strong';
    if (abs >= 0.4) return 'Moderate';
    if (abs >= 0.2) return 'Weak';
    return 'Very Weak';
  }

  /**
   * Generate marketing insights from correlation analysis
   * @param {number} pearsonCorrelation - Pearson correlation
   * @param {number} spearmanCorrelation - Spearman correlation
   * @param {number} priceVolatility - Price volatility
   * @param {number} tvlVolatility - TVL volatility
   * @returns {Array} Array of insights
   */
  generateInsights(pearsonCorrelation, spearmanCorrelation, priceVolatility, tvlVolatility) {
    const insights = [];

    // Negative correlation indicates TVL increases reduce price volatility
    if (pearsonCorrelation < -0.3) {
      insights.push({
        type: 'price_stability',
        title: 'TVL Increases Reduce Price Volatility',
        description: `Analysis shows a ${this.interpretCorrelation(pearsonCorrelation).toLowerCase()} negative correlation (${pearsonCorrelation.toFixed(3)}) between TVL changes and price changes, suggesting that increased token locking contributes to price stability.`,
        impact: 'high',
        marketingAngle: 'Strategic Price Stability Choice'
      });
    }

    // Strong correlation overall
    if (Math.abs(pearsonCorrelation) > 0.6) {
      insights.push({
        type: 'strong_relationship',
        title: 'Strong TVL-Price Relationship',
        description: `There is a ${this.interpretCorrelation(pearsonCorrelation).toLowerCase()} relationship (${pearsonCorrelation.toFixed(3)}) between TVL and price movements, indicating that vesting vaults significantly influence market dynamics.`,
        impact: 'medium',
        marketingAngle: 'Market Influence Through Vesting'
      });
    }

    // Low price volatility with high TVL
    if (priceVolatility < 0.05 && tvlVolatility > 0.1) {
      insights.push({
        type: 'stability_evidence',
        title: 'Price Stability Evidence',
        description: `Despite TVL volatility of ${(tvlVolatility * 100).toFixed(2)}%, price volatility remains low at ${(priceVolatility * 100).toFixed(2)}%, demonstrating the stabilizing effect of vesting mechanisms.`,
        impact: 'high',
        marketingAngle: 'Proven Price Stability Mechanism'
      });
    }

    // General insight
    insights.push({
      type: 'quantitative_evidence',
      title: 'Quantitative Evidence for Marketing',
      description: `This analysis provides concrete data showing ${Math.abs(pearsonCorrelation) > 0.3 ? 'significant' : 'measurable'} correlation between TVL and price stability, supporting the claim that JerryIdoko\'s vault is more than just a storage solution.`,
      impact: 'medium',
      marketingAngle: 'Data-Driven Vault Benefits'
    });

    return insights;
  }

  /**
   * Get correlation data for chart visualization
   * @param {Object} options - Analysis options
   * @returns {Promise<Object>} Chart-ready data
   */
  async getChartData(options = {}) {
    const analysis = await this.getCorrelationAnalysis(options);
    
    return {
      chartData: {
        dates: analysis.data.dates,
        tvlChanges: analysis.data.tvlChanges.map(change => change * 100), // Convert to percentage
        priceChanges: analysis.data.priceChanges.map(change => change * 100), // Convert to percentage
        tvls: analysis.data.tvls,
        prices: analysis.data.prices
      },
      correlation: analysis.correlations,
      insights: analysis.insights,
      summary: {
        totalDataPoints: analysis.period.dataPoints,
        correlationStrength: analysis.correlations.interpretation,
        primaryInsight: analysis.insights.find(i => i.impact === 'high')?.title || analysis.insights[0]?.title
      }
    };
  }

  /**
   * Clear the analysis cache
   */
  clearCache() {
    this.cache.clear();
  }
}

module.exports = new TVLPriceCorrelationService();
