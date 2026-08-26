const logger = require('../utils/logger');
const SEP12Controller = require('./controllers/sep12.controller');
const SEP12Service = require('./services/sep12.service');

class SEP12Module {
  constructor(dbManager) {
    this.dbManager = dbManager;
    this.controller = null;
    this.service = null;
  }

  async initialize() {
    try {
      this.service = new SEP12Service(this.dbManager);
      await this.service.initialize();
      this.controller = new SEP12Controller(this.dbManager);
      logger.info('SEP-12 KYC Module initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize SEP-12 KYC Module:', error.message);
      throw error;
    }
  }

  registerRoutes(app) {
    if (!this.controller) {
      throw new Error('SEP-12 Module not initialized. Call initialize() first.');
    }
    this.controller.registerRoutes(app);
    logger.info('SEP-12 KYC routes registered');
  }
}

module.exports = SEP12Module;
