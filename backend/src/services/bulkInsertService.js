const logger = require('../utils/logger');
const { sequelize } = require('../database/connection');
const { ClaimsHistory, SubSchedule, Vault, IndexerState } = require('../models');
const { Op } = require('sequelize');
const Sentry = require('@sentry/node');

/**
 * Bulk Insert Service for optimizing historical sync operations
 * Implements chunked bulk inserts to improve performance during genesis sync
 */
class BulkInsertService {
  constructor() {
    this.chunkSize = 1000; // Process records in chunks of 1,000
    this.maxRetries = 3;
    this.retryDelay = 1000; // 1 second base delay
  }

  /**
   * Bulk insert claims history records with chunking and retry logic
   * @param {Array} claimsData - Array of claim objects to insert
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Results with counts and any errors
   */
  async bulkInsertClaims(claimsData, options = {}) {
    const startTime = Date.now();
    const results = {
      total: claimsData.length,
      processed: 0,
      errors: 0,
      errorDetails: [],
      duration: 0
    };

    try {
      logger.info(`Starting bulk insert of ${claimsData.length} claims...`);
      
      // Process in chunks to avoid memory issues and improve performance
      const chunks = this.chunkArray(claimsData, this.chunkSize);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkNumber = i + 1;
        const totalChunks = chunks.length;
        
        logger.info(`Processing chunk ${chunkNumber}/${totalChunks} (${chunk.length} records)...`);
        
        try {
          await this.insertClaimsWithRetry(chunk, chunkNumber);
          results.processed += chunk.length;
          
          // Log progress
          const progress = ((results.processed / results.total) * 100).toFixed(2);
          logger.info(`Chunk ${chunkNumber} completed. Progress: ${progress}% (${results.processed}/${results.total})`);
          
        } catch (chunkError) {
          logger.error(`Error processing chunk ${chunkNumber}:`, chunkError);
          results.errors += chunk.length;
          results.errorDetails.push({
            chunk: chunkNumber,
            error: chunkError.message,
            recordCount: chunk.length
          });
          
          // Send error to Sentry for monitoring
          Sentry.captureException(chunkError, {
            tags: { 
              service: 'bulk-insert',
              operation: 'bulk-insert-claims',
              chunk: chunkNumber.toString()
            },
            extra: {
              chunkSize: chunk.length,
              totalChunks,
              processedRecords: results.processed
            }
          });
        }
      }

      results.duration = Date.now() - startTime;
      
      logger.info(`Bulk insert completed in ${results.duration}ms:`, {
        total: results.total,
        processed: results.processed,
        errors: results.errors,
        successRate: ((results.processed / results.total) * 100).toFixed(2) + '%'
      });

      return results;

    } catch (error) {
      logger.error('Critical error in bulk insert claims:', error);
      Sentry.captureException(error, {
        tags: { service: 'bulk-insert', operation: 'bulk-insert-claims' },
        extra: { totalRecords: claimsData.length }
      });
      throw error;
    }
  }

  /**
   * Bulk insert subschedule records with chunking and retry logic
   * @param {Array} schedulesData - Array of subschedule objects to insert
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Results with counts and any errors
   */
  async bulkInsertSchedules(schedulesData, options = {}) {
    const startTime = Date.now();
    const results = {
      total: schedulesData.length,
      processed: 0,
      errors: 0,
      errorDetails: [],
      duration: 0
    };

    try {
      logger.info(`Starting bulk insert of ${schedulesData.length} schedules...`);
      
      // Process in chunks
      const chunks = this.chunkArray(schedulesData, this.chunkSize);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkNumber = i + 1;
        const totalChunks = chunks.length;
        
        logger.info(`Processing chunk ${chunkNumber}/${totalChunks} (${chunk.length} records)...`);
        
        try {
          await this.insertSchedulesWithRetry(chunk, chunkNumber);
          results.processed += chunk.length;
          
          // Log progress
          const progress = ((results.processed / results.total) * 100).toFixed(2);
          logger.info(`Chunk ${chunkNumber} completed. Progress: ${progress}% (${results.processed}/${results.total})`);
          
        } catch (chunkError) {
          logger.error(`Error processing chunk ${chunkNumber}:`, chunkError);
          results.errors += chunk.length;
          results.errorDetails.push({
            chunk: chunkNumber,
            error: chunkError.message,
            recordCount: chunk.length
          });
          
          Sentry.captureException(chunkError, {
            tags: { 
              service: 'bulk-insert',
              operation: 'bulk-insert-schedules',
              chunk: chunkNumber.toString()
            },
            extra: {
              chunkSize: chunk.length,
              totalChunks,
              processedRecords: results.processed
            }
          });
        }
      }

      results.duration = Date.now() - startTime;
      
      logger.info(`Bulk insert completed in ${results.duration}ms:`, {
        total: results.total,
        processed: results.processed,
        errors: results.errors,
        successRate: ((results.processed / results.total) * 100).toFixed(2) + '%'
      });

      return results;

    } catch (error) {
      logger.error('Critical error in bulk insert schedules:', error);
      Sentry.captureException(error, {
        tags: { service: 'bulk-insert', operation: 'bulk-insert-schedules' },
        extra: { totalRecords: schedulesData.length }
      });
      throw error;
    }
  }

  /**
   * Bulk insert vault records with chunking and retry logic
   * @param {Array} vaultsData - Array of vault objects to insert
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Results with counts and any errors
   */
  async bulkInsertVaults(vaultsData, options = {}) {
    const startTime = Date.now();
    const results = {
      total: vaultsData.length,
      processed: 0,
      errors: 0,
      errorDetails: [],
      duration: 0
    };

    try {
      logger.info(`Starting bulk insert of ${vaultsData.length} vaults...`);
      
      // Process in chunks
      const chunks = this.chunkArray(vaultsData, this.chunkSize);
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkNumber = i + 1;
        const totalChunks = chunks.length;
        
        logger.info(`Processing chunk ${chunkNumber}/${totalChunks} (${chunk.length} records)...`);
        
        try {
          await this.insertVaultsWithRetry(chunk, chunkNumber);
          results.processed += chunk.length;
          
          // Log progress
          const progress = ((results.processed / results.total) * 100).toFixed(2);
          logger.info(`Chunk ${chunkNumber} completed. Progress: ${progress}% (${results.processed}/${results.total})`);
          
        } catch (chunkError) {
          logger.error(`Error processing chunk ${chunkNumber}:`, chunkError);
          results.errors += chunk.length;
          results.errorDetails.push({
            chunk: chunkNumber,
            error: chunkError.message,
            recordCount: chunk.length
          });
          
          Sentry.captureException(chunkError, {
            tags: { 
              service: 'bulk-insert',
              operation: 'bulk-insert-vaults',
              chunk: chunkNumber.toString()
            },
            extra: {
              chunkSize: chunk.length,
              totalChunks,
              processedRecords: results.processed
            }
          });
        }
      }

      results.duration = Date.now() - startTime;
      
      logger.info(`Bulk insert completed in ${results.duration}ms:`, {
        total: results.total,
        processed: results.processed,
        errors: results.errors,
        successRate: ((results.processed / results.total) * 100).toFixed(2) + '%'
      });

      return results;

    } catch (error) {
      logger.error('Critical error in bulk insert vaults:', error);
      Sentry.captureException(error, {
        tags: { service: 'bulk-insert', operation: 'bulk-insert-vaults' },
        extra: { totalRecords: vaultsData.length }
      });
      throw error;
    }
  }

  /**
   * Optimized historical sync that processes all data types in parallel chunks
   * @param {Object} historicalData - Object containing arrays of different data types
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Combined results
   */
  async optimizedHistoricalSync(historicalData, options = {}) {
    const startTime = Date.now();
    logger.info('Starting optimized historical sync...');
    
    const results = {
      claims: null,
      schedules: null,
      vaults: null,
      totalDuration: 0,
      totalRecords: 0,
      totalProcessed: 0,
      totalErrors: 0
    };

    try {
      const { claims, schedules, vaults } = historicalData;
      
      // Calculate total records
      results.totalRecords = (claims?.length || 0) + (schedules?.length || 0) + (vaults?.length || 0);
      
      // Process different data types in parallel if they exist
      const promises = [];
      
      if (claims && claims.length > 0) {
        promises.push(
          this.bulkInsertClaims(claims, options)
            .then(result => {
              results.claims = result;
              results.totalProcessed += result.processed;
              results.totalErrors += result.errors;
              return result;
            })
        );
      }
      
      if (schedules && schedules.length > 0) {
        promises.push(
          this.bulkInsertSchedules(schedules, options)
            .then(result => {
              results.schedules = result;
              results.totalProcessed += result.processed;
              results.totalErrors += result.errors;
              return result;
            })
        );
      }
      
      if (vaults && vaults.length > 0) {
        promises.push(
          this.bulkInsertVaults(vaults, options)
            .then(result => {
              results.vaults = result;
              results.totalProcessed += result.processed;
              results.totalErrors += result.errors;
              return result;
            })
        );
      }

      // Wait for all operations to complete
      await Promise.all(promises);
      
      results.totalDuration = Date.now() - startTime;
      
      logger.info(`Optimized historical sync completed in ${results.totalDuration}ms:`, {
        totalRecords: results.totalRecords,
        totalProcessed: results.totalProcessed,
        totalErrors: results.totalErrors,
        overallSuccessRate: ((results.totalProcessed / results.totalRecords) * 100).toFixed(2) + '%'
      });

      return results;

    } catch (error) {
      logger.error('Critical error in optimized historical sync:', error);
      Sentry.captureException(error, {
        tags: { service: 'bulk-insert', operation: 'optimized-historical-sync' },
        extra: { 
          totalRecords: results.totalRecords,
          processedRecords: results.totalProcessed 
        }
      });
      throw error;
    }
  }

  /**
   * Insert claims chunk with retry logic
   * @param {Array} chunk - Array of claim records
   * @param {number} chunkNumber - Chunk number for logging
   * @returns {Promise<void>}
   */
  async insertClaimsWithRetry(chunk, chunkNumber) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const t = await sequelize.transaction();
        
        try {
          // Use bulkCreate for optimal performance
          await ClaimsHistory.bulkCreate(chunk, {
            transaction: t,
            validate: true,
            ignoreDuplicates: false // Set to true if you want to skip duplicates
          });
          
          await t.commit();
          logger.info(`Chunk ${chunkNumber}: Successfully inserted ${chunk.length} claims (attempt ${attempt})`);
          return;
          
        } catch (error) {
          await t.rollback();
          throw error;
        }
        
      } catch (error) {
        lastError = error;
        logger.warn(`Chunk ${chunkNumber}: Attempt ${attempt} failed:`, error.message);
        
        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
          logger.info(`Chunk ${chunkNumber}: Retrying in ${delay}ms...`);
          await this.delay(delay);
        }
      }
    }
    
    throw new Error(`Chunk ${chunkNumber}: Failed after ${this.maxRetries} attempts. Last error: ${lastError.message}`);
  }

  /**
   * Insert schedules chunk with retry logic
   * @param {Array} chunk - Array of schedule records
   * @param {number} chunkNumber - Chunk number for logging
   * @returns {Promise<void>}
   */
  async insertSchedulesWithRetry(chunk, chunkNumber) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const t = await sequelize.transaction();
        
        try {
          await SubSchedule.bulkCreate(chunk, {
            transaction: t,
            validate: true,
            ignoreDuplicates: false
          });
          
          await t.commit();
          logger.info(`Chunk ${chunkNumber}: Successfully inserted ${chunk.length} schedules (attempt ${attempt})`);
          return;
          
        } catch (error) {
          await t.rollback();
          throw error;
        }
        
      } catch (error) {
        lastError = error;
        logger.warn(`Chunk ${chunkNumber}: Attempt ${attempt} failed:`, error.message);
        
        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          logger.info(`Chunk ${chunkNumber}: Retrying in ${delay}ms...`);
          await this.delay(delay);
        }
      }
    }
    
    throw new Error(`Chunk ${chunkNumber}: Failed after ${this.maxRetries} attempts. Last error: ${lastError.message}`);
  }

  /**
   * Insert vaults chunk with retry logic
   * @param {Array} chunk - Array of vault records
   * @param {number} chunkNumber - Chunk number for logging
   * @returns {Promise<void>}
   */
  async insertVaultsWithRetry(chunk, chunkNumber) {
    let lastError;
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const t = await sequelize.transaction();
        
        try {
          await Vault.bulkCreate(chunk, {
            transaction: t,
            validate: true,
            ignoreDuplicates: false
          });
          
          await t.commit();
          logger.info(`Chunk ${chunkNumber}: Successfully inserted ${chunk.length} vaults (attempt ${attempt})`);
          return;
          
        } catch (error) {
          await t.rollback();
          throw error;
        }
        
      } catch (error) {
        lastError = error;
        logger.warn(`Chunk ${chunkNumber}: Attempt ${attempt} failed:`, error.message);
        
        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          logger.info(`Chunk ${chunkNumber}: Retrying in ${delay}ms...`);
          await this.delay(delay);
        }
      }
    }
    
    throw new Error(`Chunk ${chunkNumber}: Failed after ${this.maxRetries} attempts. Last error: ${lastError.message}`);
  }

  /**
   * Utility function to chunk arrays
   * @param {Array} array - Array to chunk
   * @param {number} size - Chunk size
   * @returns {Array} Array of chunks
   */
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Utility function for delays
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get performance statistics
   * @returns {Object} Performance stats
   */
  getPerformanceStats() {
    return {
      chunkSize: this.chunkSize,
      maxRetries: this.maxRetries,
      retryDelay: this.retryDelay
    };
  }

  /**
   * Update configuration
   * @param {Object} config - New configuration
   */
  updateConfig(config) {
    if (config.chunkSize) this.chunkSize = config.chunkSize;
    if (config.maxRetries) this.maxRetries = config.maxRetries;
    if (config.retryDelay) this.retryDelay = config.retryDelay;
    
    logger.info('Bulk insert service configuration updated:', this.getPerformanceStats());
  }
}

module.exports = new BulkInsertService();
