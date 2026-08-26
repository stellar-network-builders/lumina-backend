const logger = require('../utils/logger');
const { Sequelize } = require('sequelize');
const secretsService = require('../services/secretsService');
const { buildPoolOptions, buildTimeoutDialectOptions } = require('./poolConfig');
const queryPerformanceMonitor = require('./queryPerformanceMonitor');

let sequelize;

/**
 * Sequelize logging callback that feeds the query performance monitor while
 * preserving console logging in development. Used with `benchmark: true` so the
 * elapsed time (ms) is passed as the second argument.
 */
const queryLogger = queryPerformanceMonitor.createSequelizeLogger(
  process.env.NODE_ENV === 'development' ? console.log : null
);

/**
 * Initialize database connection with dynamic credentials from Vault/Secrets Manager
 */
const initializeDatabase = async () => {
  if (process.env.NODE_ENV === 'test') {
    // Use SQLite in-memory for tests — no Postgres required
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: ':memory:',
      // Instrument queries even in tests so the performance monitor is exercised.
      benchmark: true,
      logging: queryLogger,
    });
  } else {
    // Get database credentials dynamically from secrets service
    try {
      const dbConfig = await secretsService.getDatabaseCredentials();
      
      sequelize = new Sequelize(
        dbConfig.database,
        dbConfig.username,
        dbConfig.password,
        {
          host: dbConfig.host,
          port: dbConfig.port,
          dialect: 'postgres',
          benchmark: true,
          logging: queryLogger,
          ssl: dbConfig.ssl,
          pool: buildPoolOptions(),
          dialectOptions: {
            ...(dbConfig.ssl ? { sslmode: 'require', rejectUnauthorized: true } : {}),
            ...buildTimeoutDialectOptions(),
          },
        }
      );

      logger.info('Database connection initialized with dynamic credentials and tuned pool', buildPoolOptions());
    } catch (error) {
      logger.error('Failed to initialize database with dynamic credentials, falling back to environment variables:', error);
      
      // Fallback to environment variables if secrets service fails
      sequelize = new Sequelize(
        process.env.DB_NAME || 'vesting_vault',
        process.env.DB_USER || 'postgres',
        process.env.DB_PASSWORD || 'password',
        {
          host: process.env.DB_HOST || 'localhost',
          port: process.env.DB_PORT || 5432,
          dialect: 'postgres',
          benchmark: true,
          logging: queryLogger,
          pool: buildPoolOptions(),
          dialectOptions: {
            ...(process.env.DB_SSL === 'true'
              ? { sslmode: 'require', rejectUnauthorized: true }
              : {}),
            ...buildTimeoutDialectOptions(),
          },
        }
      );
    }
  }
  
  return sequelize;
};

// Initialize immediately for backward compatibility
let initPromise = initializeDatabase();

/**
 * Read replicas, if any are configured. Read/write splitting routes reads to a
 * replica and writes to the primary; with no replicas configured every
 * operation resolves to the primary (pooled) connection.
 */
const readReplicas = [];

/**
 * Return the appropriate (pooled) Sequelize connection for a database
 * operation. Writes/mutations always go to the primary; reads may be served by
 * a replica when one is healthy and configured, otherwise they fall back to the
 * primary. This is the entry point used by BaseModel and the database router.
 *
 * @param {string} [operation='read'] - one of read|write|create|update|delete
 * @returns {import('sequelize').Sequelize} the connection to use
 */
const getDatabaseConnection = (operation = 'read') => {
  const isWrite = ['write', 'create', 'update', 'delete', 'insert', 'upsert'].includes(
    String(operation).toLowerCase()
  );

  if (!isWrite && readReplicas.length > 0) {
    // Simple round-robin across healthy replicas for read operations.
    const replica = readReplicas[Math.floor(Math.random() * readReplicas.length)];
    if (replica) return replica;
  }

  return sequelize;
};

/**
 * Replica lag in bytes. With no streaming replicas configured there is no lag.
 * @returns {Promise<number>}
 */
const checkReplicaLag = async () => {
  if (readReplicas.length === 0) return 0;
  // Placeholder for real replica-lag measurement once replicas are configured.
  return 0;
};

/**
 * Lightweight database health probe used by the failover service.
 * @returns {Promise<boolean>} true when the primary accepts connections
 */
const checkDatabaseHealth = async () => {
  try {
    await initPromise;
    if (!sequelize) return false;
    await sequelize.authenticate();
    return true;
  } catch (error) {
    logger.error('Database health check failed:', error.message);
    return false;
  }
};

// Export the connection accessors. `sequelize` / `writeSequelize` are exposed as
// getters so consumers always observe the live instance, even though it is
// assigned asynchronously during initialization.
module.exports = {
  get sequelize() {
    return sequelize;
  },
  get writeSequelize() {
    return sequelize;
  },
  readReplicas,
  initializeDatabase,
  getSequelize: async () => {
    await initPromise;
    return sequelize;
  },
  getDatabaseConnection,
  checkReplicaLag,
  checkDatabaseHealth,
};
