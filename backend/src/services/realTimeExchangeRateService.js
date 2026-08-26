'use strict';

const logger = require('../utils/logger');
const { ConversionEvent } = require('../models');
const { sequelize } = require('../database/connection');
const StellarSdk = require('stellar-sdk');
const EventEmitter = require('events');

class RealTimeExchangeRateService extends EventEmitter {
  constructor() {
    super();
    this.horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon.stellar.org';
    this.server = new StellarSdk.Server(this.horizonUrl);
    this.isTracking = false;
    this.rateCache = new Map();
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    this.updateInterval = 30 * 1000; // 30 seconds
    this.dexPools = new Map();
    this.priceFeeds = new Map();
    
    // Initialize known DEX pools
    this.initializeDexpools();
  }

  /**
   * Start real-time exchange rate tracking
   */
  async start() {
    if (this.isTracking) {
      logger.info('Exchange rate tracking is already running');
      return;
    }

    try {
      logger.info('Starting real-time exchange rate tracking...');
      this.isTracking = true;

      // Start periodic price updates
      this.startPeriodicUpdates();
      
      // Start monitoring DEX order books
      await this.startDexMonitoring();
      
      // Start WebSocket connections for real-time data
      await this.startWebSocketConnections();

    } catch (error) {
      logger.error('Failed to start exchange rate tracking:', error);
      this.isTracking = false;
      throw error;
    }
  }

  /**
   * Stop real-time exchange rate tracking
   */
  async stop() {
    this.isTracking = false;
    logger.info('Real-time exchange rate tracking stopped');
    
    // Clear intervals
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
    
    // Close WebSocket connections
    if (this.wsConnections) {
      this.wsConnections.forEach(ws => ws.close());
    }
  }

  /**
   * Initialize known Stellar DEX pools
   */
  initializeDexpools() {
    // Major Stellar DEX pools
    this.dexPools.set('XLM/USDC', {
      name: 'StellarDEX',
      address: 'GDQ2A7JGKXIZHWAIQFQUXGJQW5M4M4Z7Y',
      reserves: ['XLM', 'USDC'],
      fee: 0.003
    });

    this.dexPools.set('USDC/XLM', {
      name: 'StellarDEX',
      address: 'GDQ2A7JGKXIZHWAIQFQUXGJQW5M4Z7Y',
      reserves: ['USDC', 'XLM'],
      fee: 0.003
    });

    // Add more pools as needed
    this.dexPools.set('TOKEN/USDC', {
      name: 'CustomDEX',
      address: 'CUSTOM_DEX_ADDRESS',
      reserves: ['TOKEN', 'USDC'],
      fee: 0.002
    });
  }

  /**
   * Start periodic price updates
   */
  startPeriodicUpdates() {
    this.updateTimer = setInterval(async () => {
      if (!this.isTracking) return;
      
      try {
        await this.updateAllRates();
      } catch (error) {
        logger.error('Error in periodic rate update:', error);
      }
    }, this.updateInterval);
  }

  /**
   * Start monitoring DEX order books
   */
  async startDexMonitoring() {
    // Monitor major DEX pools for price discovery
    for (const [pair, pool] of this.dexPools) {
      try {
        await this.monitorDexPool(pair, pool);
      } catch (error) {
        logger.error(`Error monitoring DEX pool ${pair}:`, error);
      }
    }
  }

  /**
   * Monitor a specific DEX pool
   * @param {string} pair - Trading pair (e.g., 'XLM/USDC')
   * @param {Object} pool - Pool configuration
   */
  async monitorDexPool(pair, pool) {
    try {
      // Get order book from DEX
      const orderbook = await this.getOrderBook(pool.address);
      
      if (orderbook) {
        // Calculate mid-price from order book
        const midPrice = this.calculateMidPrice(orderbook);
        
        // Update cached rate
        this.updateCachedRate(pair, midPrice, 'dex_orderbook');
        
        // Emit rate update event
        this.emit('rateUpdate', {
          pair,
          rate: midPrice,
          source: 'dex_orderbook',
          timestamp: new Date(),
          orderbook: {
            bids: orderbook.bids?.slice(0, 5) || [],
            asks: orderbook.asks?.slice(0, 5) || []
          }
        });
      }
    } catch (error) {
      logger.error(`Error monitoring pool ${pair}:`, error);
    }
  }

