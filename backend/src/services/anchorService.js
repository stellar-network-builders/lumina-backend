const logger = require('../utils/logger');
const axios = require('axios');
const { StellarTomlResolver } = require('stellar-sdk');

/**
 * AnchorService - SEP-24 Integration for Off-Ramp Quotes
 * 
 * Provides real-time fiat off-ramp quotes from Stellar anchors
 * Calculates "Net Payout" including swap fees and withdrawal fees
 */
class AnchorService {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 60000; // 1 minute cache for quotes
    this.anchorTimeout = 10000; // 10 second timeout for anchor requests
    
    // Default anchors (can be configured via env)
    this.defaultAnchors = this.parseAnchors(process.env.STELLAR_ANCHORS || '');
    
    // Supported fiat currencies
    this.supportedFiats = ['USD', 'EUR', 'GBP', 'CAD'];
  }

  /**
   * Parse anchor configuration from environment
   * Format: "domain1:asset1,domain2:asset2"
   */
  parseAnchors(anchorString) {
    if (!anchorString) {
      return [
        { domain: 'testanchor.stellar.org', asset: 'USDC' },
        { domain: 'apay.io', asset: 'USDC' }
      ];
    }

    return anchorString.split(',').map(entry => {
      const [domain, asset] = entry.split(':');
      return { domain: domain.trim(), asset: asset.trim() };
    });
  }

  /**
   * Get off-ramp quote for token to fiat conversion
   * @param {string} tokenSymbol - Token symbol (e.g., 'USDC', 'XLM')
   * @param {string} tokenAmount - Amount of tokens to convert
   * @param {string} fiatCurrency - Target fiat currency (USD, EUR, etc.)
   * @param {string} anchorDomain - Optional specific anchor domain
   * @returns {Promise<Object>} Quote with net payout and fee breakdown
   */
  async getOffRampQuote(tokenSymbol, tokenAmount, fiatCurrency = 'USD', anchorDomain = null) {
    try {
      // Validate inputs
      this.validateQuoteRequest(tokenSymbol, tokenAmount, fiatCurrency);

      const amount = parseFloat(tokenAmount);
      if (amount <= 0) {
        throw new Error('Amount must be greater than 0');
      }

      // Check cache
      const cacheKey = `${tokenSymbol}-${tokenAmount}-${fiatCurrency}-${anchorDomain || 'default'}`;
      if (this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        if (Date.now() - cached.timestamp < this.cacheTimeout) {
          return cached.quote;
        }
      }

      // Get quotes from anchors
      const anchors = anchorDomain 
        ? [{ domain: anchorDomain, asset: tokenSymbol }]
        : this.defaultAnchors.filter(a => a.asset === tokenSymbol);

      if (anchors.length === 0) {
        throw new Error(`No anchors configured for ${tokenSymbol}`);
      }

      // Fetch quotes from all anchors in parallel
      const quotePromises = anchors.map(anchor => 
        this.fetchAnchorQuote(anchor.domain, tokenSymbol, amount, fiatCurrency)
          .catch(error => {
            logger.error(`Failed to fetch quote from ${anchor.domain}:`, error.message);
            return null;
          })
      );

      const quotes = (await Promise.all(quotePromises)).filter(q => q !== null);

      if (quotes.length === 0) {
        throw new Error('No anchors available for quote');
      }

      // Select best quote (highest net payout)
      const bestQuote = quotes.reduce((best, current) => 
        current.netPayout > best.netPayout ? current : best
      );

      // Cache the result
      this.cache.set(cacheKey, {
        quote: bestQuote,
        timestamp: Date.now()
      });

      return bestQuote;

    } catch (error) {
      logger.error('Error getting off-ramp quote:', error);
      throw error;
    }
  }

  /**
   * Fetch quote from a specific anchor using SEP-24
   * @param {string} anchorDomain - Anchor domain
   * @param {string} assetCode - Asset code
   * @param {number} amount - Amount to convert
   * @param {string} fiatCurrency - Target fiat currency
   * @returns {Promise<Object>} Quote details
   */
  async fetchAnchorQuote(anchorDomain, assetCode, amount, fiatCurrency) {
    try {
      // Step 1: Resolve anchor's stellar.toml
      const toml = await StellarTomlResolver.resolve(anchorDomain);
      
      if (!toml.TRANSFER_SERVER_SEP0024) {
        throw new Error(`Anchor ${anchorDomain} does not support SEP-24`);
      }

      const transferServer = toml.TRANSFER_SERVER_SEP0024;

      // Step 2: Get anchor info
      const infoResponse = await axios.get(`${transferServer}/info`, {
        timeout: this.anchorTimeout
      });

      const assetInfo = infoResponse.data.withdraw?.[assetCode];
      if (!assetInfo || !assetInfo.enabled) {
        throw new Error(`Withdrawal not enabled for ${assetCode} on ${anchorDomain}`);
      }

      // Step 3: Calculate fees
      const fees = this.calculateFees(amount, assetInfo, fiatCurrency);

      // Step 4: Get exchange rate (if needed)
      const exchangeRate = await this.getExchangeRate(
        transferServer,
        assetCode,
        fiatCurrency,
        amount
      );

      // Step 5: Calculate net payout
      const grossAmount = amount * exchangeRate;
      const netPayout = grossAmount - fees.totalFees;

      return {
        anchorDomain,
        assetCode,
        inputAmount: amount.toString(),
        fiatCurrency,
        exchangeRate: exchangeRate.toString(),
        grossAmount: grossAmount.toFixed(2),
        fees: {
          swapFee: fees.swapFee.toFixed(2),
          swapFeePercent: fees.swapFeePercent,
          withdrawalFee: fees.withdrawalFee.toFixed(2),
          withdrawalFeeType: fees.withdrawalFeeType,
          totalFees: fees.totalFees.toFixed(2)
        },
        netPayout: netPayout.toFixed(2),
        estimatedTime: assetInfo.min_amount ? '1-3 business days' : 'Unknown',
        minAmount: assetInfo.min_amount?.toString() || '0',
        maxAmount: assetInfo.max_amount?.toString() || 'Unlimited',
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error(`Error fetching quote from ${anchorDomain}:`, error);
      throw error;
    }
  }

  /**
   * Calculate fees for withdrawal
   * @param {number} amount - Amount to withdraw
   * @param {Object} assetInfo - Asset info from anchor
   * @param {string} fiatCurrency - Target fiat currency
   * @returns {Object} Fee breakdown
   */
  calculateFees(amount, assetInfo, fiatCurrency) {
    // Swap fee (token to stablecoin if needed)
    const swapFeePercent = parseFloat(process.env.SWAP_FEE_PERCENT || '0.3'); // 0.3% default
    const swapFee = amount * (swapFeePercent / 100);

    // Withdrawal fee from anchor
    let withdrawalFee = 0;
    let withdrawalFeeType = 'none';

    if (assetInfo.fee_fixed) {
      withdrawalFee = parseFloat(assetInfo.fee_fixed);
      withdrawalFeeType = 'fixed';
    } else if (assetInfo.fee_percent) {
      withdrawalFee = amount * (parseFloat(assetInfo.fee_percent) / 100);
      withdrawalFeeType = 'percent';
    }

    const totalFees = swapFee + withdrawalFee;

    return {
      swapFee,
      swapFeePercent,
      withdrawalFee,
      withdrawalFeeType,
      totalFees
    };
  }

  /**
   * Get exchange rate from anchor
   * @param {string} transferServer - Transfer server URL
   * @param {string} assetCode - Asset code
   * @param {string} fiatCurrency - Target fiat currency
   * @param {number} amount - Amount to convert
   * @returns {Promise<number>} Exchange rate
   */
  async getExchangeRate(transferServer, assetCode, fiatCurrency, amount) {
    try {
      // Try to get rate from SEP-38 (quotes) if supported
      const rateResponse = await axios.get(`${transferServer}/price`, {
        params: {
          sell_asset: assetCode,
          buy_asset: fiatCurrency,
          sell_amount: amount.toString()
        },
        timeout: this.anchorTimeout
      }).catch(() => null);

      if (rateResponse?.data?.price) {
        return parseFloat(rateResponse.data.price);
      }

      // Fallback: assume 1:1 for stablecoins to USD
      if (assetCode === 'USDC' && fiatCurrency === 'USD') {
        return 1.0;
      }

      // For other cases, use a default rate or throw error
      logger.warn(`No exchange rate available for ${assetCode} to ${fiatCurrency}, using 1:1`);
      return 1.0;

    } catch (error) {
      logger.error('Error getting exchange rate:', error);
      // Fallback to 1:1
      return 1.0;
    }
  }

  /**
   * Get multiple quotes for comparison
   * @param {string} tokenSymbol - Token symbol
   * @param {string} tokenAmount - Amount of tokens
   * @param {string} fiatCurrency - Target fiat currency
   * @returns {Promise<Array>} Array of quotes from different anchors
   */
  async getMultipleQuotes(tokenSymbol, tokenAmount, fiatCurrency = 'USD') {
    try {
      const anchors = this.defaultAnchors.filter(a => a.asset === tokenSymbol);
      
      const quotePromises = anchors.map(anchor =>
        this.getOffRampQuote(tokenSymbol, tokenAmount, fiatCurrency, anchor.domain)
          .catch(error => ({
            error: error.message,
            anchorDomain: anchor.domain
          }))
      );

      const quotes = await Promise.all(quotePromises);

      // Sort by net payout (highest first)
      return quotes
        .filter(q => !q.error)
        .sort((a, b) => parseFloat(b.netPayout) - parseFloat(a.netPayout));

    } catch (error) {
      logger.error('Error getting multiple quotes:', error);
      throw error;
    }
  }

  /**
   * Validate quote request parameters
   */
  validateQuoteRequest(tokenSymbol, tokenAmount, fiatCurrency) {
    if (!tokenSymbol || typeof tokenSymbol !== 'string') {
      throw new Error('Invalid token symbol');
    }

    if (!tokenAmount || isNaN(parseFloat(tokenAmount))) {
      throw new Error('Invalid token amount');
    }

    if (!this.supportedFiats.includes(fiatCurrency)) {
      throw new Error(`Unsupported fiat currency: ${fiatCurrency}. Supported: ${this.supportedFiats.join(', ')}`);
    }
  }

  /**
   * Clear quote cache
   */
  clearCache() {
    this.cache.clear();
  }

  /**
   * Get supported anchors
   */
  getSupportedAnchors() {
    return this.defaultAnchors.map(anchor => ({
      domain: anchor.domain,
      asset: anchor.asset,
      supported: true
    }));
  }
}

module.exports = new AnchorService();
