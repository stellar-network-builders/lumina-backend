const axios = require('axios');
const Sentry = require('@sentry/node');
const CircuitBreaker = require('../resilience/circuitBreaker');
const auditLogger = require('./auditLogger');
const TracingUtils = require('../tracing/tracingUtils');

/**
 * SorobanRpcClient - Multi-endpoint RPC client with health checking,
 * automatic failover, exponential backoff retry, and circuit breaker integration.
 *
 * Accepts an array of endpoint URLs with priority ordering.
 * Supports Stellar Soroban JSON-RPC methods.
 */
class SorobanRpcClient {
  /**
   * @param {string|string[]} rpcUrls - Single RPC URL or array of URLs with priority
   * @param {Object} options - Configuration options
   * @param {number} options.timeout - Default request timeout in ms (default: 10000)
   * @param {number} options.maxRetries - Max retry attempts (default: 3)
   * @param {number} options.retryDelay - Initial retry delay in ms (default: 1000)
   * @param {number} options.maxRetryDelay - Maximum backoff delay in ms (default: 30000)
   * @param {number} options.healthCheckInterval - Interval between health checks in ms (default: 30000)
   * @param {number} options.degradedThreshold - Latency threshold to mark endpoint degraded (default: 5000)
   * @param {number} options.circuitBreakerThreshold - Failures before circuit opens (default: 5)
   * @param {number} options.circuitBreakerWindowMs - Time window for circuit breaker failures (default: 60000)
   * @param {number} options.circuitBreakerResetMs - Time before half-open attempt (default: 30000)
   */
  constructor(rpcUrls, options = {}) {
    // Normalize to endpoint array with priorities
    if (typeof rpcUrls === 'string') {
      this.endpoints = [{ url: rpcUrls, priority: 0 }];
    } else if (Array.isArray(rpcUrls)) {
      this.endpoints = rpcUrls.map((url, index) => {
        if (typeof url === 'string') {
          return { url, priority: index };
        }
        return { url: url.url, priority: url.priority ?? index };
      });
    } else {
      throw new Error('rpcUrls must be a string or array of endpoint URLs');
    }

    if (this.endpoints.length === 0) {
      throw new Error('At least one RPC endpoint URL is required');
    }

    this.timeout = options.timeout ?? 10000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelay = options.retryDelay ?? 1000;
    this.maxRetryDelay = options.maxRetryDelay ?? 30000;
    this.healthCheckInterval = options.healthCheckInterval ?? 30000;
    this.degradedThreshold = options.degradedThreshold ?? 5000;

    // Endpoint health state tracking
    this.endpointHealth = new Map();
    for (const ep of this.endpoints) {
      this.endpointHealth.set(ep.url, {
        healthy: true,
        degraded: false,
        lastCheck: null,
        lastLatency: null,
        failCount: 0,
        lastFailure: null,
        consecutiveFailures: 0,
      });
    }

    // Circuit breaker per endpoint
    this.circuitBreakers = new Map();
    for (const ep of this.endpoints) {
      this.circuitBreakers.set(ep.url, new CircuitBreaker({
        failureThreshold: options.circuitBreakerThreshold || 5,
        resetTimeout: options.circuitBreakerResetMs || 30000,
        monitoringPeriod: options.circuitBreakerWindowMs || 60000,
      }));
    }

    // Active endpoint tracking
    this.activeEndpoint = this.endpoints[0].url;
    this.failoverCount = 0;
    this.healthCheckTimer = null;
    this.metrics = {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      retriedCalls: 0,
      failoverEvents: 0,
      healthChecks: 0,
      degradedEndpoints: 0,
    };

    // Start periodic health checks (skip if interval is 0)
    if (this.healthCheckInterval > 0) {
      this._startHealthChecks();
    }
  }

  /**
   * Start periodic health checks on all endpoints
   * @private
   */
  _startHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    // Run initial health check immediately
    this._runHealthChecks().catch(err => {
      console.warn('Initial health check failed:', err.message);
    });

