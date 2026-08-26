const logger = require('../utils/logger');
const CircuitBreaker = require('./circuitBreaker');

/**
 * Per-service tuning. Each downstream dependency degrades differently, so the
 * thresholds and probe behaviour are tuned independently. Unlisted services
 * fall back to GENERIC_DEFAULT.
 */
const SERVICE_DEFAULTS = {
  soroban_rpc: { failureThreshold: 5, resetTimeout: 30000, halfOpenMinSuccesses: 2 },
  stellar_horizon: { failureThreshold: 5, resetTimeout: 30000, halfOpenMinSuccesses: 2 },
  postgres: { failureThreshold: 10, resetTimeout: 15000, halfOpenMinSuccesses: 3 },
  redis: { failureThreshold: 8, resetTimeout: 10000, halfOpenMinSuccesses: 2 },
  external_api: { failureThreshold: 5, resetTimeout: 60000, halfOpenMinSuccesses: 1 }
};

const GENERIC_DEFAULT = { failureThreshold: 5, resetTimeout: 60000, halfOpenMinSuccesses: 1 };

// Services whose circuit opening should trigger a database failover.
const DB_SERVICES = new Set(['postgres', 'database', 'db']);

/**
 * Central registry of circuit breakers keyed by service name. It owns one
 * shared breaker per dependency, publishes Prometheus metrics and Slack alerts
 * on every state change, and triggers a database failover when a DB circuit
 * trips open.
 *
 * Collaborators (metrics / Slack / failover) are resolved lazily so the
 * registry stays cheap to require in tests and free of circular-dependency
 * problems, and so a missing/misbehaving collaborator can never break the
 * breaker itself.
 */
class CircuitBreakerRegistry {
  constructor() {
    this.breakers = new Map();
  }

  /**
   * Get the shared breaker for a service, creating it on first use.
   * @param {string} serviceName
   * @param {Object} [options] - Overrides merged over the per-service defaults
   * @returns {CircuitBreaker}
   */
  getOrCreate(serviceName, options = {}) {
    const existing = this.breakers.get(serviceName);
    if (existing) {
      return existing;
    }

    const defaults = SERVICE_DEFAULTS[serviceName] || GENERIC_DEFAULT;
    const breaker = new CircuitBreaker({
      name: serviceName,
      serviceName,
      ...defaults,
      ...options
    });

    this._wire(serviceName, breaker);
    this.breakers.set(serviceName, breaker);
    this._recordState(serviceName, breaker);
    return breaker;
  }

  /**
   * @param {string} serviceName
   * @returns {CircuitBreaker|undefined}
   */
  get(serviceName) {
    return this.breakers.get(serviceName);
  }

  /**
   * Subscribe to a breaker's lifecycle and fan its events out to the
   * observability + failover collaborators.
   */
  _wire(serviceName, breaker) {
    breaker.on('stateChange', () => {
      this._recordState(serviceName, breaker);
    });

    breaker.on('circuitOpened', (data) => {
      this._incTrips(serviceName);
      this._safe(() =>
        this._slack().sendCircuitBreakerAlert({
          service: serviceName,
          state: 'open',
          failureCount: data.failureCount,
          trips: data.trips
        })
      );
      if (DB_SERVICES.has(serviceName)) {
        this._triggerDbFailover(serviceName);
      }
    });

    breaker.on('circuitClosed', (data) => {
      this._safe(() =>
        this._slack().sendCircuitBreakerAlert({
          service: serviceName,
          state: 'closed',
          recoveryLatencyMs: data.recoveryLatencyMs
        })
      );
    });
  }

  /**
   * Publish the current state of a breaker to Prometheus.
   */
  _recordState(serviceName, breaker) {
    this._safe(() => {
      const metrics = this._metrics();
      const st = breaker.getState();
      const current = st.state.toLowerCase().replace('_', '-'); // HALF_OPEN -> half-open
      for (const state of ['closed', 'open', 'half-open']) {
        metrics.circuitBreakerState.set({ service: serviceName, state }, state === current ? 1 : 0);
      }
      metrics.circuitBreakerFailureCount.set({ service: serviceName }, st.failureCount);
      metrics.circuitBreakerLastStateChange.set(
        { service: serviceName },
        Math.floor(st.lastStateChange / 1000)
      );
    });
  }

  _incTrips(serviceName) {
    this._safe(() => this._metrics().circuitBreakerTripsTotal.inc({ service: serviceName }));
  }

  /**
   * Trip a database failover when the DB circuit opens. Best-effort: failures
   * here must never propagate back into the breaker.
   */
  _triggerDbFailover(serviceName) {
    this._safe(async () => {
      const failover = this._failover();
      if (failover && typeof failover.emergencyReadFromMaster === 'function') {
        logger.warn(`⚡ DB circuit '${serviceName}' opened — triggering emergency failover`);
        await failover.emergencyReadFromMaster();
      }
    });
  }

  /**
   * Snapshot of every registered breaker, for the health endpoint.
   * @returns {Array<Object>}
   */
  getAllStates() {
    return Array.from(this.breakers.entries()).map(([service, breaker]) => ({
      service,
      ...breaker.getState()
    }));
  }

  /**
   * Manually reset a single circuit without a service restart.
   * @param {string} serviceName
   * @returns {boolean} Whether a breaker was found and reset
   */
  reset(serviceName) {
    const breaker = this.breakers.get(serviceName);
    if (!breaker) {
      return false;
    }
    breaker.forceClose();
    return true;
  }

  /**
   * Manually reset every registered circuit.
   */
  resetAll() {
    for (const breaker of this.breakers.values()) {
      breaker.forceClose();
    }
  }

  /** Remove all breakers (primarily for tests). */
  clear() {
    this.breakers.clear();
  }

  // --- Lazily-resolved collaborators -------------------------------------

  _metrics() {
    return require('../services/metricsService');
  }

  _slack() {
    return require('../services/slackWebhookService');
  }

  _failover() {
    return require('../services/databaseFailoverService');
  }

  /**
   * Run a side-effect, swallowing and logging any error so collaborator
   * failures can never destabilise the circuit breaker.
   */
  _safe(fn) {
    try {
      const result = fn();
      if (result && typeof result.catch === 'function') {
        result.catch((err) => logger.error('[circuit-breaker-registry] async side-effect failed:', err.message));
      }
    } catch (err) {
      logger.error('[circuit-breaker-registry] side-effect failed:', err.message);
    }
  }
}

// Export a shared singleton plus the class and defaults for testing.
const registry = new CircuitBreakerRegistry();
registry.CircuitBreakerRegistry = CircuitBreakerRegistry;
registry.SERVICE_DEFAULTS = SERVICE_DEFAULTS;

module.exports = registry;
