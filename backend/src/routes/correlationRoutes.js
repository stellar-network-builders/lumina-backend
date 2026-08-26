const express = require('express');
const router = express.Router();
const tvlPriceCorrelationService = require('../services/tvlPriceCorrelationService');
const tvlService = require('../services/tvlService');
const authService = require('../services/authService');
const logger = require('../utils/logger');

/**
 * Get TVL-Price correlation analysis
 * GET /api/correlation/analysis
 * Query parameters:
 * - tokenAddress: (optional) Specific token address to analyze
 * - startDate: (optional) Start date in YYYY-MM-DD format (default: 90 days ago)
 * - endDate: (optional) End date in YYYY-MM-DD format (default: today)
 * - correlationType: (optional) 'pearson' or 'spearman' (default: 'pearson')
 */
router.get('/analysis', async (req, res) => {
  try {
    const {
      tokenAddress,
      startDate,
      endDate,
      correlationType = 'pearson'
    } = req.query;

    // Parse dates
    const parsedStartDate = startDate ? new Date(startDate) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const parsedEndDate = endDate ? new Date(endDate) : new Date();

    // Validate dates
    if (isNaN(parsedStartDate.getTime()) || isNaN(parsedEndDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid date format. Use YYYY-MM-DD format.'
      });
    }

    if (parsedStartDate >= parsedEndDate) {
      return res.status(400).json({
        error: 'Start date must be before end date.'
      });
    }

    // Validate correlation type
    if (!['pearson', 'spearman'].includes(correlationType)) {
      return res.status(400).json({
        error: 'Invalid correlation type. Must be "pearson" or "spearman".'
      });
    }

    const analysis = await tvlPriceCorrelationService.getCorrelationAnalysis({
      tokenAddress: tokenAddress || null,
      startDate: parsedStartDate,
      endDate: parsedEndDate,
      correlationType
    });

    res.json({
      success: true,
      data: analysis,
      meta: {
        requestedAt: new Date().toISOString(),
        parameters: {
          tokenAddress: tokenAddress || 'all tokens',
          startDate: parsedStartDate.toISOString().split('T')[0],
          endDate: parsedEndDate.toISOString().split('T')[0],
          correlationType
        }
      }
    });
  } catch (error) {
    logger.error('Error in correlation analysis:', error);
    res.status(500).json({
      error: 'Failed to perform correlation analysis',
      message: error.message
    });
  }
});

/**
 * Get correlation data for chart visualization
 * GET /api/correlation/chart
 * Query parameters: same as /analysis
 */
router.get('/chart', async (req, res) => {
  try {
    const {
      tokenAddress,
      startDate,
      endDate,
      correlationType = 'pearson'
    } = req.query;

    // Parse dates
    const parsedStartDate = startDate ? new Date(startDate) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const parsedEndDate = endDate ? new Date(endDate) : new Date();

    // Validate dates
    if (isNaN(parsedStartDate.getTime()) || isNaN(parsedEndDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid date format. Use YYYY-MM-DD format.'
      });
    }

    if (parsedStartDate >= parsedEndDate) {
      return res.status(400).json({
        error: 'Start date must be before end date.'
      });
    }

    const chartData = await tvlPriceCorrelationService.getChartData({
      tokenAddress: tokenAddress || null,
      startDate: parsedStartDate,
      endDate: parsedEndDate,
      correlationType
    });

    res.json({
      success: true,
      data: chartData,
      meta: {
        requestedAt: new Date().toISOString(),
        parameters: {
          tokenAddress: tokenAddress || 'all tokens',
          startDate: parsedStartDate.toISOString().split('T')[0],
          endDate: parsedEndDate.toISOString().split('T')[0],
          correlationType
        }
      }
    });
  } catch (error) {
    logger.error('Error generating chart data:', error);
    res.status(500).json({
      error: 'Failed to generate chart data',
      message: error.message
    });
  }
});

/**
 * Get marketing insights summary
 * GET /api/correlation/insights
 * Query parameters: same as /analysis
 */
router.get('/insights', async (req, res) => {
  try {
    const {
      tokenAddress,
      startDate,
      endDate,
      correlationType = 'pearson'
    } = req.query;

    // Parse dates
    const parsedStartDate = startDate ? new Date(startDate) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const parsedEndDate = endDate ? new Date(endDate) : new Date();

    // Validate dates
    if (isNaN(parsedStartDate.getTime()) || isNaN(parsedEndDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid date format. Use YYYY-MM-DD format.'
      });
    }

    if (parsedStartDate >= parsedEndDate) {
      return res.status(400).json({
        error: 'Start date must be before end date.'
      });
    }

    const analysis = await tvlPriceCorrelationService.getCorrelationAnalysis({
      tokenAddress: tokenAddress || null,
      startDate: parsedStartDate,
      endDate: parsedEndDate,
      correlationType
    });

    // Extract only the insights for marketing
    const marketingInsights = {
      period: analysis.period,
      keyMetrics: {
        correlation: analysis.correlations,
        volatility: analysis.volatility,
        relationship: analysis.correlations.interpretation
      },
      insights: analysis.insights,
      marketingSummary: {
        primaryAngle: analysis.insights.find(i => i.impact === 'high')?.marketingAngle || 'Strategic Price Stability Choice',
        keyFinding: analysis.insights.find(i => i.impact === 'high')?.title || analysis.insights[0]?.title,
        evidence: analysis.insights.find(i => i.impact === 'high')?.description || analysis.insights[0]?.description,
        correlationStrength: analysis.correlations.interpretation,
        dataPoints: analysis.period.dataPoints
      }
    };

    res.json({
      success: true,
      data: marketingInsights,
      meta: {
        requestedAt: new Date().toISOString(),
        parameters: {
          tokenAddress: tokenAddress || 'all tokens',
          startDate: parsedStartDate.toISOString().split('T')[0],
          endDate: parsedEndDate.toISOString().split('T')[0],
          correlationType
        }
      }
    });
  } catch (error) {
    logger.error('Error generating insights:', error);
    res.status(500).json({
      error: 'Failed to generate insights',
      message: error.message
    });
  }
});

