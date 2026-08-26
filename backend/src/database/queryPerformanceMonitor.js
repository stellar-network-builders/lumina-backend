const logger = require('../utils/logger');
const auditLogger = require('../services/auditLogger');

let metricsService;
try {
  metricsService = require('../services/metricsService');
} catch (_) {
  metricsService = null;
}

/**
 * QueryPerformanceMonitor
 *
 * Instruments Sequelize query execution to record per-operation latency,
 * surface slow queries, and feed database metrics. It plugs into Sequelize via
 * the `benchmark: true` option, which invokes the `logging` callback with the
 * executed SQL and the elapsed time in milliseconds.
 *
 * Slow queries (default threshold 500ms) are routed to a dedicated
 * `slow_queries` audit channel for capacity planning and root-cause analysis.
 */
class QueryPerformanceMonitor {
  constructor(options = {}) {
    this.slowQueryThresholdMs =
      options.slowQueryThresholdMs ||
      parseInt(process.env.DB_SLOW_QUERY_MS || '500', 10);
    // Ring buffer of the most recent slow queries.
    this.slowQueryBufferSize = options.slowQueryBufferSize || 100;
    this.reset();
  }

  reset() {
    this.totalQueries = 0;
    this.totalDurationMs = 0;
    this.slowQueryCount = 0;
    this.maxDurationMs = 0;
    // operation -> { count, totalMs, maxMs, slow }
    this.operations = new Map();
    this.recentSlowQueries = [];
  }

  /**
   * Best-effort derivation of a coarse operation tag from raw SQL, e.g.
   * `select:vaults`, `insert:claims`. Callers may pass an explicit operation
   * name to override this.
   * @param {string} sql
   * @returns {string}
   */
  deriveOperation(sql) {
    if (!sql || typeof sql !== 'string') return 'unknown';
    const trimmed = sql.replace(/^Executing\s*\(.*?\):\s*/i, '').trim();
    const verbMatch = trimmed.match(/^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP)/i);
    const verb = verbMatch ? verbMatch[1].toLowerCase() : 'other';

    let table = '';
    const fromMatch = trimmed.match(/\bFROM\s+["'`]?([a-zA-Z0-9_."]+)["'`]?/i);
    const intoMatch = trimmed.match(/\bINTO\s+["'`]?([a-zA-Z0-9_."]+)["'`]?/i);
    const updateMatch = trimmed.match(/^UPDATE\s+["'`]?([a-zA-Z0-9_."]+)["'`]?/i);
    const m = intoMatch || updateMatch || fromMatch;
    if (m) {
      table = m[1].replace(/["'`]/g, '').split('.').pop();
    }
    return table ? `${verb}:${table}` : verb;
  }

  /**
   * Record a single query execution.
   * @param {string} sql - executed SQL (as provided by Sequelize)
   * @param {number} durationMs - elapsed time in milliseconds
   * @param {string} [operation] - explicit operation tag (optional)
   */
  record(sql, durationMs, operation) {
    if (typeof durationMs !== 'number' || Number.isNaN(durationMs)) return;

    const op = operation || this.deriveOperation(sql);

    this.totalQueries += 1;
    this.totalDurationMs += durationMs;
    if (durationMs > this.maxDurationMs) this.maxDurationMs = durationMs;

    const entry = this.operations.get(op) || { count: 0, totalMs: 0, maxMs: 0, slow: 0 };
    entry.count += 1;
    entry.totalMs += durationMs;
    if (durationMs > entry.maxMs) entry.maxMs = durationMs;

    const isSlow = durationMs >= this.slowQueryThresholdMs;
    if (isSlow) {
      entry.slow += 1;
      this.slowQueryCount += 1;
      this.logSlowQuery(op, durationMs, sql);
    }
    this.operations.set(op, entry);
  }

  /**
   * Persist a slow query to the dedicated audit channel and keep a recent copy
   * in memory for the admin endpoint.
   */
  logSlowQuery(operation, durationMs, sql) {
    const record = {
      operation,
      durationMs: Math.round(durationMs),
      sql: this.truncateSql(sql),
      timestamp: new Date().toISOString(),
    };

    this.recentSlowQueries.unshift(record);
    if (this.recentSlowQueries.length > this.slowQueryBufferSize) {
      this.recentSlowQueries.pop();
    }

    try {
      if (typeof auditLogger.logSlowQuery === 'function') {
        auditLogger.logSlowQuery(record);
      }
      if (metricsService && metricsService.dbSlowQueriesTotal) {
        metricsService.dbSlowQueriesTotal.inc({ operation });
      }
    } catch (err) {
      // Never let logging failures interfere with query execution.
      logger.error('Failed to log slow query:', err.message);
    }
  }

  truncateSql(sql, max = 500) {
    if (!sql || typeof sql !== 'string') return '';
    const clean = sql.replace(/^Executing\s*\(.*?\):\s*/i, '').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  }

  /**
   * Returns a Sequelize-compatible `logging` callback. When `benchmark: true`
   * is set, Sequelize calls this with (sql, timingMs). An optional passthrough
   * preserves any existing logger (e.g. console.log in development).
   * @param {Function|null} [passthrough]
   * @returns {Function}
   */
  createSequelizeLogger(passthrough = null) {
    return (sql, timing) => {
      if (typeof timing === 'number') {
        this.record(sql, timing);
      }
      if (typeof passthrough === 'function') {
        try {
          passthrough(sql, timing);
        } catch (_) {
          /* ignore passthrough logger errors */
        }
      }
    };
  }

  /**
   * Aggregate statistics suitable for a metrics/admin endpoint.
   */
  getStats() {
    const operations = {};
    for (const [op, e] of this.operations.entries()) {
      operations[op] = {
        count: e.count,
        avgMs: e.count ? Math.round((e.totalMs / e.count) * 100) / 100 : 0,
        maxMs: Math.round(e.maxMs * 100) / 100,
        slow: e.slow,
      };
    }
    return {
      totalQueries: this.totalQueries,
      slowQueryCount: this.slowQueryCount,
      slowQueryThresholdMs: this.slowQueryThresholdMs,
      avgDurationMs: this.totalQueries
        ? Math.round((this.totalDurationMs / this.totalQueries) * 100) / 100
        : 0,
      maxDurationMs: Math.round(this.maxDurationMs * 100) / 100,
      operations,
    };
  }

  getSlowQueries(limit = 50) {
    return this.recentSlowQueries.slice(0, limit);
  }
}

// Export a shared singleton plus the class for testing / custom instances.
const singleton = new QueryPerformanceMonitor();
singleton.QueryPerformanceMonitor = QueryPerformanceMonitor;
module.exports = singleton;
