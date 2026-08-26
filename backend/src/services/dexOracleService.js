const logger = require('../utils/logger');
const axios = require('axios');
const stellarDexPriceService = require('./stellarDexPriceService');
const priceService = require('./priceService');

/**
 * DEX Oracle Service
 * Aggregates price data from multiple DEX sources for reliable market pricing
 * Provides weighted average pricing and confidence scores
 */
class DexOracleService {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 60000; // 1 minute cache for real-time prices
    this.sources = [
      'stellar_dex',
      'coingecko',
      'coinmarketcap',
      'uniswap_v2',
      'uniswap_v3'
    ];
  }

  /**
   * Get current market price with oracle aggregation
   * @param {string} tokenAddress - Token contract address
   * @param {Object} options - Oracle options
   * @returns {Promise<Object>} Aggregated price data
   */
  async getCurrentPrice(tokenAddress, options = {}) {
    const {
      sources = this.sources,
      minConfidence = 0.7,
      timeout = 10000
    } = options;

    const cacheKey = `oracle-${tokenAddress}-${JSON.stringify(options)}`;
    
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }
    }

    try {
      const priceData = await this.aggregatePrices(tokenAddress, sources, timeout);
      
      // Calculate confidence score based on data consistency
      const confidence = this.calculateConfidence(priceData.prices);
      
      if (confidence < minConfidence) {
        logger.warn(`Low confidence (${confidence}) for token ${tokenAddress} price`);
      }

      const result = {
        token_address: tokenAddress,
        price_usd: priceData.weightedPrice,
        confidence_score: confidence,
        sources: priceData.prices,
        source_count: priceData.prices.length,
        timestamp: new Date(),
        volume_24h_usd: priceData.volume24h,
        price_change_24h: priceData.priceChange24h
      };

      // Cache the result
      this.cache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });

      return result;
    } catch (error) {
      logger.error(`Error getting oracle price for ${tokenAddress}:`, error);
      throw error;
    }
  }

  /**
   * Get historical price with oracle aggregation
   * @param {string} tokenAddress - Token contract address
   * @param {Date} date - Historical date
   * @param {Object} options - Oracle options
   * @returns {Promise<Object>} Historical price data
   */
  async getHistoricalPrice(tokenAddress, date, options = {}) {
    const {
      sources = ['coingecko', 'stellar_dex'],
      minConfidence = 0.6
    } = options;

    const cacheKey = `oracle-hist-${tokenAddress}-${date.toISOString().split('T')[0]}`;
    
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout * 60) { // 1 hour cache for historical
        return cached.data;
      }
    }

    try {
      const priceData = await this.aggregateHistoricalPrices(tokenAddress, date, sources);
      const confidence = this.calculateConfidence(priceData.prices);

      const result = {
        token_address: tokenAddress,
        price_date: date,
        price_usd: priceData.weightedPrice,
        confidence_score: confidence,
        sources: priceData.prices,
        source_count: priceData.prices.length,
        timestamp: new Date()
      };

      this.cache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });

      return result;
    } catch (error) {
      logger.error(`Error getting historical oracle price for ${tokenAddress}:`, error);
      throw error;
    }
  }

  /**
   * Aggregate prices from multiple sources
   * @private
   */
  async aggregatePrices(tokenAddress, sources, timeout) {
    const pricePromises = sources.map(source => 
      this.getPriceFromSource(tokenAddress, source, timeout)
        .catch(error => {
          logger.warn(`Failed to get price from ${source} for ${tokenAddress}:`, error.message);
          return null;
        })
    );

    const results = await Promise.allSettled(pricePromises);
    const validPrices = results
      .filter(result => result.status === 'fulfilled' && result.value !== null)
      .map(result => result.value);

    if (validPrices.length === 0) {
      throw new Error(`No valid price data available for token ${tokenAddress}`);
    }

    // Calculate weighted average based on source reliability and volume
    const weightedPrice = this.calculateWeightedPrice(validPrices);
    const volume24h = this.getAverageVolume(validPrices);
    const priceChange24h = this.getAveragePriceChange(validPrices);

    return {
      weightedPrice,
      volume24h,
      priceChange24h,
      prices: validPrices
    };
  }

  /**
   * Aggregate historical prices from multiple sources
   * @private
   */
  async aggregateHistoricalPrices(tokenAddress, date, sources) {
    const pricePromises = sources.map(source => 
      this.getHistoricalPriceFromSource(tokenAddress, date, source)
        .catch(error => {
          logger.warn(`Failed to get historical price from ${source} for ${tokenAddress}:`, error.message);
          return null;
        })
    );

    const results = await Promise.allSettled(pricePromises);
    const validPrices = results
      .filter(result => result.status === 'fulfilled' && result.value !== null)
      .map(result => result.value);

    if (validPrices.length === 0) {
      throw new Error(`No valid historical price data available for token ${tokenAddress}`);
    }

    const weightedPrice = this.calculateWeightedPrice(validPrices);

    return {
      weightedPrice,
      prices: validPrices
    };
  }

  /**
   * Get price from a specific source
   * @private
   */
  async getPriceFromSource(tokenAddress, source, timeout) {
    switch (source) {
      case 'stellar_dex':
        return await this.getStellarDexPrice(tokenAddress);
      case 'coingecko':
        return await this.getCoinGeckoPrice(tokenAddress);
      case 'coinmarketcap':
        return await this.getCoinMarketCapPrice(tokenAddress);
      case 'uniswap_v2':
        return await this.getUniswapV2Price(tokenAddress);
      case 'uniswap_v3':
        return await this.getUniswapV3Price(tokenAddress);
      default:
        throw new Error(`Unsupported price source: ${source}`);
    }
  }

  /**
   * Get historical price from a specific source
   * @private
   */
  async getHistoricalPriceFromSource(tokenAddress, date, source) {
    switch (source) {
      case 'stellar_dex':
        return await this.getStellarDexHistoricalPrice(tokenAddress, date);
      case 'coingecko':
        return await this.getCoinGeckoHistoricalPrice(tokenAddress, date);
      case 'coinmarketcap':
        return await this.getCoinMarketCapHistoricalPrice(tokenAddress, date);
      default:
        throw new Error(`Historical prices not supported for source: ${source}`);
    }
  }

  /**
   * Get price from Stellar DEX
   * @private
   */
  async getStellarDexPrice(tokenAddress) {
    try {
      const dexData = await stellarDexPriceService.getTokenVWAP(tokenAddress);
      return {
        source: 'stellar_dex',
        price: parseFloat(dexData.vwap_24h_usd),
        volume: parseFloat(dexData.volume_24h_usd || 0),
        confidence: 0.85, // High confidence for on-chain DEX data
        timestamp: new Date(),
        metadata: dexData
      };
    } catch (error) {
      throw new Error(`Stellar DEX price fetch failed: ${error.message}`);
    }
  }

  /**
   * Get historical price from Stellar DEX
   * @private
   */
  async getStellarDexHistoricalPrice(tokenAddress, date) {
    try {
      const dexData = await stellarDexPriceService.getTokenVWAP(tokenAddress, date);
      return {
        source: 'stellar_dex',
        price: parseFloat(dexData.vwap_24h_usd),
        confidence: 0.75, // Slightly lower confidence for historical data
        timestamp: date,
        metadata: dexData
      };
    } catch (error) {
      throw new Error(`Stellar DEX historical price fetch failed: ${error.message}`);
    }
  }

  /**
   * Get price from CoinGecko
   * @private
   */
  async getCoinGeckoPrice(tokenAddress) {
    try {
      const price = await priceService.getCoinGeckoPrice(tokenAddress);
      return {
        source: 'coingecko',
        price: parseFloat(price),
        volume: 0, // CoinGecko basic price doesn't include volume
        confidence: 0.80,
        timestamp: new Date()
      };
    } catch (error) {
      throw new Error(`CoinGecko price fetch failed: ${error.message}`);
    }
  }

  /**
   * Get historical price from CoinGecko
   * @private
   */
  async getCoinGeckoHistoricalPrice(tokenAddress, date) {
    try {
      const dateStr = date.toISOString().split('T')[0];
      const price = await priceService.getCoinGeckoHistoricalPrice(tokenAddress, dateStr);
      return {
        source: 'coingecko',
        price: parseFloat(price),
        confidence: 0.70,
        timestamp: date
      };
    } catch (error) {
      throw new Error(`CoinGecko historical price fetch failed: ${error.message}`);
    }
  }

  /**
   * Get price from CoinMarketCap
   * @private
   */
  async getCoinMarketCapPrice(tokenAddress) {
    try {
      const price = await priceService.getCoinMarketCapLatestPrice(tokenAddress);
      return {
        source: 'coinmarketcap',
        price: parseFloat(price),
        volume: 0,
        confidence: 0.82,
        timestamp: new Date()
      };
    } catch (error) {
      throw new Error(`CoinMarketCap price fetch failed: ${error.message}`);
    }
  }

  /**
   * Get historical price from CoinMarketCap
   * @private
   */
  async getCoinMarketCapHistoricalPrice(tokenAddress, date) {
    try {
      // CoinMarketCap historical API requires different parameters
      // This is a simplified implementation
      throw new Error(`CoinMarketCap historical pricing not implemented for address-based queries`);
    } catch (error) {
      throw new Error(`CoinMarketCap historical price fetch failed: ${error.message}`);
    }
  }

  /**
   * Get price from Uniswap V2 (Ethereum)
   * @private
   */
  async getUniswapV2Price(tokenAddress) {
    try {
      // This would require Web3 integration and Uniswap V2 pair contracts
      // Simplified implementation for demonstration
      throw new Error(`Uniswap V2 integration not implemented`);
    } catch (error) {
      throw new Error(`Uniswap V2 price fetch failed: ${error.message}`);
    }
  }

  /**
   * Get price from Uniswap V3 (Ethereum)
   * @private
   */
  async getUniswapV3Price(tokenAddress) {
    try {
      // This would require Web3 integration and Uniswap V3 pool contracts
      // Simplified implementation for demonstration
      throw new Error(`Uniswap V3 integration not implemented`);
    } catch (error) {
      throw new Error(`Uniswap V3 price fetch failed: ${error.message}`);
    }
  }

  /**
   * Calculate weighted average price
   * @private
   */
  calculateWeightedPrice(priceData) {
    if (priceData.length === 0) return 0;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const data of priceData) {
      const weight = this.calculateSourceWeight(data.source, data.confidence, data.volume);
      weightedSum += data.price * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : priceData[0].price;
  }

  /**
   * Calculate weight for a price source
   * @private
   */
  calculateSourceWeight(source, confidence, volume) {
    let baseWeight = 1.0;
    
    // Adjust weight based on source reliability
    const sourceWeights = {
      'stellar_dex': 1.2,      // Higher weight for on-chain DEX
      'coingecko': 1.0,        // Standard weight
      'coinmarketcap': 1.1,    // Slightly higher for premium data
      'uniswap_v2': 1.15,      // High weight for major DEX
      'uniswap_v3': 1.15       // High weight for major DEX
    };

    baseWeight *= sourceWeights[source] || 1.0;
    baseWeight *= confidence;
    
    // Volume bonus (capped at 2x weight)
    if (volume > 0) {
      const volumeBonus = Math.min(1 + (volume / 100000), 2.0);
      baseWeight *= volumeBonus;
    }

    return baseWeight;
  }

  /**
   * Calculate confidence score based on price consistency
   * @private
   */
  calculateConfidence(priceData) {
    if (priceData.length === 0) return 0;
    if (priceData.length === 1) return priceData[0].confidence;

    const prices = priceData.map(data => data.price);
    const mean = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const variance = prices.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / prices.length;
    const standardDeviation = Math.sqrt(variance);
    
    // Calculate coefficient of variation (lower is better)
    const coefficientOfVariation = mean > 0 ? standardDeviation / mean : 1;
    
    // Base confidence on how consistent the prices are
    let confidence = 1.0 - Math.min(coefficientOfVariation, 1.0);
    
    // Adjust based on number of sources
    const sourceBonus = Math.min(priceData.length / 3, 0.2);
    confidence += sourceBonus;
    
    // Average individual source confidences
    const avgSourceConfidence = priceData.reduce((sum, data) => sum + data.confidence, 0) / priceData.length;
    confidence = (confidence + avgSourceConfidence) / 2;
    
    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Get average volume across sources
   * @private
   */
  getAverageVolume(priceData) {
    const volumes = priceData.map(data => data.volume || 0);
    return volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length;
  }

  /**
   * Get average price change across sources
   * @private
   */
  getAveragePriceChange(priceData) {
    const priceChanges = priceData
      .map(data => data.metadata?.price_change_24h || 0)
      .filter(change => change !== 0);
    
    if (priceChanges.length === 0) return 0;
    return priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;
  }

  /**
   * Get oracle health status
   * @returns {Promise<Object>} Oracle health information
   */
  async getOracleHealth() {
    const health = {
      status: 'healthy',
      timestamp: new Date(),
      sources: {},
      cache_size: this.cache.size,
      uptime: process.uptime()
    };

    // Test each source
    for (const source of this.sources) {
      try {
        const startTime = Date.now();
        // Use a common token like USDC for testing
        await this.getPriceFromSource('USDC', source, 5000);
        const responseTime = Date.now() - startTime;
        
        health.sources[source] = {
          status: 'healthy',
          response_time_ms: responseTime,
          last_checked: new Date()
        };
      } catch (error) {
        health.sources[source] = {
          status: 'unhealthy',
          error: error.message,
          last_checked: new Date()
        };
        health.status = 'degraded';
      }
    }

    return health;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get supported sources
   * @returns {Array<string>} Array of supported source names
   */
  getSupportedSources() {
    return [...this.sources];
  }
}

module.exports = new DexOracleService();
