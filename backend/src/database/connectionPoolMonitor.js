const logger = require('../utils/logger');
const { buildAdaptiveConfig } = require('./poolConfig');

let metricsService;
try {
  metricsService = require('../services/metricsService');
} catch (_) {
  metricsService = null;
}

/**
 * ConnectionPoolMonitor
 *
 * Samples the live Sequelize (`sequelize-pool`) connection pool on an interval
 * to:
 *   1. Expose pool metrics (active / idle / waiting / utilization) to Prometheus.
 *   2. Drive ADAPTIVE pool sizing — using a sliding window of utilization
 *      samples it grows the recommended pool size under sustained pressure and
 *      shrinks it when the pool is mostly idle, staying within [floor, ceiling].
 *
 * Sequelize's pool cannot be resized in place, so the monitor exposes a
 * `recommendedMax` (consumed at (re)initialization and surfaced via metrics /
 * the admin endpoint) and will invoke an optional `resize` hook for poolers
 * that DO support live resizing. The adaptive algorithm itself is fully
 * unit-testable against any pool-like object.
 */
class ConnectionPoolMonitor {
  constructor(options = {}) {
    this.adaptive = options.adaptiveConfig || buildAdaptiveConfig();
    this.sampleIntervalMs =
      options.sampleIntervalMs ||
      parseInt(process.env.DB_POOL_MONITOR_INTERVAL_MS || '5000', 10);
    // Optional hook: (newMax, newMin) => void, for pgbouncer/pgcat or future
    // resizable pools. Defaults to a logging no-op.
    this.resize = options.resize || null;

    this.pool = null;
    this.window = []; // sliding window of utilization fractions
    this.recommendedMax = null;
    this.timer = null;
    this.isRunning = false;
    this.lastEvaluation = null;
  }

  /**
   * Attach to a Sequelize instance's underlying connection pool.
   */
  attach(sequelize) {
    const pool =
      sequelize && sequelize.connectionManager && sequelize.connectionManager.pool;
    this.attachPool(pool);
    return this;
  }

  /**
   * Attach directly to a pool-like object (used by tests).
   */
  attachPool(pool) {
    this.pool = pool || null;
    if (this.pool) {
      this.recommendedMax = this.readNumber(this.pool, 'maxSize', 'max') || this.adaptive.floor;
    }
    return this;
  }

  readNumber(obj, ...keys) {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return 0;
  }

  /**
   * Read a normalized snapshot of pool state.
   */
  getPoolStats() {
    if (!this.pool) {
      return { attached: false, active: 0, idle: 0, waiting: 0, total: 0, max: 0, min: 0, utilization: 0 };
    }
    const active = this.readNumber(this.pool, 'using', 'borrowed');
    const idle = this.readNumber(this.pool, 'available');
    const waiting = this.readNumber(this.pool, 'waiting', 'pending');
    const total = this.readNumber(this.pool, 'size');
    const max = this.readNumber(this.pool, 'maxSize', 'max');
    const min = this.readNumber(this.pool, 'minSize', 'min');
    const utilization = max > 0 ? active / max : 0;

    return {
      attached: true,
      active,
      idle,
      waiting,
      total,
      max,
      min,
      recommendedMax: this.recommendedMax,
      utilization: Math.round(utilization * 10000) / 10000,
    };
  }

  /**
   * Push a utilization sample (plus waiting pressure) into the sliding window.
   */
  recordSample(stats) {
    // Treat queued waiters as >100% utilization so backpressure forces growth.
    const pressure =
      stats.utilization + (stats.max > 0 ? stats.waiting / stats.max : 0);
    this.window.push(pressure);
    if (this.window.length > this.adaptive.windowSize) {
      this.window.shift();
    }
  }

  /**
   * Evaluate the sliding window and adjust `recommendedMax` within bounds.
   * Returns the (possibly unchanged) recommendation along with the decision.
   */
  evaluate() {
    if (this.window.length < this.adaptive.windowSize) {
      return { changed: false, recommendedMax: this.recommendedMax, reason: 'warming-up' };
    }

    const avg = this.window.reduce((a, b) => a + b, 0) / this.window.length;
    const { highWatermark, lowWatermark, step, floor, ceiling } = this.adaptive;
    const current = this.recommendedMax || floor;
    let next = current;
    let reason = 'steady';

    if (avg >= highWatermark && current < ceiling) {
      next = Math.min(ceiling, current + step);
      reason = 'scale-up';
    } else if (avg <= lowWatermark && current > floor) {
      next = Math.max(floor, current - step);
      reason = 'scale-down';
    }

    const changed = next !== current;
    this.recommendedMax = next;
    this.lastEvaluation = {
      avgPressure: Math.round(avg * 10000) / 10000,
      recommendedMax: next,
      reason,
      at: new Date().toISOString(),
    };

    if (changed) {
      // Reset the window after acting so we observe fresh behaviour at the new size.
      this.window = [];
      this.applyResize(next);
      logger.info(
        `[db-pool] adaptive ${reason}: recommendedMax ${current} -> ${next} (avg pressure ${avg.toFixed(2)})`
      );
    }

    return { changed, recommendedMax: next, reason, avgPressure: avg };
  }

  applyResize(newMax) {
    if (typeof this.resize === 'function') {
      try {
        this.resize(newMax, this.adaptive.floor);
      } catch (err) {
        logger.error('[db-pool] resize hook failed:', err.message);
      }
    }
  }

  /**
   * Update Prometheus gauges with the latest pool snapshot.
   */
  updateMetrics(stats) {
    if (!metricsService) return;
    try {
      if (metricsService.activeDbConnections) metricsService.activeDbConnections.set(stats.active);
      if (metricsService.dbPoolIdleConnections) metricsService.dbPoolIdleConnections.set(stats.idle);
      if (metricsService.dbPoolWaitingRequests) metricsService.dbPoolWaitingRequests.set(stats.waiting);
      if (metricsService.dbPoolUtilization) metricsService.dbPoolUtilization.set(stats.utilization);
      if (metricsService.dbPoolMaxConnections) metricsService.dbPoolMaxConnections.set(stats.max);
    } catch (err) {
      logger.error('[db-pool] failed to update metrics:', err.message);
    }
  }

  /**
   * One monitoring tick: snapshot -> sample -> evaluate -> publish metrics.
   */
  tick() {
    const stats = this.getPoolStats();
    if (!stats.attached) return stats;
    this.recordSample(stats);
    this.evaluate();
    this.updateMetrics(stats);
    return stats;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        logger.error('[db-pool] monitor tick failed:', err.message);
      }
    }, this.sampleIntervalMs);
    if (this.timer.unref) this.timer.unref();
    logger.info(`[db-pool] connection pool monitor started (every ${this.sampleIntervalMs}ms)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }

  /**
   * Snapshot for the admin/status endpoint.
   */
  getStatus() {
    return {
      ...this.getPoolStats(),
      adaptive: {
        ...this.adaptive,
        windowFill: this.window.length,
        lastEvaluation: this.lastEvaluation,
      },
      running: this.isRunning,
    };
  }
}

const singleton = new ConnectionPoolMonitor();
singleton.ConnectionPoolMonitor = ConnectionPoolMonitor;
module.exports = singleton;
