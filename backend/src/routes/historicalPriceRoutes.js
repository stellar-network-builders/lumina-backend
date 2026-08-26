const express = require('express');
const router = express.Router();
const historicalPriceTrackingService = require('../services/historicalPriceTrackingService');
const { VestingMilestone, CostBasisReport, HistoricalTokenPrice } = require('../models');
const { Op } = require('sequelize');
const { paginateWithCursorAndCount, validateCursorParams } = require('../services/cursorPaginationService');
const logger = require('../utils/logger');

/**
 * Generate vesting milestones for a vault
 * POST /api/historical-prices/generate-milestones
 */
router.post('/generate-milestones', async (req, res) => {
  try {
    const { 
      vaultId, 
      startDate, 
      endDate, 
      incrementDays = 30, 
      forceRefresh = false 
    } = req.body;

    if (!vaultId) {
      return res.status(400).json({ 
        error: 'vaultId is required' 
      });
    }

    const milestones = await historicalPriceTrackingService.generateVestingMilestones(
      vaultId, 
      { startDate, endDate, incrementDays, forceRefresh }
    );

    res.json({
      success: true,
      message: `Generated ${milestones.length} vesting milestones`,
      data: {
        vault_id: vaultId,
        milestones_count: milestones.length,
        milestones: milestones.map(m => ({
          id: m.id,
          milestone_date: m.milestone_date,
          milestone_type: m.milestone_type,
          vested_amount: m.vested_amount,
          price_usd: m.price_usd,
          vwap_24h_usd: m.vwap_24h_usd,
          price_source: m.price_source
        }))
      }
    });
  } catch (error) {
    logger.error('Error generating milestones:', error);
    res.status(500).json({ 
      error: 'Failed to generate vesting milestones',
      details: error.message 
    });
  }
});

/**
 * Generate cost basis report for a beneficiary
 * GET /api/historical-prices/cost-basis/:userAddress/:tokenAddress/:year
 */
router.get('/cost-basis/:userAddress/:tokenAddress/:year', async (req, res) => {
  try {
    const { userAddress, tokenAddress, year } = req.params;
    const yearInt = parseInt(year);

    if (isNaN(yearInt) || yearInt < 2020 || yearInt > new Date().getFullYear()) {
      return res.status(400).json({ 
        error: 'Invalid year provided' 
      });
    }

    const report = await historicalPriceTrackingService.generateCostBasisReport(
      userAddress, 
      tokenAddress, 
      yearInt
    );

    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error('Error generating cost basis report:', error);
    res.status(500).json({ 
      error: 'Failed to generate cost basis report',
      details: error.message 
    });
  }
});

/**
 * Get vesting milestones for a beneficiary (cursor-based pagination)
 * GET /api/historical-prices/milestones/:userAddress
 */
router.get('/milestones/:userAddress', async (req, res) => {
  try {
    const { userAddress } = req.params;
    const { 
      tokenAddress, 
      startDate, 
      endDate,
      cursor,
      limit = 100 
    } = req.query;

    // Validate cursor parameters
    const paginationOptions = validateCursorParams(req, 'milestone_date');

    const whereClause = {};
    
    if (tokenAddress) {
      whereClause.token_address = tokenAddress;
    }

    if (startDate || endDate) {
      whereClause.milestone_date = {};
      if (startDate) whereClause.milestone_date[Op.gte] = new Date(startDate);
      if (endDate) whereClause.milestone_date[Op.lte] = new Date(endDate);
    }

    const milestones = await paginateWithCursorAndCount(VestingMilestone, {
      cursor: paginationOptions.cursor,
      orderField: 'milestone_date',
      orderDirection: 'DESC',
      limit: paginationOptions.limit,
      where: whereClause,
      include: [
        {
          model: require('../models').Beneficiary,
          as: 'beneficiary',
          where: { address: userAddress },
          attributes: ['address', 'total_allocated']
        },
        {
          model: require('../models').Vault,
          as: 'vault',
          attributes: ['address', 'name', 'token_address']
        }
      ]
    });

    res.json({
      success: true,
      data: {
        milestones: milestones.items,
        pagination: milestones.pagination
      }
    });
  } catch (error) {
    logger.error('Error fetching milestones:', error);
    res.status(500).json({ 
      error: 'Failed to fetch vesting milestones',
      details: error.message 
    });
  }
});

/**
 * Get historical token prices
 * GET /api/historical-prices/prices/:tokenAddress
 */
