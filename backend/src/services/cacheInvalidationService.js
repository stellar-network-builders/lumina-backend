const logger = require('../utils/logger');
const cacheService = require('./cacheService');
const TracingUtils = require('../tracing/tracingUtils');
const EventEmitter = require('events');

class CacheInvalidationService extends EventEmitter {
  constructor() {
    super();
    this.invalidationPatterns = new Map();
    this.setupInvalidationPatterns();
  }

  /**
   * Setup cache invalidation patterns for different entity types
   */
  setupInvalidationPatterns() {
    // Vault-related patterns
    this.invalidationPatterns.set('vault_created', [
      'user_vaults_*',
      'user_portfolio:*',
      'cap_table:*',
      'vault:*'
    ]);

    this.invalidationPatterns.set('vault_updated', [
      'user_vaults_*',
      'user_portfolio:*',
      'cap_table:*',
      'vault:*'
    ]);

    this.invalidationPatterns.set('vault_deleted', [
      'user_vaults_*',
      'user_portfolio:*',
      'cap_table:*',
      'vault:*'
    ]);

    // Beneficiary/Grant-related patterns
    this.invalidationPatterns.set('beneficiary_created', [
      'user_vaults_*',
      'user_portfolio:*',
      'cap_table:*',
      'beneficiary:*'
    ]);

    this.invalidationPatterns.set('beneficiary_updated', [
      'user_vaults_*',
      'user_portfolio:*',
      'cap_table:*',
      'beneficiary:*'
    ]);

    this.invalidationPatterns.set('beneficiary_deleted', [
      'user_vaults_*',
      'user_portfolio:*',
      'cap_table:*',
      'beneficiary:*'
    ]);

    // Claim-related patterns
    this.invalidationPatterns.set('claim_processed', [
      'user_vaults_*',
      'user_portfolio:*',
      'cap_table:*',
      'claim:*'
    ]);

    // Organization-related patterns
    this.invalidationPatterns.set('organization_updated', [
      'org:*',
      'user_vaults_*',
      'cap_table:*'
    ]);
  }

  /**
   * Invalidate cache based on event type
   * @param {string} eventType - Type of event that occurred
   * @param {Object} eventData - Event data containing relevant IDs
   * @returns {Promise<boolean>} Success status
   */
  async invalidateCacheForEvent(eventType, eventData = {}) {
    return TracingUtils.traceBusinessOperation(
      `cache_invalidation_${eventType}`,
      async () => {
        const patterns = this.invalidationPatterns.get(eventType);
        if (!patterns) {
          logger.info(`No cache invalidation patterns found for event: ${eventType}`);
          return true;
        }

        const results = await Promise.allSettled(
          patterns.map(pattern => this.invalidatePattern(pattern, eventData))
        );

        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length > 0) {
          logger.error(`Cache invalidation failures for ${eventType}:`, failures);
          return false;
        }

        // Emit event for real-time updates
        this.emit('cacheInvalidated', { eventType, eventData, patterns });

        return true;
      },
      { 'cache.event_type': eventType }
    );
  }

  /**
   * Invalidate cache keys matching a pattern with optional filtering
   * @param {string} pattern - Cache key pattern
   * @param {Object} eventData - Event data for filtering
   * @returns {Promise<boolean>} Success status
   */
  async invalidatePattern(pattern, eventData = {}) {
    return TracingUtils.traceRedisOperation(
      'invalidate_pattern',
      pattern,
      async () => {
        try {
          if (!cacheService.isReady()) {
            logger.info('Cache service not ready, skipping invalidation');
            return true;
          }

          // Get all keys matching the pattern
          const keys = await cacheService.client.keys(pattern);
          
          // Filter keys based on event data if needed
          const filteredKeys = this.filterKeysByEventData(keys, eventData);

          if (filteredKeys.length > 0) {
            await cacheService.client.del(filteredKeys);
            logger.info(`Invalidated ${filteredKeys.length} cache keys for pattern: ${pattern}`);
          }

          return true;
        } catch (error) {
          logger.error(`Error invalidating cache pattern ${pattern}:`, error);
          throw error;
        }
      }
    );
  }

  /**
   * Filter cache keys based on event data
   * @param {Array} keys - Cache keys
   * @param {Object} eventData - Event data for filtering
   * @returns {Array} Filtered keys
   */
  filterKeysByEventData(keys, eventData) {
    if (!eventData || Object.keys(eventData).length === 0) {
      return keys;
    }

    return keys.filter(key => {
      // Filter by user address if provided
      if (eventData.userAddress && key.includes('user_')) {
        return key.includes(eventData.userAddress);
      }

      // Filter by vault ID if provided
      if (eventData.vaultId && key.includes('vault')) {
        return key.includes(eventData.vaultId);
      }

      // Filter by organization ID if provided
      if (eventData.orgId && key.includes('org')) {
        return key.includes(eventData.orgId);
      }

      // If no specific filters match, include the key
      return true;
    });
  }

  /**
   * Invalidate cache for a specific user
   * @param {string} userAddress - User wallet address
   * @returns {Promise<boolean>} Success status
   */
  async invalidateUserCache(userAddress) {
    return this.invalidateCacheForEvent('user_specific', { userAddress });
  }

  /**
   * Invalidate cache for cap table data
   * @param {string} orgId - Organization ID (optional)
   * @returns {Promise<boolean>} Success status
   */
  async invalidateCapTableCache(orgId = null) {
    const eventData = orgId ? { orgId } : {};
    return this.invalidateCacheForEvent('cap_table_updated', eventData);
  }

  /**
   * Invalidate cache after grant issuance
   * @param {Object} grantData - Grant data including beneficiary address and vault ID
   * @returns {Promise<boolean>} Success status
   */
  async invalidateCacheAfterGrantIssuance(grantData) {
    return this.invalidateCacheForEvent('beneficiary_created', {
      userAddress: grantData.beneficiaryAddress,
      vaultId: grantData.vaultId,
      orgId: grantData.orgId
    });
  }

  /**
   * Invalidate cache after claim processing
   * @param {Object} claimData - Claim data including beneficiary address and vault ID
   * @returns {Promise<boolean>} Success status
   */
  async invalidateCacheAfterClaim(claimData) {
    return this.invalidateCacheForEvent('claim_processed', {
      userAddress: claimData.beneficiaryAddress,
      vaultId: claimData.vaultId
    });
  }

  /**
   * Get cache statistics
   * @returns {Promise<Object>} Cache statistics
   */
  async getCacheStats() {
    try {
      if (!cacheService.isReady()) {
        return { status: 'disconnected' };
      }

      const info = await cacheService.client.info();
      const keyspace = await cacheService.client.keys('*');
      
      return {
        status: 'connected',
        totalKeys: keyspace.length,
        redisInfo: {
          used_memory: info.used_memory_human,
          connected_clients: info.connected_clients,
          uptime_in_seconds: info.uptime_in_seconds
        }
      };
    } catch (error) {
      logger.error('Error getting cache stats:', error);
      return { status: 'error', error: error.message };
    }
  }
}

module.exports = new CacheInvalidationService();
