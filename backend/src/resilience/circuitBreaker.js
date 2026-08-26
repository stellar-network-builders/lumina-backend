const logger = require('../utils/logger');
const EventEmitter = require('events');
const TracingUtils = require('../tracing/tracingUtils');

/**
 * Circuit breaker with a configurable half-open probe.
 *
 * States: CLOSED -> OPEN -> HALF_OPEN -> (CLOSED | OPEN)
 *
 * Backward compatible with the original implementation: the `failureThreshold`,
 * `resetTimeout` and `monitoringPeriod` options, the `stateChange` /
 * `circuitOpened` events, and the `execute` / `getState` methods are unchanged.
 *
 * New behaviour:
 *  - `halfOpenMinSuccesses` consecutive probe successes are required before the
 *    circuit closes again (defaults to 1, i.e. the original behaviour), so a
 *    still-degraded dependency cannot immediately re-close the circuit.
 *  - `halfOpenMaxProbes` bounds how many probe requests are allowed through at
 *    once while HALF_OPEN; excess requests fast-fail instead of stampeding the
 *    recovering dependency.
 *  - state-transition bookkeeping (`trips`, `lastStateChange`, recovery latency)
 *    is exposed via `getState()` and the richer `circuitClosed` event so the
 *    registry can publish metrics and alerts.
 */
class CircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      failureThreshold: options.failureThreshold || 5, // Failures before opening
      resetTimeout: options.resetTimeout || 60000, // Wait before HALF_OPEN (ms)
      monitoringPeriod: options.monitoringPeriod || 10000, // Failure-count window (ms)
      // Probes that must succeed before the circuit closes from HALF_OPEN.
      halfOpenMinSuccesses: options.halfOpenMinSuccesses || 1,
      // Maximum concurrent probe requests allowed while HALF_OPEN.
      halfOpenMaxProbes: options.halfOpenMaxProbes || 1,
      ...options
    };

    // Human-readable identifier used in logs, metrics and alerts.
    this.name = options.name || options.serviceName || 'circuit';

    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.successCount = 0;
    this.nextAttempt = null;

    // Observability bookkeeping.
    this.trips = 0; // Number of times the circuit has opened.
    this.lastStateChange = Date.now();
    this.openedAt = null; // When the circuit last opened (for recovery latency).
    this.halfOpenProbesInFlight = 0; // Active probes while HALF_OPEN.
  }

  /**
   * Execute an operation through the circuit breaker
   * @param {Function} operation - The operation to execute
   * @param {Object} context - Context for logging and tracing
   * @returns {Promise} Result of the operation
   */
  async execute(operation, context = {}) {
    const operationName = context.name || this.name || 'unknown_operation';

    return TracingUtils.traceBusinessOperation(
      `circuit_breaker_${operationName}`,
      async () => {
        // Check if circuit is open
        if (this.state === 'OPEN') {
          if (Date.now() >= this.nextAttempt) {
            this._transitionTo('HALF_OPEN', context);
            logger.info(`🔌 Circuit breaker transitioning to HALF_OPEN for ${operationName}`);
          } else {
            throw this._openError(operationName, context);
          }
        }

        // While probing, only allow a bounded number of in-flight requests so a
        // recovering dependency is not stampeded by everything that queued up.
        if (this.state === 'HALF_OPEN' && this.halfOpenProbesInFlight >= this.options.halfOpenMaxProbes) {
          throw this._openError(operationName, context);
        }

        const probing = this.state === 'HALF_OPEN';
        if (probing) {
          this.halfOpenProbesInFlight++;
        }

        try {
          const result = await operation();
          this.onSuccess(context);
          return result;
        } catch (error) {
          this.onFailure(context);
          error.circuitBreakerState = this.state;
          error.circuitBreakerFailures = this.failureCount;
          throw error;
        } finally {
          if (probing) {
            this.halfOpenProbesInFlight = Math.max(0, this.halfOpenProbesInFlight - 1);
          }
        }
      },
      {
        'circuit_breaker.state': this.state,
        'circuit_breaker.failures': this.failureCount,
        'service.name': context.serviceName || this.name || 'unknown'
      }
    );
  }

  /**
   * Build the error thrown while the circuit is rejecting requests.
   */
  _openError(operationName, context = {}) {
    const error = new Error(`Circuit breaker is OPEN for ${operationName}`);
    error.code = 'CIRCUIT_BREAKER_OPEN';
    error.serviceName = context.serviceName || this.name;
    error.circuitBreakerState = this.state;
    return error;
  }

  /**
   * Handle successful operation
   * @param {Object} context - Operation context
   */
  onSuccess(context = {}) {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      // Require the configured number of consecutive probe successes before
      // declaring the dependency healthy again.
      if (this.successCount >= this.options.halfOpenMinSuccesses) {
        const recoveryLatencyMs = this.openedAt ? Date.now() - this.openedAt : null;
        // Clear counters first, then transition, so the state change actually
        // fires (resetting state to CLOSED up-front would suppress the event).
        this._clearCounters();
        this._transitionTo('CLOSED', context, { recoveryLatencyMs });
        logger.info(`🔌 Circuit breaker CLOSED for ${context.name || this.name}`);
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
  onFailure(context = {}) {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      // Any probe failure sends us straight back to OPEN.
      this.successCount = 0;
      this.nextAttempt = Date.now() + this.options.resetTimeout;
      this._open(context);
      logger.info(`🔌 Circuit breaker OPEN again for ${context.name || this.name}`);
    } else if (this.state === 'CLOSED' && this.failureCount >= this.options.failureThreshold) {
      this.nextAttempt = Date.now() + this.options.resetTimeout;
      this._open(context);
      logger.info(`🔌 Circuit breaker OPEN for ${context.name || this.name} after ${this.failureCount} failures`);
    }
  }

  /**
   * Open the circuit and emit the relevant events/bookkeeping.
   */
  _open(context = {}) {
    this.openedAt = Date.now();
    this.trips++;
    this._transitionTo('OPEN', context);
    this.emit('circuitOpened', {
      failureCount: this.failureCount,
      serviceName: context.serviceName || this.name,
      operationName: context.name,
      trips: this.trips
    });
  }

  /**
   * Record a state transition and notify listeners.
   */
  _transitionTo(newState, context = {}, extra = {}) {
    const previousState = this.state;
    if (previousState === newState) {
      return;
    }
    this.state = newState;
    this.lastStateChange = Date.now();

    this.emit('stateChange', newState, {
      previousState,
      serviceName: context.serviceName || this.name,
      failureCount: this.failureCount,
      trips: this.trips,
      ...extra
    });

    if (newState === 'CLOSED' && previousState !== 'CLOSED') {
      this.emit('circuitClosed', {
        serviceName: context.serviceName || this.name,
        recoveryLatencyMs: extra.recoveryLatencyMs ?? null
      });
    }
  }

  /**
   * Clear the failure/probe counters without touching the state machine.
   */
  _clearCounters() {
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
    this.openedAt = null;
    this.halfOpenProbesInFlight = 0;
  }

  /**
   * Reset the circuit breaker counters to a CLOSED-ready state.
   */
  reset() {
    this._clearCounters();
    this.state = 'CLOSED';
  }

  /**
   * Get current circuit breaker state
   * @returns {Object} Current state information
   */
  getState() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt,
      trips: this.trips,
      lastStateChange: this.lastStateChange,
      openedAt: this.openedAt,
      isClosed: this.state === 'CLOSED',
      isOpen: this.state === 'OPEN',
      isHalfOpen: this.state === 'HALF_OPEN'
    };
  }

  /**
   * Force open the circuit (useful for maintenance)
   */
  forceOpen() {
    this.openedAt = Date.now();
    this.trips++;
    this.nextAttempt = Date.now() + this.options.resetTimeout;
    this._transitionTo('OPEN', {});
    logger.info(`🔌 Circuit breaker force OPENED for ${this.name}`);
  }

  /**
   * Force close the circuit (useful for maintenance / manual reset without a
   * service restart).
   */
  forceClose() {
    this._clearCounters();
    this._transitionTo('CLOSED', {});
    logger.info(`🔌 Circuit breaker force CLOSED for ${this.name}`);
  }
}

module.exports = CircuitBreaker;
