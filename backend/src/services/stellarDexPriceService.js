const logger = require('../utils/logger');
const axios = require('axios');

/**
 * Service for fetching token prices from Stellar DEX
 * Calculates 24-hour VWAP (Volume Weighted Average Price) for tax reporting
 */
class StellarDexPriceService {
  constructor() {
    this.horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon.stellar.org';
    this.cache = new Map();
    this.cacheTimeout = 300000; // 5 minutes cache
  }

  /**
   * Get 24-hour VWAP for a token from Stellar DEX
   * @param {string} tokenAddress - Token contract address
   * @param {Date} date - Date to get price for (defaults to today)
   * @returns {Promise<Object>} Price data with VWAP
   */
  async getTokenVWAP(tokenAddress, date = new Date()) {
    const dateStr = date.toISOString().split('T')[0];
    const cacheKey = `${tokenAddress}-${dateStr}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }
    }

    try {
      // Get trades for the token over 24 hours
      const trades = await this.getTokenTrades(tokenAddress, date);
      
      if (!trades || trades.length === 0) {
        throw new Error(`No trades found for token ${tokenAddress} on ${dateStr}`);
      }

      // Calculate VWAP and other metrics
      const priceData = this.calculateVWAP(trades);
      
      // Cache the result
      this.cache.set(cacheKey, {
        data: priceData,
        timestamp: Date.now()
      });

      return priceData;
    } catch (error) {
      logger.error(`Error fetching VWAP for token ${tokenAddress}:`, error.message);
      throw error;
    }
  }

  /**
   * Get trades for a token from Stellar DEX
   * @private
   * @param {string} tokenAddress - Token contract address
   * @param {Date} date - Date to get trades for
   * @returns {Promise<Array>} Array of trade records
   */
  async getTokenTrades(tokenAddress, date) {
    const startTime = new Date(date);
    startTime.setHours(0, 0, 0, 0);
    
    const endTime = new Date(date);
    endTime.setHours(23, 59, 59, 999);

    try {
      // Query Stellar Horizon for trades
      const response = await axios.get(`${this.horizonUrl}/trades`, {
        params: {
          base_asset_type: 'credit_alphanum12',
          base_asset_code: this.extractAssetCode(tokenAddress),
          base_asset_issuer: this.extractAssetIssuer(tokenAddress),
          counter_asset_type: 'native', // XLM
          order: 'desc',
          limit: 200,
          cursor: this.getTimeCursor(startTime)
        },
        timeout: 10000
      });

      const trades = response.data._embedded?.records || [];
      
      // Filter trades within the 24-hour window
      return trades.filter(trade => {
        const tradeTime = new Date(trade.ledger_close_time);
        return tradeTime >= startTime && tradeTime <= endTime;
      });
    } catch (error) {
      logger.error(`Error fetching trades from Stellar DEX:`, error.message);
      
      // Fallback: try alternative asset pairing (USDC)
      try {
        return await this.getTokenTradesUSDC(tokenAddress, date);
      } catch (fallbackError) {
        logger.error(`Fallback USDC pairing also failed:`, fallbackError.message);
        throw error;
      }
    }
  }

  /**
   * Get trades against USDC as fallback
   * @private
   */
  async getTokenTradesUSDC(tokenAddress, date) {
    const startTime = new Date(date);
    startTime.setHours(0, 0, 0, 0);
    
    const endTime = new Date(date);
    endTime.setHours(23, 59, 59, 999);

    const response = await axios.get(`${this.horizonUrl}/trades`, {
      params: {
        base_asset_type: 'credit_alphanum12',
        base_asset_code: this.extractAssetCode(tokenAddress),
        base_asset_issuer: this.extractAssetIssuer(tokenAddress),
        counter_asset_type: 'credit_alphanum4',
        counter_asset_code: 'USDC',
        counter_asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', // Circle USDC issuer
        order: 'desc',
        limit: 200,
        cursor: this.getTimeCursor(startTime)
      },
      timeout: 10000
    });

    const trades = response.data._embedded?.records || [];
    
    return trades.filter(trade => {
      const tradeTime = new Date(trade.ledger_close_time);
      return tradeTime >= startTime && tradeTime <= endTime;
    });
  }

  /**
   * Calculate Volume Weighted Average Price from trades
   * @private
   * @param {Array} trades - Array of trade records
   * @returns {Object} Price data with VWAP
   */
  calculateVWAP(trades) {
    if (!trades || trades.length === 0) {
      throw new Error('No trades provided for VWAP calculation');
    }

    let totalVolume = 0;
    let totalValue = 0;
    let highPrice = 0;
    let lowPrice = Infinity;
    let openPrice = null;
    let closePrice = null;

    // Sort trades by time (oldest first)
    const sortedTrades = trades.sort((a, b) => 
      new Date(a.ledger_close_time) - new Date(b.ledger_close_time)
    );

    for (const trade of sortedTrades) {
      const price = parseFloat(trade.price.n) / parseFloat(trade.price.d);
      const volume = parseFloat(trade.base_amount);
      
      // VWAP calculation
      totalValue += price * volume;
      totalVolume += volume;
      
      // OHLC data
      if (openPrice === null) openPrice = price;
      closePrice = price;
      highPrice = Math.max(highPrice, price);
      lowPrice = Math.min(lowPrice, price);
    }

    if (totalVolume === 0) {
      throw new Error('Total volume is zero, cannot calculate VWAP');
    }

    const vwap = totalValue / totalVolume;

    return {
      vwap_24h_usd: vwap,
      price_usd: closePrice, // Use close price as current price
      volume_24h_usd: totalVolume,
      high_24h_usd: highPrice,
      low_24h_usd: lowPrice === Infinity ? closePrice : lowPrice,
      open_24h_usd: openPrice,
      close_24h_usd: closePrice,
      trade_count: trades.length,
      price_source: 'stellar_dex',
      data_quality: this.assessDataQuality(trades.length, totalVolume)
    };
  }

  /**
   * Assess data quality based on trade count and volume
   * @private
   */
  assessDataQuality(tradeCount, volume) {
    if (tradeCount >= 50 && volume >= 10000) return 'excellent';
    if (tradeCount >= 20 && volume >= 1000) return 'good';
    if (tradeCount >= 5 && volume >= 100) return 'fair';
    return 'poor';
  }

  /**
   * Extract asset code from token address
   * @private
   */
  extractAssetCode(tokenAddress) {
    // For Stellar, this might be encoded in the address
    // This is a simplified implementation - adjust based on actual token format
    if (tokenAddress.includes(':')) {
      return tokenAddress.split(':')[0];
    }
    return tokenAddress.substring(0, 12); // Max 12 chars for alphanum12
  }

  /**
   * Extract asset issuer from token address
   * @private
   */
  extractAssetIssuer(tokenAddress) {
    // For Stellar, this might be encoded in the address
    // This is a simplified implementation - adjust based on actual token format
    if (tokenAddress.includes(':')) {
      return tokenAddress.split(':')[1];
    }
    // If no separator, assume the address is the issuer
    return tokenAddress;
  }

  /**
   * Get cursor for time-based pagination
   * @private
   */
  getTimeCursor(date) {
    // Convert date to Stellar ledger cursor format
    // This is a simplified implementation
    return Math.floor(date.getTime() / 1000).toString();
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
  }
}

module.exports = new StellarDexPriceService();