    // Schedule periodic health checks
    this.healthCheckTimer = setInterval(() => {
      this._runHealthChecks().catch(err => {
        console.warn('Periodic health check failed:', err.message);
      });
    }, this.healthCheckInterval);

    // Allow process to exit
    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }
  }

  /**
   * Run health checks against all endpoints
   * @private
   */
  async _runHealthChecks() {
    const results = await Promise.allSettled(
      this.endpoints.map(ep => this._healthCheckEndpoint(ep.url))
    );

    this.metrics.healthChecks++;

    for (let i = 0; i < this.endpoints.length; i++) {
      const ep = this.endpoints[i];
      const result = results[i];
      const prevState = this.endpointHealth.get(ep.url);

      if (result.status === 'fulfilled' && result.value.healthy) {
        // Endpoint is healthy
        if (!prevState.healthy) {
          this._logHealthTransition(ep.url, 'degraded', 'healthy',
            `Health check passed (${result.value.latency}ms)`);
        }
        this.endpointHealth.set(ep.url, {
          ...prevState,
          healthy: true,
          degraded: false,
          lastCheck: Date.now(),
          lastLatency: result.value.latency,
          consecutiveFailures: 0,
        });
      } else {
        // Endpoint is unhealthy or degraded
        const latency = result.status === 'fulfilled' ? result.value.latency : null;
        const isDegraded = latency !== null && latency > this.degradedThreshold;

        if (prevState.healthy && !isDegraded) {
          // Still considered healthy but had an issue
          const newState = { ...prevState, lastCheck: Date.now(), consecutiveFailures: prevState.consecutiveFailures + 1 };
          this.endpointHealth.set(ep.url, newState);
        } else if (prevState.healthy && isDegraded) {
          this._logHealthTransition(ep.url, 'healthy', 'degraded',
            `High latency: ${latency}ms > ${this.degradedThreshold}ms threshold`);
          this.endpointHealth.set(ep.url, {
            ...prevState,
            healthy: false,
            degraded: true,
            lastCheck: Date.now(),
            lastLatency: latency,
            consecutiveFailures: prevState.consecutiveFailures + 1,
          });
          this.metrics.degradedEndpoints++;
        } else {
          // Already unhealthy, update
          this.endpointHealth.set(ep.url, {
            ...prevState,
            healthy: false,
            degraded: isDegraded,
            lastCheck: Date.now(),
            lastLatency: latency,
            consecutiveFailures: prevState.consecutiveFailures + 1,
            lastFailure: Date.now(),
          });
        }
      }
    }

    // Re-select healthy endpoint after health check
    this._autoSelectEndpoint();
  }

  /**
   * Health check a single endpoint
   * @param {string} endpointUrl - RPC endpoint URL
   * @returns {Promise<{healthy: boolean, latency: number}>}
   */
  async healthCheck(endpointUrl) {
    if (!endpointUrl) {
      // Check current active endpoint
      return this._healthCheckEndpoint(this.activeEndpoint);
    }
    return this._healthCheckEndpoint(endpointUrl);
  }

  /**
   * Internal health check for an endpoint
   * @param {string} endpointUrl - RPC endpoint URL
   * @returns {Promise<{healthy: boolean, latency: number}>}
   * @private
   */
  async _healthCheckEndpoint(endpointUrl) {
    const startTime = Date.now();
    try {
      const response = await axios.post(endpointUrl, {
        jsonrpc: '2.0',
        id: `health_${Date.now()}`,
        method: 'getLatestLedger',
        params: {},
      }, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' },
      });

      const latency = Date.now() - startTime;

      if (response.data && response.data.result) {
        return {
          healthy: true,
          latency,
          ledger: response.data.result.sequence,
        };
      }

      return {
        healthy: false,
        latency,
        error: response.data?.error?.message || 'Invalid response',
      };
    } catch (error) {
      const latency = Date.now() - startTime;
      return {
        healthy: false,
        latency,
        error: error.message,
      };
    }
  }

  /**
   * Select the highest-priority healthy endpoint.
   * Falls back to degraded endpoints only if all are unhealthy.
   * @returns {string} Selected endpoint URL
   */
  selectHealthyEndpoint() {
    // Sort endpoints by priority (lowest first = highest priority)
    const sorted = [...this.endpoints].sort((a, b) => a.priority - b.priority);

    // Try healthy endpoints first
    for (const ep of sorted) {
      const health = this.endpointHealth.get(ep.url);
      if (health && health.healthy && !health.degraded) {
        return ep.url;
      }
    }

    // Try degraded (but not completely dead) endpoints
    for (const ep of sorted) {
      const health = this.endpointHealth.get(ep.url);
      if (health && health.degraded) {
        return ep.url;
      }
    }

    // All endpoints are unhealthy - return highest priority anyway
    return sorted[0].url;
  }

  /**
   * Auto-select endpoint and handle failover transition
   * @private
   */
  _autoSelectEndpoint() {
    const newEndpoint = this.selectHealthyEndpoint();
    if (newEndpoint !== this.activeEndpoint) {
      const previousEndpoint = this.activeEndpoint;
      this.activeEndpoint = newEndpoint;
      this.failoverCount++;
      this.metrics.failoverEvents++;

      // Increment prometheus failover counter if available
      try {
        const metricsService = require('./metricsService');
        if (metricsService.rpcFailoverCount) {
          metricsService.rpcFailoverCount.inc({
            from_endpoint: previousEndpoint,
            to_endpoint: newEndpoint,
          });
        }
      } catch (err) {
        // metricsService may not be initialized yet
      }

      this._logHealthTransition(previousEndpoint, 'active', 'inactive',
        `Failover to ${newEndpoint}`);
    }
  }

  /**
   * Log health transition via audit logger
   * @param {string} endpoint - Endpoint URL
   * @param {string} fromState - Previous state
   * @param {string} toState - New state
   * @param {string} reason - Reason for transition
   * @private
   */
  _logHealthTransition(endpoint, fromState, toState, reason) {
    const message = `[RPC Health] ${endpoint}: ${fromState} → ${toState} (${reason})`;
    console.log(message);

    // Log to audit logger
    try {
      auditLogger.logAction('system', `rpc_health_transition`, JSON.stringify({
        endpoint,
        fromState,
        toState,
        reason,
        timestamp: new Date().toISOString(),
      }));
    } catch (err) {
      console.warn('Failed to log health transition to audit logger:', err.message);
    }

    // Send to Sentry for monitoring
    if (toState === 'degraded' || toState === 'inactive') {
      Sentry.captureMessage(message, {
        level: 'warning',
        tags: { service: 'soroban-rpc-client', event: 'health_transition' },
        extra: { endpoint, fromState, toState, reason },
      });
    }
  }

  /**
   * Make RPC call to Soroban network with failover support
   * @param {string} method - RPC method name
   * @param {Object} params - RPC parameters
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} RPC response
   */
  async call(method, params = {}, options = {}) {
    const requestId = Date.now();
    const requestBody = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params,
    };

    const endpoint = options.endpoint || this.activeEndpoint;
    const requestOptions = {
      timeout: options.timeout || this.timeout,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    };

    this.metrics.totalCalls++;

    // Wrap the RPC call with OpenTelemetry tracing
    return TracingUtils.traceSorobanRPCCall(method, params, endpoint, async () => {
      try {
        const response = await axios.post(endpoint, requestBody, requestOptions);

        if (response.data.error) {
          throw new Error(`RPC Error: ${response.data.error.message} (Code: ${response.data.error.code})`);
        }

        this.metrics.successfulCalls++;

        // Record success in circuit breaker
        const cb = this.circuitBreakers.get(endpoint);
        if (cb) {
          cb.onSuccess({ name: method, serviceName: 'soroban-rpc', endpoint });
        }

        return response.data.result;
      } catch (error) {
        this.metrics.failedCalls++;

        // Record failure in circuit breaker
        const cb = this.circuitBreakers.get(endpoint);
        if (cb) {
          cb.onFailure({ name: method, serviceName: 'soroban-rpc', endpoint });
        }

        if (error.response) {
          throw new Error(`HTTP ${error.response.status}: ${error.response.statusText} - ${error.response.data?.message || error.message}`);
        } else if (error.request) {
          throw new Error('Network error: Unable to reach Soroban RPC server');
        } else {
          throw error;
        }
      }
    });
  }

  /**
   * Make RPC call with enhanced exponential backoff retry and failover
   * Backoff sequence: 1s, 2s, 4s, 8s, 16s, cap at 30s
   * Retries on: 429, 503, network errors, timeouts
   *
   * @param {string} method - RPC method name
   * @param {Object} params - RPC parameters
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} RPC response
   */
  async callWithRetry(method, params = {}, options = {}) {
    let lastError = new Error('All RPC endpoints have open circuit breakers');
    const maxRetries = options.maxRetries != null ? options.maxRetries : this.maxRetries;
    const retryDelayMs = options.retryDelay || this.retryDelay;

    // Try each endpoint in priority order, with exponential backoff per endpoint
    const endpoints = this._getEndpointsInPriorityOrder();

    for (const endpoint of endpoints) {
      // Check circuit breaker before attempting this endpoint
      const cb = this.circuitBreakers.get(endpoint);
      if (cb) {
        const state = cb.getState();
        if (state.isOpen) {
          console.warn(`Circuit breaker is OPEN for ${endpoint}, skipping to next endpoint`);
          continue;
        }
      }

      // Retry on this endpoint with exponential backoff
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await this.call(method, params, {
            ...options,
            endpoint,
          });

          this.metrics.retriedCalls += attempt;

          // Increment prometheus retry counter if available
          if (attempt > 0) {
            try {
              const metricsService = require('./metricsService');
              if (metricsService.rpcRetryCount) {
                metricsService.rpcRetryCount.inc({
                  endpoint,
                  method,
                }, attempt);
              }
            } catch (err) {
              // metricsService may not be initialized yet
            }
          }

          return result;
        } catch (error) {
          lastError = error;

          // Don't retry on non-retryable errors - throw immediately
          if (this._isNonRetryableError(error)) {
            throw error;
          }

          if (attempt < maxRetries) {
            // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at maxRetryDelay (30s)
            let delay = retryDelayMs * Math.pow(2, attempt);
            if (delay > this.maxRetryDelay) {
              delay = this.maxRetryDelay;
            }

            console.warn(`RPC call to ${endpoint} failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, error.message);
            await this._delay(delay);
          }
        }
      }
      // All retries exhausted on this endpoint, try the next one
      console.warn(`All retries exhausted for ${endpoint}, trying next endpoint`);
    }

    // All endpoints exhausted
    // Log final failure to Sentry
    Sentry.captureException(lastError, {
      tags: { service: 'soroban-rpc-client', method },
      extra: { params, attempts: maxRetries + 1, endpoints },
    });

    throw lastError;
  }

  /**
   * Get endpoints in priority order
   * @returns {string[]} Array of endpoint URLs
   * @private
   */
  _getEndpointsInPriorityOrder() {
    const sorted = [...this.endpoints].sort((a, b) => a.priority - b.priority);
    return sorted.map(ep => ep.url);
  }

  /**
   * Check if error is non-retryable (public API for backward compatibility)
   * @param {Error} error - Error to check
   * @returns {boolean} Whether error is non-retryable
   */
  isNonRetryableError(error) {
    return this._isNonRetryableError(error);
  }

  /**
   * Check if error is non-retryable
   * @param {Error} error - Error to check
   * @returns {boolean}
   * @private
   */
  _isNonRetryableError(error) {
    const message = error.message.toLowerCase();

    const nonRetryablePatterns = [
      'invalid parameter',
      'not found',
      'invalid hash',
      'invalid ledger',
      'validation error',
    ];

    return nonRetryablePatterns.some(pattern => message.includes(pattern));
  }

  /**
   * Get current active endpoint URL
   * @param {Function} operation - Async operation to execute
   * @param {Object} context - Operation context
   * @returns {Promise<any>} Operation result
   */
  async executeWithCircuitBreaker(operation, context = {}) {
    const endpoint = context.endpoint || this.activeEndpoint;
    const cb = this.circuitBreakers.get(endpoint);

    if (!cb) {
      return operation();
    }

    return cb.execute(operation, {
      name: context.name || 'rpc_operation',
      serviceName: 'soroban-rpc',
      ...context,
    });
  }

  /**
   * Get latest ledger information
   * @returns {Promise<Object>} Latest ledger info
   */
  async getLatestLedger() {
    return this.callWithRetry('getLatestLedger');
  }

  /**
   * Get events for a specific ledger range
   * @param {number} startLedger - Start ledger sequence (inclusive)
   * @param {number} endLedger - End ledger sequence (inclusive)
   * @param {Object} filters - Event filters
   * @returns {Promise<Array>} Array of events
   */
  async getEvents(startLedger, endLedger, filters = {}) {
    const params = {
      startLedger,
      endLedger,
      ...filters,
    };

    return this.callWithRetry('getEvents', params);
  }

  /**
   * Get transaction information
   * @param {string} transactionHash - Transaction hash
   * @returns {Promise<Object>} Transaction info
   */
  async getTransaction(transactionHash) {
    return this.callWithRetry('getTransaction', { hash: transactionHash });
  }

  /**
   * Get ledger entry
   * @param {Object} key - Ledger entry key
   * @returns {Promise<Object>} Ledger entry data
   */
  async getLedgerEntry(key) {
    return this.callWithRetry('getLedgerEntry', key);
  }

  /**
   * Get network information
   * @returns {Promise<Object>} Network info
   */
  async getNetwork() {
    return this.callWithRetry('getNetwork');
  }

  /**
   * Simulate transaction
   * @param {Object} transaction - Transaction to simulate
   * @returns {Promise<Object>} Simulation result
   */
  async simulateTransaction(transaction) {
    return this.callWithRetry('simulateTransaction', transaction);
  }

  /**
   * Get health status of all endpoints
   * @returns {Object} Health status for all endpoints
   */
  getHealthStatus() {
    const endpoints = {};
    for (const ep of this.endpoints) {
      const health = this.endpointHealth.get(ep.url);
      const cb = this.circuitBreakers.get(ep.url);
      const cbState = cb ? cb.getState() : null;

      endpoints[ep.url] = {
        priority: ep.priority,
        healthy: health?.healthy || false,
        degraded: health?.degraded || false,
        lastCheck: health?.lastCheck || null,
        lastLatency: health?.lastLatency || null,
        consecutiveFailures: health?.consecutiveFailures || 0,
        circuitBreaker: cbState ? cbState.state : 'N/A',
      };
    }

    return {
      activeEndpoint: this.activeEndpoint,
      failoverCount: this.failoverCount,
      endpoints,
    };
  }

  /**
   * Get RPC metrics for monitoring
   * @returns {Object} Metrics data
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeEndpoint: this.activeEndpoint,
      failoverCount: this.failoverCount,
      endpointHealth: this.getHealthStatus(),
      timestamp: Date.now(),
    };
  }

  /**
   * Push current metrics to Prometheus registry.
   * Call this periodically (e.g., every 15s) from monitoring setup.
   * @param {Object} promMetrics - The prometheus metrics object from metricsService
   */
  pushMetricsToPrometheus(promMetrics) {
    if (!promMetrics) return;

    try {
      // Update endpoint health gauges
      if (promMetrics.rpcEndpointHealth) {
        for (const [url, health] of this.endpointHealth) {
          promMetrics.rpcEndpointHealth.set(
            { endpoint: url, state: health.healthy ? 'healthy' : (health.degraded ? 'degraded' : 'unhealthy') },
            health.healthy ? 1 : 0
          );
        }
      }

      // Update health check latency histogram
      if (promMetrics.rpcHealthCheckLatency) {
        for (const [url, health] of this.endpointHealth) {
          if (health.lastLatency !== null) {
            promMetrics.rpcHealthCheckLatency.observe({ endpoint: url }, health.lastLatency);
          }
        }
      }

      // Update failover count
      if (promMetrics.rpcFailoverCount) {
        // Counter is cumulative - this method shouldn't reset it
        // The counter should be incremented at failover time, not set here
      }

      // Update retry count
      if (promMetrics.rpcRetryCount) {
        // Counter is cumulative - same as above
      }
    } catch (err) {
      console.warn('Failed to push RPC metrics to Prometheus:', err.message);
    }
  }

  /**
   * Get current active endpoint URL
   * @returns {string} Active endpoint URL
   */
  getActiveEndpoint() {
    return this.activeEndpoint;
  }

  /**
   * Force a specific endpoint to be active
   * @param {string} endpointUrl - Endpoint URL to force
   */
  forceEndpoint(endpointUrl) {
    const exists = this.endpoints.some(ep => ep.url === endpointUrl);
    if (!exists) {
      throw new Error(`Endpoint ${endpointUrl} is not in the configured endpoint list`);
    }
    const previous = this.activeEndpoint;
    this.activeEndpoint = endpointUrl;
    this._logHealthTransition(previous, 'active', 'forced_switch',
      `Manually switched to ${endpointUrl}`);
  }

  /**
   * Stop health checks (for graceful shutdown)
   */
  stopHealthChecks() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Add a new endpoint dynamically
   * @param {string} url - Endpoint URL
   * @param {number} priority - Priority (lower = higher priority)
   */
  addEndpoint(url, priority) {
    const exists = this.endpoints.some(ep => ep.url === url);
    if (exists) {
      console.warn(`Endpoint ${url} already exists in configuration`);
      return;
    }

    this.endpoints.push({ url, priority: priority ?? this.endpoints.length });
    this.endpointHealth.set(url, {
      healthy: true,
      degraded: false,
      lastCheck: null,
      lastLatency: null,
      failCount: 0,
      lastFailure: null,
      consecutiveFailures: 0,
    });
    this.circuitBreakers.set(url, new CircuitBreaker({
      failureThreshold: 5,
      resetTimeout: 30000,
      monitoringPeriod: 60000,
    }));

    // Run immediate health check on new endpoint
    this._healthCheckEndpoint(url).then(result => {
      if (!result.healthy) {
        this._logHealthTransition(url, 'unknown', 'degraded',
          `Initial health check failed: ${result.error}`);
        const health = this.endpointHealth.get(url);
        this.endpointHealth.set(url, {
          ...health,
          healthy: false,
          lastCheck: Date.now(),
          lastLatency: result.latency,
        });
      }
    });
  }

  /**
   * Remove an endpoint
   * @param {string} url - Endpoint URL to remove
   */
  removeEndpoint(url) {
    const index = this.endpoints.findIndex(ep => ep.url === url);
    if (index === -1) {
      throw new Error(`Endpoint ${url} not found`);
    }

    this.endpoints.splice(index, 1);
    this.endpointHealth.delete(url);

    const cb = this.circuitBreakers.get(url);
    if (cb) {
      cb.reset();
      this.circuitBreakers.delete(url);
    }

    // If removed endpoint was active, select new one
    if (this.activeEndpoint === url) {
      this._autoSelectEndpoint();
    }

    console.log(`Removed RPC endpoint: ${url}`);
  }

  /**
   * Delay helper
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   * @private
   */
  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = SorobanRpcClient;
