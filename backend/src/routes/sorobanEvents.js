const express = require('express');
const { SorobanEvent } = require('../models');
const { Op } = require('sequelize');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Get Soroban events with pagination and filtering
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      eventType,
      contractAddress,
      processed,
      startDate,
      endDate,
      ledgerSequence
    } = req.query;

    const whereConditions = {};

    // Apply filters
    if (eventType) {
      whereConditions.event_type = eventType;
    }

    if (contractAddress) {
      whereConditions.contract_address = contractAddress;
    }

    if (processed !== undefined) {
      whereConditions.processed = processed === 'true';
    }

    if (startDate || endDate) {
      whereConditions.event_timestamp = {};
      if (startDate) {
        whereConditions.event_timestamp[Op.gte] = new Date(startDate);
      }
      if (endDate) {
        whereConditions.event_timestamp[Op.lte] = new Date(endDate);
      }
    }

    if (ledgerSequence) {
      whereConditions.ledger_sequence = ledgerSequence;
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { count, rows: events } = await SorobanEvent.findAndCountAll({
      where: whereConditions,
      order: [['ledger_sequence', 'DESC']],
      limit: parseInt(limit),
      offset,
      attributes: {
        exclude: ['event_body'] // Exclude large JSON body from list view
      }
    });

    res.json({
      success: true,
      data: {
        events,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching Soroban events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch events'
    });
  }
});

/**
 * Get specific event by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const event = await SorobanEvent.findByPk(req.params.id);

    if (!event) {
      return res.status(404).json({
        success: false,
        error: 'Event not found'
      });
    }

    res.json({
      success: true,
      data: event
    });

  } catch (error) {
    logger.error('Error fetching event:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch event'
    });
  }
});

/**
 * Get service status
 */
router.get('/service/status', async (req, res) => {
  try {
    const pollerStatus = global.sorobanEventPoller?.getStatus();
    const processorStatus = global.sorobanEventProcessor?.getStatus();
    const processorStats = global.sorobanEventProcessor?.getProcessingStats?.();

    const stats = await SorobanEvent.findAll({
      attributes: [
        [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'total'],
        [require('sequelize').fn('COUNT', require('sequelize').literal('CASE WHEN processed = true THEN 1 END')), 'processed'],
        [require('sequelize').fn('COUNT', require('sequelize').literal('CASE WHEN processed = false THEN 1 END')), 'unprocessed'],
        [require('sequelize').fn('COUNT', require('sequelize').literal('CASE WHEN processing_error IS NOT NULL THEN 1 END')), 'failed']
      ],
      raw: true
    });

    res.json({
      success: true,
      data: {
        poller: pollerStatus || { isRunning: false },
        processor: processorStatus || { isProcessing: false },
        statistics: processorStats || {},
        database: stats[0] || { total: 0, processed: 0, unprocessed: 0, failed: 0 }
      }
    });

  } catch (error) {
    logger.error('Error fetching service status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch service status'
    });
  }
});

/**
 * Retry failed events
 */
router.post('/retry-failed', async (req, res) => {
  try {
    const { limit = 50 } = req.body;

    if (!global.sorobanEventProcessor) {
      return res.status(503).json({
        success: false,
        error: 'Event processor service not available'
      });
    }

    await global.sorobanEventProcessor.retryFailedEvents(limit);

    res.json({
      success: true,
      message: `Initiated retry for up to ${limit} failed events`
    });

  } catch (error) {
    logger.error('Error retrying failed events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retry events'
    });
  }
});

/**
 * Add contract address to monitoring
 */
router.post('/contracts/:address', async (req, res) => {
  try {
    const { address } = req.params;

    if (!global.sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Event poller service not available'
      });
    }

    global.sorobanEventPoller.addContractAddress(address);

    res.json({
      success: true,
      message: `Added contract address ${address} to monitoring`
    });

  } catch (error) {
    logger.error('Error adding contract address:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add contract address'
    });
  }
});

/**
 * Remove contract address from monitoring
 */
router.delete('/contracts/:address', async (req, res) => {
  try {
    const { address } = req.params;

    if (!global.sorobanEventPoller) {
      return res.status(503).json({
        success: false,
        error: 'Event poller service not available'
      });
    }

    global.sorobanEventPoller.removeContractAddress(address);

    res.json({
      success: true,
      message: `Removed contract address ${address} from monitoring`
    });

  } catch (error) {
    logger.error('Error removing contract address:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to remove contract address'
    });
  }
});

/**
 * Get event statistics by type
 */
router.get('/statistics/by-type', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const whereConditions = {};
    if (startDate || endDate) {
      whereConditions.event_timestamp = {};
      if (startDate) {
        whereConditions.event_timestamp[Op.gte] = new Date(startDate);
      }
      if (endDate) {
        whereConditions.event_timestamp[Op.lte] = new Date(endDate);
      }
    }

    const stats = await SorobanEvent.findAll({
      attributes: [
        'event_type',
        [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count'],
        [require('sequelize').fn('COUNT', require('sequelize').literal('CASE WHEN processed = true THEN 1 END')), 'processed'],
        [require('sequelize').fn('COUNT', require('sequelize').literal('CASE WHEN processed = false THEN 1 END')), 'unprocessed']
      ],
      where: whereConditions,
      group: ['event_type'],
      raw: true
    });

    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    logger.error('Error fetching event statistics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    });
  }
});

module.exports = router;