  /**
   * Get order book from DEX contract
   * @param {string} dexAddress - DEX contract address
   * @returns {Promise<Object>} Order book data
   */
  async getOrderBook(dexAddress) {
    try {
      // This would integrate with DEX smart contract calls
      // For now, simulate order book data
      const mockOrderbook = {
        bids: [
          { price: 0.09, amount: 1000000 }, // 1000 XLM at 0.09 USDC
          { price: 0.089, amount: 500000 },
          { price: 0.088, amount: 750000 }
        ],
        asks: [
          { price: 0.091, amount: 800000 }, // 800k XLM at 0.091 USDC
          { price: 0.092, amount: 600000 },
          { price: 0.093, amount: 450000 }
        ]
      };

      return mockOrderbook;
    } catch (error) {
      logger.error('Error getting order book:', error);
      return null;
    }
  }

  /**
   * Calculate mid-price from order book
   * @param {Object} orderbook - Order book with bids and asks
   * @returns {number} Mid-price
   */
  calculateMidPrice(orderbook) {
    if (!orderbook.bids || !orderbook.asks || 
        orderbook.bids.length === 0 || orderbook.asks.length === 0) {
      return null;
    }

    const bestBid = orderbook.bids[0];
    const bestAsk = orderbook.asks[0];
    
    if (bestBid && bestAsk) {
      return (bestBid.price + bestAsk.price) / 2;
    }

    return null;
  }

  /**
   * Start WebSocket connections for real-time data
   */
  async startWebSocketConnections() {
    try {
      // Connect to Stellar Horizon WebSocket for real-time transactions
      const wsUrl = this.horizonUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/transactions';
      
      this.wsConnections = [];
      
      // Monitor multiple asset pairs
      const pairsToMonitor = ['XLM-USDC', 'TOKEN-USDC', 'TOKEN-XLM'];
      
      for (const pair of pairsToMonitor) {
        const ws = new StellarSdk.ws.Server(wsUrl, {
          open: () => {
            logger.info(`WebSocket connected for ${pair}`);
          },
          message: (message) => {
            this.handleWebSocketMessage(message, pair);
          },
          error: (error) => {
            logger.error(`WebSocket error for ${pair}:`, error);
          }
        });

        this.wsConnections.push(ws);
        
        // Subscribe to transactions for this pair
        await this.subscribeToTransactions(ws, pair);
      }

    } catch (error) {
      logger.error('Error starting WebSocket connections:', error);
    }
  }

  /**
   * Subscribe to transactions for specific asset pair
   * @param {WebSocket} ws - WebSocket connection
   * @param {string} pair - Asset pair to monitor
   */
  async subscribeToTransactions(ws, pair) {
    try {
      // Subscribe to Stellar transactions involving the monitored assets
      const [asset1, asset2] = pair.split('-');
      
      const subscription = {
        stream: 'transactions',
        include: [asset1, asset2]
      };

      // This would use actual Stellar WebSocket subscription
      logger.info(`Subscribing to transactions for ${pair}`);
      
    } catch (error) {
      logger.error(`Error subscribing to ${pair}:`, error);
    }
  }

  /**
   * Handle WebSocket messages
   * @param {Object} message - WebSocket message
   * @param {string} pair - Asset pair
   */
  handleWebSocketMessage(message, pair) {
    try {
      if (message.type === 'transaction') {
        const transaction = message.payload;
        
        // Check if this transaction affects our monitored pair
        const rateUpdate = this.extractRateFromTransaction(transaction, pair);
        
        if (rateUpdate) {
          this.updateCachedRate(pair, rateUpdate.rate, 'websocket');
          
          this.emit('rateUpdate', {
            pair,
            rate: rateUpdate.rate,
            source: 'websocket',
            timestamp: new Date(),
            transaction: {
              hash: transaction.hash,
              ledger: transaction.ledger
            },
            confidence: rateUpdate.confidence
          });
        }
      }
    } catch (error) {
      logger.error('Error handling WebSocket message:', error);
    }
  }

  /**
   * Extract exchange rate from transaction
   * @param {Object} transaction - Stellar transaction
   * @param {string} pair - Asset pair
   * @returns {Object|null} Rate update or null
   */
  extractRateFromTransaction(transaction, pair) {
    try {
      if (!transaction.operations || transaction.operations.length === 0) {
        return null;
      }

      for (const operation of transaction.operations) {
        if (operation.type === 'path_payment_strict_send' || operation.type === 'path_payment_strict_receive') {
          const [asset1, asset2] = pair.split('-');
          
          // Check if this operation involves our monitored pair
          const involvesAsset1 = this.operationInvolvesAsset(operation, asset1);
          const involvesAsset2 = this.operationInvolvesAsset(operation, asset2);
          
          if (involvesAsset1 && involvesAsset2) {
            const rate = parseFloat(operation.destination_amount) / parseFloat(operation.source_amount);
            
            return {
              rate,
              confidence: this.calculateTransactionConfidence(operation),
              sourceAsset: asset1,
              destinationAsset: asset2
            };
          }
        }
      }

      return null;
    } catch (error) {
      logger.error('Error extracting rate from transaction:', error);
      return null;
    }
  }

