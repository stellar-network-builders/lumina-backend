const logger = require('../utils/logger');
const crypto = require('crypto');
const cacheService = require('../services/cacheService');

class RequestDeduplicationMiddleware {
  constructor() {
    this.inFlightRequests = new Map(); // Track in-flight requests
    this.defaultTTL = 300; // 5 minutes default
    this.operationTTLs = {
      'tvl_calculation': 180, // 3 minutes for TVL
      'accounting_export': 600, // 10 minutes for exports
      'vault_export': 600, // 10 minutes for vault exports
      'realized_gains': 300, // 5 minutes for gains
      'token_distribution': 180, // 3 minutes for distribution
      'default': 60 // 1 minute default
    };
  }

  /**
   * Generate a unique fingerprint for a request
   * @param {Object} req - Express request object
   * @returns {string} Request fingerprint
   */
  generateRequestFingerprint(req) {
    const { method, originalUrl, query, body } = req;
    
    // Create a normalized representation of the request
    const normalizedData = {
      method,
      path: originalUrl.split('?')[0], // Remove query params from path
      query: this.normalizeQuery(query),
      body: this.normalizeBody(body),
      // Include user context if available
      user: req.user?.address || null
    };

    const fingerprintData = JSON.stringify(normalizedData);
    return crypto.createHash('sha256').update(fingerprintData).digest('hex');
  }

  /**
   * Normalize query parameters for consistent fingerprinting
   * @param {Object} query - Query parameters
   * @returns {Object} Normalized query
   */
  normalizeQuery(query) {
    if (!query) return {};
    
    const normalized = {};
    Object.keys(query).sort().forEach(key => {
      normalized[key] = query[key];
    });
    return normalized;
  }

  /**
   * Normalize request body for consistent fingerprinting
   * @param {Object} body - Request body
   * @returns {Object} Normalized body
   */
  normalizeBody(body) {
    if (!body || typeof body !== 'object') return body;
    
    const normalized = {};
    Object.keys(body).sort().forEach(key => {
      // Skip fields that shouldn't affect deduplication
      if (!['timestamp', 'nonce', 'signature'].includes(key)) {
        normalized[key] = body[key];
      }
    });
    return normalized;
  }

  /**
   * Determine operation type from request
   * @param {Object} req - Express request object
   * @returns {string} Operation type
   */
  getOperationType(req) {
    const path = req.originalUrl;
    
    if (path.includes('/stats/tvl') || path.includes('/tvl')) {
      return 'tvl_calculation';
    } else if (path.includes('/export/xero') || path.includes('/export/quickbooks')) {
      return 'accounting_export';
    } else if (path.includes('/vaults/') && path.includes('/export')) {
      return 'vault_export';
    } else if (path.includes('/realized-gains')) {
      return 'realized_gains';
    } else if (path.includes('/token/') && path.includes('/distribution')) {
      return 'token_distribution';
    }
    
    return 'default';
  }

  /**
   * Get TTL for operation type
   * @param {string} operationType - Operation type
   * @returns {number} TTL in seconds
   */
  getTTL(operationType) {
    return this.operationTTLs[operationType] || this.operationTTLs.default;
  }

  /**
   * Get cache key for request
   * @param {string} fingerprint - Request fingerprint
   * @param {string} operationType - Operation type
   * @returns {string} Cache key
   */
  getCacheKey(fingerprint, operationType) {
    return `dedup:${operationType}:${fingerprint}`;
  }

  /**
   * Check if request is currently being processed
   * @param {string} cacheKey - Cache key
   * @returns {Promise<boolean>} True if request is in flight
   */
  async isInFlight(cacheKey) {
    // Check in-memory map first
    if (this.inFlightRequests.has(cacheKey)) {
      return true;
    }

    // Check Redis for distributed tracking
    try {
      const inFlight = await cacheService.get(cacheKey);
      return inFlight !== null;
    } catch (error) {
      logger.error('Error checking in-flight status:', error);
      return false;
    }
  }

  /**
   * Mark request as in-flight
   * @param {string} cacheKey - Cache key
   * @param {number} ttl - TTL in seconds
   */
  async markInFlight(cacheKey, ttl) {
    // Add to in-memory map
    this.inFlightRequests.set(cacheKey, Date.now());

    // Add to Redis for distributed tracking
    try {
      await cacheService.set(cacheKey, { status: 'in-flight', timestamp: Date.now() }, ttl);
    } catch (error) {
      logger.error('Error marking request as in-flight:', error);
    }

    // Clean up in-memory map after TTL
    setTimeout(() => {
      this.inFlightRequests.delete(cacheKey);
    }, ttl * 1000);
  }

  /**
   * Check if cached result exists
   * @param {string} cacheKey - Cache key
   * @returns {Promise<Object|null>} Cached result or null
   */
  async getCachedResult(cacheKey) {
    try {
      const result = await cacheService.get(cacheKey);
      return result;
    } catch (error) {
      logger.error('Error getting cached result:', error);
      return null;
    }
  }

