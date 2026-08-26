const logger = require('../utils/logger');
const axios = require('axios');

class PriceService {
  constructor() {
    this.provider = process.env.PRICE_API_PROVIDER || 'coingecko';
    this.coinGeckoApiKey = process.env.COINGECKO_API_KEY;
    this.coinMarketCapApiKey = process.env.COINMARKETCAP_API_KEY;
    
    // Configure base URLs based on API keys
    this.coinGeckoBaseUrl = this.coinGeckoApiKey 
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3';
    
    this.coinMarketCapBaseUrl = 'https://pro-api.coinmarketcap.com/v1';
    
    this.cache = new Map();
    this.cacheTimeout = 60000; // 1 minute cache
  }

  async getTokenPrice(tokenAddress, timestamp = null) {
    const cacheKey = `${tokenAddress}-${timestamp || 'latest'}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.price;
      }
    }

    try {
      let price;
      
      if (this.provider === 'coinmarketcap' && this.coinMarketCapApiKey) {
        price = await this.getCoinMarketCapPrice(tokenAddress, timestamp);
      } else {
        // Default to CoinGecko (free or pro)
        price = await this.getCoinGeckoPrice(tokenAddress, timestamp);
      }

      // Cache the result
      this.cache.set(cacheKey, {
        price,
        timestamp: Date.now()
      });

      return price;
    } catch (error) {
      logger.error(`Error fetching price for token ${tokenAddress}:`, error.message);
      
      // Fallback to alternative provider if primary fails
      if (this.provider === 'coinmarketcap') {
        logger.info('Falling back to CoinGecko...');
        try {
          const price = await this.getCoinGeckoPrice(tokenAddress, timestamp);
          this.cache.set(cacheKey, { price, timestamp: Date.now() });
          return price;
        } catch (fallbackError) {
          logger.error('Fallback also failed:', fallbackError.message);
        }
      }
      
      throw error;
    }
  }

  async getCoinGeckoPrice(tokenAddress, timestamp = null) {
    if (timestamp) {
      const date = new Date(timestamp);
      const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD format
      return await this.getCoinGeckoHistoricalPrice(tokenAddress, dateStr);
    } else {
      return await this.getCoinGeckoLatestPrice(tokenAddress);
    }
  }

  async getCoinMarketCapPrice(tokenAddress, timestamp = null) {
    if (timestamp) {
      return await this.getCoinMarketCapHistoricalPrice(tokenAddress, timestamp);
    } else {
      return await this.getCoinMarketCapLatestPrice(tokenAddress);
    }
  }

  async getCoinGeckoLatestPrice(tokenAddress) {
    // For ERC-20 tokens, we need to find the CoinGecko ID first
    const coinId = await this.getCoinGeckoId(tokenAddress);
    
    const headers = {};
    if (this.coinGeckoApiKey) {
      headers['x-cg-pro-api-key'] = this.coinGeckoApiKey;
    }
    
    const response = await axios.get(`${this.coinGeckoBaseUrl}/simple/price`, {
      params: {
        ids: coinId,
        vs_currencies: 'usd',
        precision: 18
      },
      headers,
      timeout: 10000
    });

    if (!response.data[coinId] || !response.data[coinId].usd) {
      throw new Error(`No USD price found for token ${coinId}`);
    }

    return response.data[coinId].usd;
  }

  async getCoinGeckoHistoricalPrice(tokenAddress, date) {
    // For ERC-20 tokens, we need to find the CoinGecko ID first
    const coinId = await this.getCoinGeckoId(tokenAddress);
    
    const headers = {};
    if (this.coinGeckoApiKey) {
      headers['x-cg-pro-api-key'] = this.coinGeckoApiKey;
    }
    
    const response = await axios.get(`${this.coinGeckoBaseUrl}/coins/${coinId}/history`, {
      params: {
        date,
        localization: false
      },
      headers,
      timeout: 10000
    });

    if (!response.data.market_data || !response.data.market_data.current_price || !response.data.market_data.current_price.usd) {
      throw new Error(`No historical USD price found for token ${coinId} on ${date}`);
    }

    return response.data.market_data.current_price.usd;
  }

  async getCoinGeckoId(tokenAddress) {
    // Check cache first
    const cacheKey = `id-${tokenAddress}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      if (Date.now() - cached.timestamp < this.cacheTimeout * 60) { // 1 hour cache for IDs
        return cached.coinId;
      }
    }

    const headers = {};
    if (this.coinGeckoApiKey) {
      headers['x-cg-pro-api-key'] = this.coinGeckoApiKey;
    }

    try {
      // Search for the token by contract address
      const response = await axios.get(`${this.coinGeckoBaseUrl}/coins/ethereum/contract/${tokenAddress.toLowerCase()}`, {
        headers,
        timeout: 10000
      });

      const coinId = response.data.id;
      
      // Cache the result
      this.cache.set(cacheKey, {
        coinId,
        timestamp: Date.now()
      });

      return coinId;
    } catch (error) {
      // If direct contract lookup fails, try searching by address
      try {
        const searchResponse = await axios.get(`${this.coinGeckoBaseUrl}/search`, {
          params: {
            query: tokenAddress
          },
          headers,
          timeout: 10000
        });

        const result = searchResponse.data.coins.find(coin => 
          coin.platforms && coin.platforms.ethereum === tokenAddress.toLowerCase()
        );

        if (result) {
          // Cache the result
          this.cache.set(cacheKey, {
            coinId: result.id,
            timestamp: Date.now()
          });
          return result.id;
        }
      } catch (searchError) {
        logger.error(`Search failed for token ${tokenAddress}:`, searchError.message);
      }

      throw new Error(`Could not find CoinGecko ID for token address ${tokenAddress}`);
    }
  }

  clearCache() {
    this.cache.clear();
  }

  // CoinMarketCap API methods
  async getCoinMarketCapLatestPrice(tokenAddress) {
    if (!this.coinMarketCapApiKey) {
      throw new Error('CoinMarketCap API key not configured');
    }

    const response = await axios.get(`${this.coinMarketCapBaseUrl}/cryptocurrency/quotes/latest`, {
      params: {
        address: tokenAddress.toLowerCase(),
        convert: 'USD'
      },
      headers: {
        'X-CMC_PRO_API_KEY': this.coinMarketCapApiKey,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const data = response.data.data;
    const tokenData = Object.values(data)[0];
    
    if (!tokenData || !tokenData.quote || !tokenData.quote.USD) {
      throw new Error(`No USD price found for token ${tokenAddress}`);
    }

    return tokenData.quote.USD.price;
  }

  async getCoinMarketCapHistoricalPrice(tokenAddress, timestamp) {
    if (!this.coinMarketCapApiKey) {
      throw new Error('CoinMarketCap API key not configured');
    }

    // CoinMarketCap historical data requires symbol, not address
    // This is a limitation - we'd need to map addresses to symbols
    throw new Error('CoinMarketCap historical price by address not supported. Use CoinGecko for historical data.');
  }
}

module.exports = new PriceService();
