const express = require('express');
const router = express.Router();
const TokenUnlockVolumeService = require('../services/tokenUnlockVolumeService');
const authService = require('../services/authService');
const logger = require('../utils/logger');

const unlockVolumeService = new TokenUnlockVolumeService();

// GET /api/unlock-volume/projection
// Generate 12-month unlock volume projection
router.get(
  '/projection',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const {
        tokenAddress,
        orgId,
        vaultTags,
        months = 12,
        startDate
      } = req.query;

      // Parse and validate parameters
      const options = {
        tokenAddress: tokenAddress || undefined,
        orgId: orgId || undefined,
        vaultTags: vaultTags ? (Array.isArray(vaultTags) ? vaultTags : vaultTags.split(',')) : undefined,
        months: parseInt(months) || 12,
        startDate: startDate ? new Date(startDate) : new Date()
      };

      // Validate months parameter
      if (options.months < 1 || options.months > 24) {
        return res.status(400).json({
          success: false,
          message: 'Months parameter must be between 1 and 24'
        });
      }

      // Validate start date
      if (isNaN(options.startDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid startDate format. Use ISO date format (YYYY-MM-DD)'
        });
      }

      const result = await unlockVolumeService.generateUnlockProjection(options);
      
      res.json(result);
    } catch (error) {
      logger.error('Error generating unlock projection:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/unlock-volume/current-stats
// Get current unlock statistics
router.get(
  '/current-stats',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const {
        tokenAddress,
        orgId,
        vaultTags
      } = req.query;

      const filters = {
        tokenAddress: tokenAddress || undefined,
        orgId: orgId || undefined,
        vaultTags: vaultTags ? (Array.isArray(vaultTags) ? vaultTags : vaultTags.split(',')) : undefined
      };

      const result = await unlockVolumeService.getCurrentUnlockStats(filters);
      
      res.json(result);
    } catch (error) {
      logger.error('Error getting current unlock stats:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/unlock-volume/chart-data
// Get formatted chart data for frontend visualization
router.get(
  '/chart-data',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const {
        tokenAddress,
        orgId,
        vaultTags,
        months = 12,
        startDate,
        chartType = 'daily' // daily, weekly, monthly
      } = req.query;

      const options = {
        tokenAddress: tokenAddress || undefined,
        orgId: orgId || undefined,
        vaultTags: vaultTags ? (Array.isArray(vaultTags) ? vaultTags : vaultTags.split(',')) : undefined,
        months: parseInt(months) || 12,
        startDate: startDate ? new Date(startDate) : new Date()
      };

      const projection = await unlockVolumeService.generateUnlockProjection(options);
      
      // Format data for different chart types
      const chartData = formatChartData(projection.data.projection, chartType);
      
      res.json({
        success: true,
        data: {
          chartData,
          chartType,
          insights: projection.data.insights,
          metadata: projection.data.metadata
        }
      });
    } catch (error) {
      logger.error('Error generating chart data:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/unlock-volume/risk-analysis
// Get detailed risk analysis and recommendations
router.get(
  '/risk-analysis',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const {
        tokenAddress,
        orgId,
        vaultTags,
        months = 12,
        startDate
      } = req.query;

      const options = {
        tokenAddress: tokenAddress || undefined,
        orgId: orgId || undefined,
        vaultTags: vaultTags ? (Array.isArray(vaultTags) ? vaultTags : vaultTags.split(',')) : undefined,
        months: parseInt(months) || 12,
        startDate: startDate ? new Date(startDate) : new Date()
      };

      const projection = await unlockVolumeService.generateUnlockProjection(options);
      const insights = projection.data.insights;
      
      // Enhanced risk analysis
      const riskAnalysis = {
        overallRisk: calculateOverallRisk(insights),
        criticalPeriods: insights.riskPeriods.filter(p => p.riskLevel === 'critical'),
        highRiskPeriods: insights.riskPeriods.filter(p => p.riskLevel === 'high'),
        recommendations: insights.recommendations,
        riskMetrics: {
          totalRiskPeriods: insights.riskPeriods.length,
          averageRiskPeriodDuration: insights.riskPeriods.length > 0 ? 
            insights.riskPeriods.reduce((sum, p) => sum + p.days, 0) / insights.riskPeriods.length : 0,
          peakUnlockVolume: insights.summary.peakUnlockDay?.amount || '0',
          volatilityIndex: calculateVolatilityIndex(insights)
        }
      };

      res.json({
        success: true,
        data: {
          riskAnalysis,
          insights,
          metadata: projection.data.metadata
        }
      });
    } catch (error) {
      logger.error('Error generating risk analysis:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/unlock-volume/export
// Export unlock data as CSV or JSON
router.get(
  '/export',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const {
        tokenAddress,
        orgId,
        vaultTags,
        months = 12,
        startDate,
        format = 'json' // json, csv
      } = req.query;

      const options = {
        tokenAddress: tokenAddress || undefined,
        orgId: orgId || undefined,
        vaultTags: vaultTags ? (Array.isArray(vaultTags) ? vaultTags : vaultTags.split(',')) : undefined,
        months: parseInt(months) || 12,
        startDate: startDate ? new Date(startDate) : new Date()
      };

      const projection = await unlockVolumeService.generateUnlockProjection(options);
      
      if (format === 'csv') {
        // Convert to CSV and send
        const csv = convertToCSV(projection.data);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="unlock-projection-${new Date().toISOString().split('T')[0]}.csv"`);
        res.send(csv);
      } else {
        // Send JSON
        res.json(projection);
      }
    } catch (error) {
      logger.error('Error exporting unlock data:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// Helper functions

/**
 * Format projection data for different chart types
 * @param {Object} projection - Raw projection data
 * @param {string} chartType - daily, weekly, or monthly
 * @returns {Object} Formatted chart data
 */
function formatChartData(projection, chartType) {
  const dailyData = Object.values(projection);
  
  switch (chartType) {
    case 'weekly':
      return formatWeeklyData(dailyData);
    case 'monthly':
      return formatMonthlyData(dailyData);
    default:
      return formatDailyData(dailyData);
  }
}

/**
 * Format data for daily charts
 * @param {Array} dailyData - Daily unlock data
 * @returns {Object} Daily chart data
 */
function formatDailyData(dailyData) {
  return {
    labels: dailyData.map(day => day.date),
    datasets: [
      {
        label: 'Total Daily Unlocks',
        data: dailyData.map(day => parseFloat(day.totalUnlockAmount)),
        borderColor: 'rgb(75, 192, 192)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        tension: 0.1
      },
      {
        label: 'Cliff Unlocks',
        data: dailyData.map(day => parseFloat(day.cliffUnlocks)),
        borderColor: 'rgb(255, 99, 132)',
        backgroundColor: 'rgba(255, 99, 132, 0.2)',
        tension: 0.1
      },
      {
        label: 'Vesting Unlocks',
        data: dailyData.map(day => parseFloat(day.vestingUnlocks)),
        borderColor: 'rgb(54, 162, 235)',
        backgroundColor: 'rgba(54, 162, 235, 0.2)',
        tension: 0.1
      }
    ],
    cumulativeData: dailyData.map(day => parseFloat(day.cumulativeUnlocked))
  };
}

/**
 * Format data for weekly charts
 * @param {Array} dailyData - Daily unlock data
 * @returns {Object} Weekly chart data
 */
function formatWeeklyData(dailyData) {
  const weeklyData = {};
  
  for (const day of dailyData) {
    const weekStart = new Date(day.date);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Start of week
    const weekKey = weekStart.toISOString().split('T')[0];
    
    if (!weeklyData[weekKey]) {
      weeklyData[weekKey] = {
        weekStart: weekKey,
        totalUnlocks: 0,
        cliffUnlocks: 0,
        vestingUnlocks: 0,
        days: []
      };
    }
    
    weeklyData[weekKey].totalUnlocks += parseFloat(day.totalUnlockAmount);
    weeklyData[weekKey].cliffUnlocks += parseFloat(day.cliffUnlocks);
    weeklyData[weekKey].vestingUnlocks += parseFloat(day.vestingUnlocks);
    weeklyData[weekKey].days.push(day.date);
  }

  const weeks = Object.values(weeklyData);
  
  return {
    labels: weeks.map(week => `Week of ${week.weekStart}`),
    datasets: [
      {
        label: 'Weekly Total Unlocks',
        data: weeks.map(week => week.totalUnlocks),
        backgroundColor: 'rgba(75, 192, 192, 0.6)',
        borderColor: 'rgb(75, 192, 192)',
        borderWidth: 1
      },
      {
        label: 'Weekly Cliff Unlocks',
        data: weeks.map(week => week.cliffUnlocks),
        backgroundColor: 'rgba(255, 99, 132, 0.6)',
        borderColor: 'rgb(255, 99, 132)',
        borderWidth: 1
      }
    ]
  };
}

/**
 * Format data for monthly charts
 * @param {Array} dailyData - Daily unlock data
 * @returns {Object} Monthly chart data
 */
function formatMonthlyData(dailyData) {
  const monthlyData = {};
  
  for (const day of dailyData) {
    const monthKey = day.date.substring(0, 7); // YYYY-MM
    
    if (!monthlyData[monthKey]) {
      monthlyData[monthKey] = {
        month: monthKey,
        totalUnlocks: 0,
        cliffUnlocks: 0,
        vestingUnlocks: 0,
        activeDays: 0
      };
    }
    
    monthlyData[monthKey].totalUnlocks += parseFloat(day.totalUnlockAmount);
    monthlyData[monthKey].cliffUnlocks += parseFloat(day.cliffUnlocks);
    monthlyData[monthKey].vestingUnlocks += parseFloat(day.vestingUnlocks);
    
    if (parseFloat(day.totalUnlockAmount) > 0) {
      monthlyData[monthKey].activeDays++;
    }
  }

  const months = Object.values(monthlyData);
  
  return {
    labels: months.map(month => {
      const date = new Date(month.month + '-01');
      return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    }),
    datasets: [
      {
        label: 'Monthly Total Unlocks',
        data: months.map(month => month.totalUnlocks),
        backgroundColor: 'rgba(75, 192, 192, 0.6)',
        borderColor: 'rgb(75, 192, 192)',
        borderWidth: 1
      },
      {
        label: 'Monthly Cliff Unlocks',
        data: months.map(month => month.cliffUnlocks),
        backgroundColor: 'rgba(255, 99, 132, 0.6)',
        borderColor: 'rgb(255, 99, 132)',
        borderWidth: 1
      }
    ]
  };
}

/**
 * Calculate overall risk level
 * @param {Object} insights - Projection insights
 * @returns {string} Overall risk level
 */
function calculateOverallRisk(insights) {
  const criticalPeriods = insights.riskPeriods.filter(p => p.riskLevel === 'critical').length;
  const highRiskPeriods = insights.riskPeriods.filter(p => p.riskLevel === 'high').length;
  
  if (criticalPeriods > 0) return 'critical';
  if (highRiskPeriods > 2) return 'high';
  if (highRiskPeriods > 0) return 'medium';
  return 'low';
}

/**
 * Calculate volatility index
 * @param {Object} insights - Projection insights
 * @returns {number} Volatility index (0-100)
 */
function calculateVolatilityIndex(insights) {
  const totalUnlocks = parseFloat(insights.summary.totalProjectedUnlocks);
  const peakDay = parseFloat(insights.summary.peakUnlockDay?.amount || 0);
  const avgDaily = parseFloat(insights.summary.averageDailyUnlocks);
  
  if (avgDaily === 0) return 0;
  
  // Simple volatility calculation based on peak vs average
  const volatility = ((peakDay - avgDaily) / avgDaily) * 100;
  return Math.min(Math.max(volatility, 0), 100); // Clamp between 0-100
}

/**
 * Convert projection data to CSV format
 * @param {Object} data - Projection data
 * @returns {string} CSV string
 */
function convertToCSV(data) {
  const headers = [
    'Date',
    'Total Unlock Amount',
    'Cliff Unlocks',
    'Vesting Unlocks',
    'Cumulative Unlocked',
    'Top Vault Address',
    'Top Vault Amount'
  ];
  
  const rows = Object.values(data.projection).map(day => [
    day.date,
    day.totalUnlockAmount,
    day.cliffUnlocks,
    day.vestingUnlocks,
    day.cumulativeUnlocked,
    day.topVaults[0]?.vaultAddress || '',
    day.topVaults[0]?.amount || ''
  ]);
  
  return [headers, ...rows]
    .map(row => row.map(cell => `"${cell}"`).join(','))
    .join('\n');
}

module.exports = router;