/**
 * Get historical TVL data
 * GET /api/correlation/historical-tvl
 * Query parameters:
 * - startDate: (optional) Start date in YYYY-MM-DD format (default: 30 days ago)
 * - endDate: (optional) End date in YYYY-MM-DD format (default: today)
 */
router.get('/historical-tvl', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    // Parse dates
    const parsedStartDate = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const parsedEndDate = endDate ? new Date(endDate) : new Date();

    // Validate dates
    if (isNaN(parsedStartDate.getTime()) || isNaN(parsedEndDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid date format. Use YYYY-MM-DD format.'
      });
    }

    if (parsedStartDate >= parsedEndDate) {
      return res.status(400).json({
        error: 'Start date must be before end date.'
      });
    }

    const historicalTVL = await tvlService.getHistoricalTVL(parsedStartDate, parsedEndDate);

    res.json({
      success: true,
      data: {
        tvlData: historicalTVL.map(record => ({
          date: record.snapshot_date,
          totalValueLocked: parseFloat(record.total_value_locked),
          activeVaultsCount: record.active_vaults_count,
          change24h: record.tvl_change_24h ? parseFloat(record.tvl_change_24h) : null,
          changePercentage24h: record.tvl_change_percentage_24h ? parseFloat(record.tvl_change_percentage_24h) : null,
          dataQuality: record.data_quality
        })),
        summary: {
          startDate: parsedStartDate.toISOString().split('T')[0],
          endDate: parsedEndDate.toISOString().split('T')[0],
          dataPoints: historicalTVL.length,
          averageTVL: historicalTVL.length > 0 
            ? historicalTVL.reduce((sum, record) => sum + parseFloat(record.total_value_locked), 0) / historicalTVL.length 
            : 0,
          maxTVL: historicalTVL.length > 0 
            ? Math.max(...historicalTVL.map(record => parseFloat(record.total_value_locked))) 
            : 0,
          minTVL: historicalTVL.length > 0 
            ? Math.min(...historicalTVL.map(record => parseFloat(record.total_value_locked))) 
            : 0
        }
      },
      meta: {
        requestedAt: new Date().toISOString(),
        parameters: {
          startDate: parsedStartDate.toISOString().split('T')[0],
          endDate: parsedEndDate.toISOString().split('T')[0]
        }
      }
    });
  } catch (error) {
    logger.error('Error fetching historical TVL:', error);
    res.status(500).json({
      error: 'Failed to fetch historical TVL data',
      message: error.message
    });
  }
});

/**
 * Create TVL snapshot (admin only)
 * POST /api/correlation/create-snapshot
 * Body:
 * - snapshotDate: (optional) Date for snapshot in YYYY-MM-DD format (default: today)
 */
router.post('/create-snapshot', 
  authService.authenticate(true), // Require admin access
  async (req, res) => {
    try {
      const { snapshotDate } = req.body;
      
      const parsedDate = snapshotDate ? new Date(snapshotDate) : new Date();
      
      // Validate date
      if (isNaN(parsedDate.getTime())) {
        return res.status(400).json({
          error: 'Invalid date format. Use YYYY-MM-DD format.'
        });
      }

      const snapshot = await tvlService.createHistoricalSnapshot(parsedDate);

      res.json({
        success: true,
        data: {
          snapshot: {
            date: snapshot.snapshot_date,
            totalValueLocked: parseFloat(snapshot.total_value_locked),
            activeVaultsCount: snapshot.active_vaults_count,
            change24h: snapshot.tvl_change_24h ? parseFloat(snapshot.tvl_change_24h) : null,
            changePercentage24h: snapshot.tvl_change_percentage_24h ? parseFloat(snapshot.tvl_change_percentage_24h) : null,
            createdAt: snapshot.created_at
          }
        },
        meta: {
          createdAt: new Date().toISOString(),
          snapshotDate: parsedDate.toISOString().split('T')[0]
        }
      });
    } catch (error) {
      logger.error('Error creating TVL snapshot:', error);
      res.status(500).json({
        error: 'Failed to create TVL snapshot',
        message: error.message
      });
    }
  }
);

/**
 * Clear correlation analysis cache (admin only)
 * DELETE /api/correlation/cache
 */
router.delete('/cache',
  authService.authenticate(true), // Require admin access
  async (req, res) => {
    try {
      tvlPriceCorrelationService.clearCache();
      
      res.json({
        success: true,
        message: 'Correlation analysis cache cleared successfully',
        meta: {
          clearedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('Error clearing cache:', error);
      res.status(500).json({
        error: 'Failed to clear cache',
        message: error.message
      });
    }
  }
);

module.exports = router;