  /**
   * Check if operation involves specific asset
   * @param {Object} operation - Stellar operation
   * @param {string} asset - Asset code
   * @returns {boolean} Whether operation involves asset
   */
  operationInvolvesAsset(operation, asset) {
    if (!operation.source_asset && !operation.destination_asset) {
      return false;
    }

    const sourceAsset = this.parseAsset(operation.source_asset);
    const destinationAsset = this.parseAsset(operation.destination_asset);

    return sourceAsset.code === asset || destinationAsset.code === asset;
  }

  /**
   * Parse asset from operation
   * @param {Object} asset - Asset object
   * @returns {Object} Parsed asset
   */
  parseAsset(asset) {
    if (asset.asset_type === 'native') {
      return { code: 'XLM', issuer: null };
    } else {
      return {
        code: asset.asset_code,
        issuer: asset.asset_issuer
      };
    }
  }

  /**
   * Calculate transaction confidence based on liquidity and other factors
   * @param {Object} operation - Stellar operation
   * @returns {number} Confidence score (0-1)
   */
  calculateTransactionConfidence(operation) {
    let confidence = 0.5; // Base confidence

    // Increase confidence for larger amounts (more likely to be accurate)
    const amount = parseFloat(operation.destination_amount || operation.source_amount);
    if (amount > 10000) {
      confidence += 0.2;
    } else if (amount > 1000) {
      confidence += 0.1;
    }

    // Increase confidence for operations with clear paths
    if (operation.path && operation.path.length > 0) {
      confidence += 0.1;
    }

    // Decrease confidence for very fast transactions (possible arbitrage)
    const transactionTime = new Date(operation.created_at || Date.now());
    const now = new Date();
    const timeDiff = now - transactionTime;
    
    if (timeDiff < 5000) { // Less than 5 seconds
      confidence -= 0.1;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Update cached exchange rate
   * @param {string} pair - Asset pair
   * @param {number} rate - Exchange rate
   * @param {string} source - Data source
   */
  updateCachedRate(pair, rate, source) {
    const cacheKey = `${pair}_${source}`;
    const cacheEntry = {
      rate,
      source,
      timestamp: new Date(),
      confidence: 0.8
    };

    this.rateCache.set(cacheKey, cacheEntry);
    
    // Clean old cache entries
    this.cleanExpiredCache();
  }

  /**
   * Clean expired cache entries
   */
  cleanExpiredCache() {
    const now = new Date();
    
    for (const [key, entry] of this.rateCache.entries()) {
      if (now - entry.timestamp > this.cacheTimeout) {
        this.rateCache.delete(key);
      }
    }
  }

  /**
   * Get current exchange rate for pair
   * @param {string} pair - Asset pair (e.g., 'XLM/USDC')
   * @param {string} preferredSource - Preferred data source
   * @returns {Promise<Object>} Current rate information
   */
  async getCurrentRate(pair, preferredSource = 'best') {
    try {
      // Check cache first
      const cachedEntry = this.getBestCachedRate(pair);
      if (cachedEntry && (new Date() - cachedEntry.timestamp < this.cacheTimeout)) {
        return cachedEntry;
      }

      // If not in cache or expired, fetch fresh data
      const freshRates = await this.fetchFreshRates(pair);
      
      if (freshRates.length > 0) {
        // Select best rate based on preferred source
        let selectedRate;
        
        switch (preferredSource) {
          case 'dex_orderbook':
            selectedRate = freshRates.find(r => r.source === 'dex_orderbook');
            break;
          case 'websocket':
            selectedRate = freshRates.find(r => r.source === 'websocket');
            break;
          case 'latest':
            selectedRate = freshRates.reduce((best, current) => 
              current.timestamp > best.timestamp ? current : best
            );
            break;
          default: // 'best' - choose by confidence
            selectedRate = freshRates.reduce((best, current) => 
              current.confidence > best.confidence ? current : best
            );
        }

        if (selectedRate) {
          this.updateCachedRate(pair, selectedRate.rate, selectedRate.source);
          return selectedRate;
        }
      }

      return null;
    } catch (error) {
      logger.error('Error getting current rate:', error);
      return null;
    }
  }

  /**
   * Get best cached rate for pair
   * @param {string} pair - Asset pair
   * @returns {Object|null} Best cached rate
   */
  getBestCachedRate(pair) {
    const entries = Array.from(this.rateCache.entries())
      .filter(([key]) => key.startsWith(pair))
      .map(([key, value]) => ({ ...value, source: key.split('_')[1] }));

    if (entries.length === 0) return null;

    // Select entry with highest confidence
    return entries.reduce((best, current) => 
      current.confidence > best.confidence ? current : best
    );
  }

  /**
   * Fetch fresh rates from multiple sources
   * @param {string} pair - Asset pair
   * @returns {Promise<Array>} Array of rate data
   */
  async fetchFreshRates(pair) {
    const rates = [];

    try {
      // Fetch from DEX order books
      const pool = this.dexPools.get(pair);
      if (pool) {
        const orderbook = await this.getOrderBook(pool.address);
        const midPrice = this.calculateMidPrice(orderbook);
        
        if (midPrice) {
          rates.push({
            rate: midPrice,
            source: 'dex_orderbook',
            timestamp: new Date(),
            confidence: 0.9
          });
        }
      }

      // Fetch from recent conversion events
      const recentConversions = await ConversionEvent.findAll({
        where: {
          [Op.or]: [
            {
              source_asset_code: pair.split('/')[0],
              destination_asset_code: pair.split('/')[1]
            },
            {
              source_asset_code: pair.split('/')[1],
              destination_asset_code: pair.split('/')[0]
            }
          ]
        },
        order: [['transaction_timestamp', 'DESC']],
        limit: 10
      });

      for (const conversion of recentConversions) {
        const rate = parseFloat(conversion.exchange_rate);
        if (!isNaN(rate)) {
          rates.push({
            rate,
            source: 'historical',
            timestamp: conversion.transaction_timestamp,
            confidence: 0.7
          });
        }
      }

    } catch (error) {
      logger.error('Error fetching fresh rates:', error);
    }

    return rates;
  }

  /**
   * Get rate statistics for a time period
   * @param {string} pair - Asset pair
   * @param {number} hours - Time period in hours
   * @returns {Promise<Object>} Rate statistics
   */
  async getRateStatistics(pair, hours = 24) {
    try {
      const startDate = new Date(Date.now() - (hours * 60 * 60 * 1000));
      
      const conversions = await ConversionEvent.findAll({
        where: {
          [Op.or]: [
            {
              source_asset_code: pair.split('/')[0],
              destination_asset_code: pair.split('/')[1]
            },
            {
              source_asset_code: pair.split('/')[1],
              destination_asset_code: pair.split('/')[0]
            }
          ],
          transaction_timestamp: {
            [Op.gte]: startDate
          }
        },
        attributes: [
          'exchange_rate',
          'exchange_rate_usd',
          'transaction_timestamp',
          'data_quality',
          'gas_fee_xlm'
        ],
        order: [['transaction_timestamp', 'DESC']]
      });

      if (conversions.length === 0) {
        return {
          pair,
          period: hours,
          currentRate: null,
          averageRate: null,
          minRate: null,
          maxRate: null,
          volatility: null,
          dataPoints: 0
        };
      }

      const rates = conversions.map(c => parseFloat(c.exchange_rate)).filter(rate => !isNaN(rate));
      
      const statistics = {
        pair,
        period: hours,
        currentRate: rates[0],
        averageRate: rates.reduce((sum, rate) => sum + rate, 0) / rates.length,
        minRate: Math.min(...rates),
        maxRate: Math.max(...rates),
        volatility: this.calculateVolatility(rates),
        dataPoints: rates.length,
        qualityDistribution: conversions.reduce((dist, conv) => {
          dist[conv.data_quality] = (dist[conv.data_quality] || 0) + 1;
          return dist;
        }, {})
      };

      return statistics;
    } catch (error) {
      logger.error('Error getting rate statistics:', error);
      return {
        pair,
        period: hours,
        error: error.message
      };
    }
  }

  /**
   * Calculate volatility (standard deviation)
   * @param {Array} rates - Array of exchange rates
   * @returns {number} Volatility
   */
  calculateVolatility(rates) {
    if (rates.length < 2) return 0;
    
    const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
    const variance = rates.reduce((sum, rate) => sum + Math.pow(rate - mean, 2), 0) / rates.length;
    return Math.sqrt(variance);
  }

  /**
   * Get service status
   * @returns {Object} Service status
   */
  getStatus() {
    return {
      isTracking: this.isTracking,
      updateInterval: this.updateInterval,
      cacheTimeout: this.cacheTimeout,
      monitoredPairs: Array.from(this.dexPools.keys()),
      cacheSize: this.rateCache.size,
      lastUpdate: this.getLastCacheUpdate(),
      websocketConnections: this.wsConnections ? this.wsConnections.length : 0
    };
  }

  /**
   * Get last cache update time
   * @returns {Date|null} Last update time
   */
  getLastCacheUpdate() {
    let lastUpdate = null;
    
    for (const entry of this.rateCache.values()) {
      if (!lastUpdate || entry.timestamp > lastUpdate) {
        lastUpdate = entry.timestamp;
      }
    }
    
    return lastUpdate;
  }
}

module.exports = RealTimeExchangeRateService;
