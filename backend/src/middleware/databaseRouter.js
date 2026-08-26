const logger = require('../utils/logger');
const { getDatabaseConnection, checkReplicaLag } = require('../database/connection');

/**
 * Database routing middleware for automatic read/write splitting
 * This middleware analyzes Sequelize operations and routes them to the appropriate database
 */

class DatabaseRouter {
  constructor() {
    this.lagThreshold = parseInt(process.env.DB_REPLICA_LAG_THRESHOLD || '1000'); // bytes
    this.lastLagCheck = 0;
    this.currentLag = 0;
  }

  /**
   * Middleware function to intercept and route database operations
   */
  middleware() {
    return (req, res, next) => {
      // Add database routing helper to request object
      req.db = this.routeOperation.bind(this);
      next();
    };
  }

  /**
   * Route database operation based on type and current replica lag
   */
  async routeOperation(operation = 'read') {
    // Check replica lag periodically (every 30 seconds)
    const now = Date.now();
    if (now - this.lastLagCheck > 30000) {
      this.currentLag = await checkReplicaLag();
      this.lastLagCheck = now;
    }

    // If replica lag exceeds threshold, route reads to master
    if (operation === 'read' && this.currentLag > this.lagThreshold) {
      logger.warn(`Replica lag ${this.currentLag} bytes exceeds threshold ${this.lagThreshold}, routing read to master`);
      return getDatabaseConnection('write');
    }

    return getDatabaseConnection(operation);
  }

  /**
   * Analyze Sequelize operation type
   */
  analyzeOperation(operation) {
    if (typeof operation === 'string') {
      return operation.toLowerCase();
    }

    // Analyze Sequelize method calls
    const operationStr = operation.toString().toLowerCase();
    
    if (operationStr.includes('create') || operationStr.includes('insert')) {
      return 'create';
    }
    if (operationStr.includes('update') || operationStr.includes('save')) {
      return 'update';
    }
    if (operationStr.includes('destroy') || operationStr.includes('delete')) {
      return 'delete';
    }
    if (operationStr.includes('find') || operationStr.includes('count') || operationStr.includes('aggregate')) {
      return 'read';
    }

    // Default to read for safety
    return 'read';
  }

  /**
   * Get current replica lag
   */
  getCurrentLag() {
    return this.currentLag;
  }

  /**
   * Force read operations to use master (useful for critical consistency)
   */
  forceReadToMaster() {
    return getDatabaseConnection('write');
  }
}

// Create singleton instance
const databaseRouter = new DatabaseRouter();

module.exports = databaseRouter;