router.get('/prices/:tokenAddress', async (req, res) => {
  try {
    const { tokenAddress } = req.params;
    const { startDate, endDate, limit = 100 } = req.query;

    const whereClause = { token_address: tokenAddress };

    if (startDate || endDate) {
      whereClause.price_date = {};
      if (startDate) whereClause.price_date[Op.gte] = startDate;
      if (endDate) whereClause.price_date[Op.lte] = endDate;
    }

    const prices = await HistoricalTokenPrice.findAll({
      where: whereClause,
      order: [['price_date', 'DESC']],
      limit: parseInt(limit)
    });

    res.json({
      success: true,
      data: {
        token_address: tokenAddress,
        prices: prices.map(p => ({
          date: p.price_date,
          price_usd: p.price_usd,
          vwap_24h_usd: p.vwap_24h_usd,
          volume_24h_usd: p.volume_24h_usd,
          price_source: p.price_source,
          data_quality: p.data_quality
        }))
      }
    });
  } catch (error) {
    logger.error('Error fetching historical prices:', error);
    res.status(500).json({ 
      error: 'Failed to fetch historical prices',
      details: error.message 
    });
  }
});

/**
 * Backfill missing prices
 * POST /api/historical-prices/backfill
 */
router.post('/backfill', async (req, res) => {
  try {
    const { 
      tokenAddress, 
      startDate, 
      endDate, 
      batchSize = 50 
    } = req.body;

    const updatedCount = await historicalPriceTrackingService.backfillMissingPrices({
      tokenAddress,
      startDate,
      endDate,
      batchSize
    });

    res.json({
      success: true,
      message: `Backfilled prices for ${updatedCount} milestones`,
      data: {
        updated_count: updatedCount
      }
    });
  } catch (error) {
    logger.error('Error backfilling prices:', error);
    res.status(500).json({ 
      error: 'Failed to backfill prices',
      details: error.message 
    });
  }
});

/**
 * Get cost basis reports for a user
 * GET /api/historical-prices/reports/:userAddress
 */
router.get('/reports/:userAddress', async (req, res) => {
  try {
    const { userAddress } = req.params;
    const { tokenAddress, year } = req.query;

    const whereClause = { user_address: userAddress };
    
    if (tokenAddress) {
      whereClause.token_address = tokenAddress;
    }
    
    if (year) {
      whereClause.report_year = parseInt(year);
    }

    const reports = await CostBasisReport.findAll({
      where: whereClause,
      order: [['report_year', 'DESC'], ['generated_at', 'DESC']]
    });

    res.json({
      success: true,
      data: {
        user_address: userAddress,
        reports: reports.map(r => ({
          id: r.id,
          token_address: r.token_address,
          report_year: r.report_year,
          total_vested_amount: r.total_vested_amount,
          total_cost_basis_usd: r.total_cost_basis_usd,
          total_milestones: r.total_milestones,
          generated_at: r.generated_at
        }))
      }
    });
  } catch (error) {
    logger.error('Error fetching cost basis reports:', error);
    res.status(500).json({ 
      error: 'Failed to fetch cost basis reports',
      details: error.message 
    });
  }
});

/**
 * Get detailed cost basis report
 * GET /api/historical-prices/reports/:userAddress/:tokenAddress/:year/details
 */
router.get('/reports/:userAddress/:tokenAddress/:year/details', async (req, res) => {
  try {
    const { userAddress, tokenAddress, year } = req.params;

    const report = await CostBasisReport.findOne({
      where: {
        user_address: userAddress,
        token_address: tokenAddress,
        report_year: parseInt(year)
      }
    });

    if (!report) {
      return res.status(404).json({ 
        error: 'Cost basis report not found' 
      });
    }

    res.json({
      success: true,
      data: report.report_data
    });
  } catch (error) {
    logger.error('Error fetching detailed report:', error);
    res.status(500).json({ 
      error: 'Failed to fetch detailed cost basis report',
      details: error.message 
    });
  }
});

/**
 * Health check endpoint
 * GET /api/historical-prices/health
 */
router.get('/health', async (req, res) => {
  try {
    // Check database connectivity
    const milestoneCount = await VestingMilestone.count();
    const priceCount = await HistoricalTokenPrice.count();
    const reportCount = await CostBasisReport.count();

    res.json({
      success: true,
      status: 'healthy',
      data: {
        milestones_count: milestoneCount,
        cached_prices_count: priceCount,
        reports_count: reportCount,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(500).json({ 
      success: false,
      status: 'unhealthy',
      error: error.message 
    });
  }
});

module.exports = router;