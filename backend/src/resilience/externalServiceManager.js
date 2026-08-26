const logger = require('../utils/logger');
const CircuitBreaker = require('./circuitBreaker');
const TracingUtils = require('../tracing/tracingUtils');
const EventEmitter = require('events');

class ExternalServiceManager extends EventEmitter {
  constructor() {
    super();
    this.circuitBreakers = new Map();
    this.fallbackData = new Map();
    this.setupDefaultServices();
  }

  /**
   * Setup default external services with circuit breakers
   */
  setupDefaultServices() {
    // SumSub KYC API
    this.registerService('sumsub', {
      failureThreshold: 5,
      resetTimeout: 60000, // 1 minute
      monitoringPeriod: 10000 // 10 seconds
    });

    // DEX Oracle
    this.registerService('dex_oracle', {
      failureThreshold: 3,
      resetTimeout: 30000, // 30 seconds
      monitoringPeriod: 5000 // 5 seconds
    });

    // Stellar RPC
    this.registerService('stellar_rpc', {
      failureThreshold: 5,
      resetTimeout: 45000, // 45 seconds
      monitoringPeriod: 15000 // 15 seconds
    });

    // Email Service (if external)
    this.registerService('email_service', {
      failureThreshold: 3,
      resetTimeout: 120000, // 2 minutes
      monitoringPeriod: 30000 // 30 seconds
    });
  }

  /**
   * Register a new external service with circuit breaker
   * @param {string} serviceName - Name of the service
   * @param {Object} options - Circuit breaker options
   */
  registerService(serviceName, options = {}) {
    const circuitBreaker = new CircuitBreaker(options);
    
    // Listen to circuit breaker events
    circuitBreaker.on('stateChange', (newState) => {
      this.emit('circuitStateChange', {
        serviceName,
        state: newState,
        timestamp: new Date().toISOString()
      });
      
      logger.info(`🔌 Circuit breaker for ${serviceName} changed to ${newState}`);
    });

    circuitBreaker.on('circuitOpened', (data) => {
      this.emit('circuitOpened', {
        serviceName,
        ...data,
        timestamp: new Date().toISOString()
      });
      
      logger.info(`🚨 Circuit breaker OPENED for ${serviceName} after ${data.failureCount} failures`);
    });

    this.circuitBreakers.set(serviceName, circuitBreaker);
    logger.info(`🔌 Registered circuit breaker for service: ${serviceName}`);
  }

  /**
   * Execute an operation against an external service
   * @param {string} serviceName - Name of the service
   * @param {Function} operation - The operation to execute
   * @param {Object} context - Additional context
   * @param {any} fallbackData - Fallback data to return if circuit is open
   * @returns {Promise} Result of the operation or fallback data
   */
  async executeServiceCall(serviceName, operation, context = {}, fallbackData = null) {
    const circuitBreaker = this.circuitBreakers.get(serviceName);
    
    if (!circuitBreaker) {
      logger.warn(`⚠️ No circuit breaker found for service: ${serviceName}. Executing without protection.`);
      return await operation();
    }

    try {
      return await circuitBreaker.execute(operation, {
        name: context.operationName || 'unknown',
        serviceName,
        ...context
      });
    } catch (error) {
      // If circuit is open, try to return fallback data
      if (error.code === 'CIRCUIT_BREAKER_OPEN') {
        const fallback = fallbackData || this.getFallbackData(serviceName, context);
        
        if (fallback !== null) {
          logger.info(`🔄 Using fallback data for ${serviceName} due to open circuit`);
          this.emit('fallbackUsed', {
            serviceName,
            fallbackData: fallback,
            context
          });
          
          return fallback;
        }
      }
      
      // Re-throw the error if no fallback is available
      throw error;
    }
  }

  /**
   * Set fallback data for a service
   * @param {string} serviceName - Name of the service
   * @param {any} data - Fallback data (can be a function for dynamic data)
   */
  setFallbackData(serviceName, data) {
    this.fallbackData.set(serviceName, data);
  }

  /**
   * Get fallback data for a service
   * @param {string} serviceName - Name of the service
   * @param {Object} context - Context for dynamic fallback data
   * @returns {any} Fallback data or null
   */
  getFallbackData(serviceName, context = {}) {
    const fallback = this.fallbackData.get(serviceName);
    
    if (typeof fallback === 'function') {
      return fallback(context);
    }
    
    return fallback;
  }

  /**
   * Get status of all circuit breakers
   * @returns {Object} Status of all registered services
   */
  getStatus() {
    const status = {};
    
    for (const [serviceName, circuitBreaker] of this.circuitBreakers) {
      status[serviceName] = circuitBreaker.getState();
    }
    
    return status;
  }

  /**
   * Reset a specific circuit breaker
   * @param {string} serviceName - Name of the service
   */
  resetService(serviceName) {
    const circuitBreaker = this.circuitBreakers.get(serviceName);
    if (circuitBreaker) {
      circuitBreaker.reset();
      logger.info(`🔌 Reset circuit breaker for service: ${serviceName}`);
    }
  }

  /**
   * Reset all circuit breakers
   */
  resetAllServices() {
    for (const [serviceName, circuitBreaker] of this.circuitBreakers) {
      circuitBreaker.reset();
    }
    logger.info('🔌 Reset all circuit breakers');
  }

  /**
   * Force open a circuit breaker (for maintenance/testing)
   * @param {string} serviceName - Name of the service
   */
  forceOpenService(serviceName) {
    const circuitBreaker = this.circuitBreakers.get(serviceName);
    if (circuitBreaker) {
      circuitBreaker.forceOpen();
    }
  }

  /**
   * Force close a circuit breaker (for maintenance/testing)
   * @param {string} serviceName - Name of the service
   */
  forceCloseService(serviceName) {
    const circuitBreaker = this.circuitBreakers.get(serviceName);
    if (circuitBreaker) {
      circuitBreaker.forceClose();
    }
  }
}

module.exports = new ExternalServiceManager();
