const EventEmitter = require('events');
const TracingUtils = require('../tracing/tracingUtils');

class CircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      failureThreshold: options.failureThreshold || 5, // Number of failures before opening
      resetTimeout: options.resetTimeout || 60000, // Time to wait before attempting to close (ms)
      monitoringPeriod: options.monitoringPeriod || 10000, // Time window for failure counting (ms)
      ...options
    };

    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.successCount = 0;
    this.nextAttempt = null;
  }

  /**
   * Execute an operation through the circuit breaker
   * @param {Function} operation - The operation to execute
   * @param {Object} context - Context for logging and tracing
   * @returns {Promise} Result of the operation
   */
  async execute(operation, context = {}) {
    const operationName = context.name || 'unknown_operation';
    
    return TracingUtils.traceBusinessOperation(
      `circuit_breaker_${operationName}`,
      async () => {
        // Check if circuit is open
        if (this.state === 'OPEN') {
          if (Date.now() >= this.nextAttempt) {
            this.state = 'HALF_OPEN';
            this.emit('stateChange', 'HALF_OPEN');
            console.log(`🔌 Circuit breaker transitioning to HALF_OPEN for ${operationName}`);
          } else {
            const error = new Error(`Circuit breaker is OPEN for ${operationName}`);
            error.code = 'CIRCUIT_BREAKER_OPEN';
            error.serviceName = context.serviceName;
            throw error;
          }
        }

        try {
          const result = await operation();
          
          // Record success
          this.onSuccess(context);
          
          return result;
        } catch (error) {
          // Record failure
          this.onFailure(context);
          
          // Add circuit breaker context to error
          error.circuitBreakerState = this.state;
          error.circuitBreakerFailures = this.failureCount;
          
          throw error;
        }
      },
      {
        'circuit_breaker.state': this.state,
        'circuit_breaker.failures': this.failureCount,
        'service.name': context.serviceName || 'unknown'
      }
    );
  }

  /**
   * Handle successful operation
   * @param {Object} context - Operation context
   */
  onSuccess(context) {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= 1) { // One success is enough to close the circuit
        this.reset();
        this.emit('stateChange', 'CLOSED');
        // Record circuit breaker recovery as span event
        TracingUtils.recordCircuitBreakerEvent('recovered', {
          state: 'CLOSED',
          failureCount: this.failureCount,
          reason: 'Circuit breaker recovered after successful operation',
        });
        console.log(`🔌 Circuit breaker CLOSED for ${context.name || 'unknown'}`);
      }
    } else {
      // In CLOSED state, reset failure count on success
      this.failureCount = 0;
    }
  }

  /**
   * Handle failed operation
   * @param {Object} context - Operation context
   */
  onFailure(context) {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      // Immediate transition back to OPEN on failure in HALF_OPEN
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.options.resetTimeout;
      this.emit('stateChange', 'OPEN');
      // Record half-open failure as span event
      TracingUtils.recordCircuitBreakerEvent('half_open_failed', {
        state: 'OPEN',
        failureCount: this.failureCount,
        reason: 'Operation failed while circuit was HALF_OPEN',
      });
      console.log(`🔌 Circuit breaker OPEN again for ${context.name || 'unknown'}`);
    } else if (this.failureCount >= this.options.failureThreshold) {
      // Open the circuit if threshold is reached
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.options.resetTimeout;
      this.emit('stateChange', 'OPEN');
      this.emit('circuitOpened', {
        failureCount: this.failureCount,
        serviceName: context.serviceName,
        operationName: context.name
      });
      // Record circuit opened as span event
      TracingUtils.recordCircuitBreakerEvent('opened', {
        state: 'OPEN',
        failureCount: this.failureCount,
        reason: `Failure threshold reached: ${this.failureCount}/${this.options.failureThreshold}`,
      });
      console.log(`🔌 Circuit breaker OPEN for ${context.name || 'unknown'} after ${this.failureCount} failures`);
    }
  }

  /**
   * Reset the circuit breaker to CLOSED state
   */
  reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
  }

  /**
   * Get current circuit breaker state
   * @returns {Object} Current state information
   */
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt,
      isClosed: this.state === 'CLOSED',
      isOpen: this.state === 'OPEN',
      isHalfOpen: this.state === 'HALF_OPEN'
    };
  }

  /**
   * Force open the circuit (useful for maintenance)
   */
  forceOpen() {
    this.state = 'OPEN';
    this.nextAttempt = Date.now() + this.options.resetTimeout;
    this.emit('stateChange', 'OPEN');
    console.log('🔌 Circuit breaker force OPENED');
  }

  /**
   * Force close the circuit (useful for maintenance)
   */
  forceClose() {
    this.reset();
    this.emit('stateChange', 'CLOSED');
    console.log('🔌 Circuit breaker force CLOSED');
  }
}

module.exports = CircuitBreaker;