  /**
   * Cache the result
   * @param {string} cacheKey - Cache key
   * @param {Object} result - Result to cache
   * @param {number} ttl - TTL in seconds
   */
  async cacheResult(cacheKey, result, ttl) {
    try {
      await cacheService.set(cacheKey, {
        status: 'completed',
        result,
        timestamp: Date.now()
      }, ttl);
    } catch (error) {
      logger.error('Error caching result:', error);
    }
  }

  /**
   * Wait for in-flight request to complete
   * @param {string} cacheKey - Cache key
   * @param {number} maxWaitTime - Maximum wait time in milliseconds
   * @returns {Promise<Object>} Result from completed request
   */
  async waitForInFlightRequest(cacheKey, maxWaitTime = 30000) {
    const startTime = Date.now();
    const checkInterval = 500; // Check every 500ms

    while (Date.now() - startTime < maxWaitTime) {
      const cached = await this.getCachedResult(cacheKey);
      
      if (cached && cached.status === 'completed') {
        return cached.result;
      }

      // Check if request is no longer in-flight (failed or timeout)
      const inFlight = await this.isInFlight(cacheKey);
      if (!inFlight) {
        throw new Error('In-flight request failed or timed out');
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    throw new Error('Timeout waiting for in-flight request to complete');
  }

  /**
   * Express middleware for request deduplication
   * @param {Object} options - Middleware options
   * @returns {Function} Express middleware
   */
  middleware(options = {}) {
    const {
      enabled = true,
      skipPaths = [],
      skipMethods = ['POST', 'PUT', 'DELETE', 'PATCH']
    } = options;

    return async (req, res, next) => {
      // Skip if deduplication is disabled
      if (!enabled) {
        return next();
      }

      // Skip certain paths
      if (skipPaths.some(path => req.originalUrl.includes(path))) {
        return next();
      }

      // Skip certain HTTP methods (typically write operations)
      if (skipMethods.includes(req.method)) {
        return next();
      }

      try {
        const fingerprint = this.generateRequestFingerprint(req);
        const operationType = this.getOperationType(req);
        const cacheKey = this.getCacheKey(fingerprint, operationType);
        const ttl = this.getTTL(operationType);

        // Check if we have a cached result
        const cachedResult = await this.getCachedResult(cacheKey);
        if (cachedResult) {
          logger.info(`[DEDUP] Cache hit for ${operationType}: ${cacheKey}`);
          return res.json({
            success: true,
            data: cachedResult,
            cached: true,
            timestamp: new Date().toISOString()
          });
        }

        // Check if request is currently being processed
        const inFlight = await this.isInFlight(cacheKey);
        if (inFlight) {
          logger.info(`[DEDUP] Request in-flight, waiting: ${cacheKey}`);
          
          try {
            const result = await this.waitForInFlightRequest(cacheKey);
            return res.json({
              success: true,
              data: result,
              deduplicated: true,
              timestamp: new Date().toISOString()
            });
          } catch (waitError) {
            logger.error('Error waiting for in-flight request:', waitError);
            // Continue with normal processing if wait fails
          }
        }

        // Mark request as in-flight and proceed with processing
        await this.markInFlight(cacheKey, ttl);
        logger.info(`[DEDUP] Processing new request: ${cacheKey}`);

        // Override res.json to cache the response
        const originalJson = res.json;
        res.json = function(data) {
          // Cache successful responses
          if (data && data.success !== false) {
            cacheService.cacheResult(cacheKey, data, ttl).catch(err => {
              logger.error('Error caching response:', err);
            });
          }
          
          return originalJson.call(this, data);
        };

        next();
      } catch (error) {
        logger.error('Error in request deduplication middleware:', error);
        // Continue with normal processing if deduplication fails
        next();
      }
    };
  }

  /**
   * Clear cached results for a specific operation type
   * @param {string} operationType - Operation type to clear
   */
  async clearOperationCache(operationType) {
    try {
      const pattern = `dedup:${operationType}:*`;
      await cacheService.deletePattern(pattern);
      logger.info(`[DEDUP] Cleared cache for operation: ${operationType}`);
    } catch (error) {
      logger.error(`Error clearing cache for operation ${operationType}:`, error);
    }
  }

  /**
   * Clear all deduplication cache
   */
  async clearAllCache() {
    try {
      await cacheService.deletePattern('dedup:*');
      logger.info('[DEDUP] Cleared all deduplication cache');
    } catch (error) {
      logger.error('Error clearing all deduplication cache:', error);
    }
  }

  /**
   * Get deduplication statistics
   */
  getStats() {
    return {
      inFlightRequests: this.inFlightRequests.size,
      operationTTLs: this.operationTTLs
    };
  }
}

module.exports = new RequestDeduplicationMiddleware();
