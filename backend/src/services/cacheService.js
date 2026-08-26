const logger = require('../utils/logger');
const redis = require('redis');
const secretsService = require('./secretsService');

class CacheService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.defaultTTL = 3600; // 1 hour in seconds
  }

  /**
   * Initialize Redis connection with TLS and authentication
   */
  async connect() {
    try {
      let redisHost, redisPort, redisPassword, useTls;
      
      // Get Redis credentials dynamically from secrets service
      try {
        const redisConfig = await secretsService.getRedisCredentials();
        redisHost = redisConfig.host;
        redisPort = redisConfig.port;
        redisPassword = redisConfig.password;
        useTls = redisConfig.tls;
        
        logger.info('Redis cache connection initialized with dynamic credentials');
      } catch (error) {
        logger.error('Failed to initialize Redis cache with dynamic credentials, falling back to environment variables:', error);
        
        // Fallback to environment variables if secrets service fails
        redisHost = process.env.REDIS_HOST || "localhost";
        redisPort = process.env.REDIS_PORT || 6379;
        redisPassword = process.env.REDIS_PASSWORD;
        useTls = process.env.REDIS_TLS === 'true' || process.env.NODE_ENV === 'production';
      }
      
      // Enforce TLS in production environments
      if (process.env.NODE_ENV === 'production' && !useTls) {
        throw new Error('Redis TLS is required in production. Set REDIS_TLS=true or use rediss:// URL.');
      }
      
      // Enforce password authentication in production
      if (process.env.NODE_ENV === 'production' && !redisPassword) {
        throw new Error('Redis password authentication is required in production. Set REDIS_PASSWORD.');
      }
      
      const redisUrl = process.env.REDIS_URL || 
        (useTls ? `rediss://${redisHost}:${redisPort}` : `redis://${redisHost}:${redisPort}`);
      
      this.client = redis.createClient({
        url: redisUrl,
        password: redisPassword,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              logger.error('Redis max reconnection attempts reached');
              return new Error('Max reconnection attempts reached');
            }
            return Math.min(retries * 100, 3000);
          },
          // TLS configuration for secure connections
          tls: useTls,
          rejectUnauthorized: true, // Enforce certificate verification
          minVersion: 'TLSv1.2', // Require minimum TLS version 1.2
          maxVersion: 'TLSv1.3'  // Allow up to TLS 1.3
        },
        // Connection security settings
        connectTimeout: 10000,
        lazyConnect: true,
        // Authentication timeout
        commandTimeout: 5000,
      });

      this.client.on('error', (err) => {
        logger.error('Redis Client Error:', err);
        this.isConnected = false;
        // Log TLS-specific errors for debugging
        if (err.message.includes('TLS') || err.message.includes('certificate')) {
          logger.error("Redis TLS Error - Check certificate configuration and REDIS_TLS setting");
        }
      });

      this.client.on('connect', () => {
        logger.info(`Redis client connected (TLS: ${useTls ? 'enabled' : 'disabled'})`);
        this.isConnected = true;
      });

      this.client.on('ready', () => {
        logger.info("Redis client ready - Authentication successful");
      });

      this.client.on('disconnect', () => {
        logger.info('Redis client disconnected');
        this.isConnected = false;
      });

      await this.client.connect();
      return true;
    } catch (error) {
      logger.error('Failed to connect to Redis:', error);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Generate cache key for user vaults
   * @param {string} address - User address
   * @returns {string} Cache key
   */
  getUserVaultsKey(address) {
    return `user_vaults_${address}`;
  }

  /**
   * Generate cache key for user portfolio
   * @param {string} address - User address
   * @returns {string} Cache key
   */
  getUserPortfolioKey(address) {
    return `user_portfolio:${address}`;
  }

  /**
   * Get value from cache
   * @param {string} key - Cache key
   * @returns {Promise<any>} Cached value or null
   */
  async get(key) {
    try {
      if (!this.isConnected || !this.client) {
        return null;
      }

      const value = await this.client.get(key);
      if (value) {
        return JSON.parse(value);
      }
      return null;
    } catch (error) {
      logger.error(`Error getting cache key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set value in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttl - Time to live in seconds (optional)
   * @returns {Promise<boolean>} Success status
   */
  async set(key, value, ttl = this.defaultTTL) {
    try {
      if (!this.isConnected || !this.client) {
        return false;
      }

      const serializedValue = JSON.stringify(value);
      await this.client.setEx(key, ttl, serializedValue);
      return true;
    } catch (error) {
      logger.error(`Error setting cache key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete value from cache
   * @param {string} key - Cache key
   * @returns {Promise<boolean>} Success status
   */
  async del(key) {
    try {
      if (!this.isConnected || !this.client) {
        return false;
      }

      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error(`Error deleting cache key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete multiple keys matching a pattern
   * @param {string} pattern - Key pattern (e.g., "user_vaults_*")
   * @returns {Promise<boolean>} Success status
   */
  async deletePattern(pattern) {
    try {
      if (!this.isConnected || !this.client) {
        return false;
      }

      const keys = await this.client.keys(pattern);
      if (keys && keys.length > 0) {
        await this.client.del(keys);
      }
      return true;
    } catch (error) {
      logger.error(`Error deleting cache pattern ${pattern}:`, error);
      return false;
    }
  }

  /**
   * Wrap an async function with caching
   * @param {string} key - Cache key
   * @param {Function} fn - Async function to wrap
   * @param {number} ttl - TTL in seconds
   * @returns {Promise<any>} Result from cache or function
   */
  async wrapWithCache(key, fn, ttl = this.defaultTTL) {
    const cachedValue = await this.get(key);
    if (cachedValue !== null) {
      return cachedValue;
    }

    const result = await fn();
    if (result !== null && result !== undefined) {
      await this.set(key, result, ttl);
    }
    return result;
  }

  /**
   * Invalidate user vaults cache for a specific address
   * @param {string} address - User address
   * @returns {Promise<boolean>} Success status
   */
  async invalidateUserVaults(address) {
    const key = this.getUserVaultsKey(address);
    return await this.del(key);
  }

  /**
   * Invalidate user portfolio cache for a specific address
   * @param {string} address - User address
   * @returns {Promise<boolean>} Success status
   */
  async invalidateUserPortfolio(address) {
    const key = this.getUserPortfolioKey(address);
    return await this.del(key);
  }

  /**
   * Invalidate all user vaults cache
   * @returns {Promise<boolean>} Success status
   */
  async invalidateAllUserVaults() {
    return await this.deletePattern('user_vaults_*');
  }

  /**
   * Check if cache is connected
   * @returns {boolean} Connection status
   */
  isReady() {
    return this.isConnected && this.client !== null;
  }

  /**
   * Disconnect from Redis
   */
  async disconnect() {
    try {
      if (this.client) {
        await this.client.quit();
        this.isConnected = false;
        logger.info('Redis client disconnected');
      }
    } catch (error) {
      logger.error('Error disconnecting from Redis:', error);
    }
  }
}

module.exports = new CacheService();
