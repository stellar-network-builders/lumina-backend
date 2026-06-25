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
        
        console.log('Redis cache connection initialized with dynamic credentials');
      } catch (error) {
        console.error('Failed to initialize Redis cache with dynamic credentials, falling back to environment variables:', error);
        
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
              console.error('Redis max reconnection attempts reached');
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
        console.error('Redis Client Error:', err);
        this.isConnected = false;
        // Log TLS-specific errors for debugging
        if (err.message.includes('TLS') || err.message.includes('certificate')) {
          console.error("Redis TLS Error - Check certificate configuration and REDIS_TLS setting");
        }
      });

      this.client.on('connect', () => {
        console.log(`Redis client connected (TLS: ${useTls ? 'enabled' : 'disabled'})`);
        this.isConnected = true;
      });

      this.client.on('ready', () => {
        console.log("Redis client ready - Authentication successful");
      });

      this.client.on('disconnect', () => {
        console.log('Redis client disconnected');
        this.isConnected = false;
      });

      await this.client.connect();
      return true;
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
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
      console.error(`Error getting cache key ${key}:`, error);
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
      console.error(`Error setting cache key ${key}:`, error);
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
      console.error(`Error deleting cache key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete multiple keys matching a pattern
   * @param {string} pattern - Key pattern (e.g., "user_vaults_*")
   * @returns {Promise<boolean>} Success status
   */
  /**
   * Delete multiple keys matching a pattern (uses SCAN to prevent blocking)
   * @param {string} pattern - Key pattern
   * @returns {Promise<boolean>} Success status
   */
  async deletePattern(pattern) {
    try {
      if (!this.isConnected || !this.client) {
        return false;
      }

      let cursor = 0;
      const keysToDelete = [];

      do {
        const reply = await this.client.scan(cursor, {
          MATCH: pattern,
          COUNT: 100
        });
        
        cursor = reply.cursor;
        if (reply.keys && reply.keys.length > 0) {
          keysToDelete.push(...reply.keys);
        }
      } while (cursor !== 0);

      if (keysToDelete.length > 0) {
        const chunkSize = 100;
        for (let i = 0; i < keysToDelete.length; i += chunkSize) {
          const chunk = keysToDelete.slice(i, i + chunkSize);
          await this.client.del(chunk);
        }
      }
      return true;
    } catch (error) {
      console.error(`Error deleting cache pattern ${pattern}:`, error);
      try {
        const keys = await this.client.keys(pattern);
        if (keys && keys.length > 0) {
          await this.client.del(keys);
        }
        return true;
      } catch (fallbackError) {
        console.error(`Fallback key deletion failed for pattern ${pattern}:`, fallbackError);
        return false;
      }
    }
  }

  /**
   * Cache-aside implementation with thundering herd protection via atomic distributed lock
   * @param {string} key - Cache key
   * @param {number} ttl - Time to live in seconds
   * @param {Function} fetchFn - Async function to fetch data on miss
   * @returns {Promise<any>} Cached or fetched data
   */
  async getOrSet(key, ttl, fetchFn) {
    const startTime = Date.now();
    const keyPrefix = key.split(':')[0] || 'unknown';

    if (!this.isReady()) {
      this.recordMetric('miss', keyPrefix, 'getOrSet', startTime);
      return await fetchFn();
    }

    try {
      const cached = await this.get(key);
      if (cached !== null) {
        this.recordMetric('hit', keyPrefix, 'getOrSet', startTime);
        return cached;
      }
    } catch (error) {
      console.error(`Error reading from cache for key ${key}:`, error);
    }

    const lockKey = `lock:${key}`;
    const lockTtl = 5;
    let lockAcquired = false;

    try {
      const result = await this.client.set(lockKey, '1', {
        NX: true,
        EX: lockTtl
      });
      lockAcquired = result === 'OK';
    } catch (error) {
      console.error(`Error acquiring lock for key ${key}:`, error);
    }

    if (lockAcquired) {
      this.recordMetric('miss', keyPrefix, 'getOrSet', startTime);
      try {
        const data = await fetchFn();
        if (data !== null && data !== undefined) {
          await this.set(key, data, ttl);
        }
        return data;
      } finally {
        try {
          await this.client.del(lockKey);
        } catch (error) {
          console.error(`Error releasing lock for key ${key}:`, error);
        }
      }
    } else {
      const maxRetries = 10;
      const retryDelay = 100;
      for (let i = 0; i < maxRetries; i++) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        try {
          const cached = await this.get(key);
          if (cached !== null) {
            this.recordMetric('hit', keyPrefix, 'getOrSet_retry', startTime);
            return cached;
          }
        } catch (error) {
          console.error(`Error reading from cache during retry for key ${key}:`, error);
        }
      }

      this.recordMetric('miss_fallback', keyPrefix, 'getOrSet', startTime);
      return await fetchFn();
    }
  }

  /**
   * Batch cache invalidation by key prefix
   * @param {string} pattern - Prefix or glob pattern to invalidate
   * @returns {Promise<boolean>} Success status
   */
  async invalidatePattern(pattern) {
    const startTime = Date.now();
    const keyPrefix = pattern.split(':')[0] || 'unknown';
    const result = await this.deletePattern(pattern);
    this.recordMetric('invalidate', keyPrefix, 'invalidatePattern', startTime);
    return result;
  }

  /**
   * Background cache warming for known high-traffic keys
   * @param {string[]} keys - Cache keys to warm
   * @param {Function} fetchFn - Fetch function taking key and returning value
   * @param {number} ttl - TTL in seconds
   */
  warm(keys, fetchFn, ttl = this.defaultTTL) {
    const startTime = Date.now();
    Promise.resolve().then(async () => {
      for (const key of keys) {
        const keyPrefix = key.split(':')[0] || 'unknown';
        try {
          const data = await fetchFn(key);
          if (data !== null && data !== undefined) {
            await this.set(key, data, ttl);
            this.recordMetric('set', keyPrefix, 'warm', startTime);
          }
        } catch (error) {
          console.error(`Error warming cache for key ${key}:`, error);
        }
      }
    }).catch((error) => {
      console.error('Background warming process failed:', error);
    });
  }

  /**
   * Record prometheus cache metrics
   */
  recordMetric(status, keyPrefix, operation, startTime) {
    try {
      if (!metricsService) {
        try {
          metricsService = require('./metricsService');
        } catch (e) {
          // Ignore
        }
      }
      if (metricsService) {
        const duration = (Date.now() - startTime) / 1000;
        if (metricsService.cacheOperationsTotal) {
          metricsService.cacheOperationsTotal.inc({
            operation,
            key_prefix: keyPrefix,
            status
          });
        }
        if (metricsService.cacheOperationDurationSeconds) {
          metricsService.cacheOperationDurationSeconds.observe({
            operation,
            key_prefix: keyPrefix
          }, duration);
        }
      }
    } catch (err) {
      // Prevent metric recording from throwing and breaking app logic
    }
  }

  /**
   * Wrap an async function with caching (legacy compatibility)
   * @param {string} key - Cache key
   * @param {Function} fn - Async function to wrap
   * @param {number} ttl - TTL in seconds
   * @returns {Promise<any>} Result from cache or function
   */
  async wrapWithCache(key, fn, ttl = this.defaultTTL) {
    return this.getOrSet(key, ttl, fn);
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
        console.log('Redis client disconnected');
      }
    } catch (error) {
      console.error('Error disconnecting from Redis:', error);
    }
  }
}

let metricsService = null;

module.exports = new CacheService();
