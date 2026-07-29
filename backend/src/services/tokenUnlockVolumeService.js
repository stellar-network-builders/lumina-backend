'use strict';

const { Vault, SubSchedule, Beneficiary } = require('../models');
const { sequelize } = require('../database/connection');
const { Op } = require('sequelize');

class TokenUnlockVolumeService {
  constructor() {
    this.defaultProjectionMonths = 12;
  }

  /**
   * Generate 12-month unlock volume projection
   * @param {Object} options - Query options
   * @param {string} options.tokenAddress - Filter by specific token address
   * @param {string} options.orgId - Filter by organization
   * @param {Array} options.vaultTags - Filter by vault tags
   * @param {number} options.months - Number of months to project (default: 12)
   * @param {Date} options.startDate - Start date for projection (default: today)
   * @returns {Promise<Object>} Projection data with daily unlock volumes
   */
  async generateUnlockProjection(options = {}) {
    try {
      const {
        tokenAddress,
        orgId,
        vaultTags,
        months = this.defaultProjectionMonths,
      } = options;

      // Default/validate the start date — coerce missing or invalid input to today.
      let startDate = options.startDate ? new Date(options.startDate) : new Date();
      if (isNaN(startDate.getTime())) {
        startDate = new Date();
      }

      // Get all active vaults with their schedules
      const vaults = await this.getVaultsWithSchedules({
        tokenAddress,
        orgId,
        vaultTags
      });

      // Calculate daily unlock volumes for the projection period
      const projectionData = this.calculateDailyUnlocks(vaults, startDate, months);

      // Aggregate insights
      const insights = this.generateInsights(projectionData);

      return {
        success: true,
        data: {
          projection: projectionData,
          insights,
          metadata: {
            totalVaults: vaults.length,
            projectionPeriod: months,
            startDate: startDate.toISOString(),
            endDate: new Date(startDate.getTime() + (months * 30 * 24 * 60 * 60 * 1000)).toISOString(),
            filters: {
              tokenAddress,
              orgId,
              vaultTags
            }
          }
        }
      };

    } catch (error) {
      console.error('Error generating unlock projection:', error);
      throw error;
    }
  }

  /**
   * Get vaults with their sub-schedules for unlock calculations
   * @param {Object} filters - Filter criteria
   * @returns {Promise<Array>} Array of vaults with schedules
   */
  async getVaultsWithSchedules(filters = {}) {
    const { tokenAddress, orgId, vaultTags } = filters;

    const whereClause = {
      is_active: true,
      is_blacklisted: false
    };

    if (tokenAddress) {
      whereClause.token_address = tokenAddress;
    }

    if (orgId) {
      whereClause.org_id = orgId;
    }

    if (vaultTags && vaultTags.length > 0) {
      whereClause.tag = { [Op.in]: vaultTags };
    }

    const vaults = await Vault.findAll({
      where: whereClause,
      include: [
        {
          model: SubSchedule,
          as: 'subSchedules',
          where: { is_active: true },
          include: [
            {
              model: Beneficiary,
              as: 'beneficiaries'
            }
          ]
        }
      ]
    });

    return vaults;
  }

  /**
   * Calculate daily unlock volumes for projection period
   * @param {Array} vaults - Array of vaults with schedules
   * @param {Date} startDate - Projection start date
   * @param {number} months - Number of months to project
   * @returns {Object} Daily unlock data
   */
  calculateDailyUnlocks(vaults, startDate, months) {
    const dailyUnlocks = {};
    const endDate = new Date(startDate.getTime() + (months * 30 * 24 * 60 * 60 * 1000));
    
    // Initialize daily data
    for (let date = new Date(startDate); date <= endDate; date.setDate(date.getDate() + 1)) {
      const dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD format
      dailyUnlocks[dateKey] = {
        date: dateKey,
        totalUnlockAmount: '0',
        cliffUnlocks: '0',
        vestingUnlocks: '0',
        vaultBreakdown: [],
        topVaults: [],
        cumulativeUnlocked: '0'
      };
    }

    let cumulativeUnlocked = 0;

    // Process each vault's schedules
    for (const vault of vaults) {
      for (const schedule of vault.subSchedules) {
        const unlockEvents = this.calculateScheduleUnlocks(schedule, startDate, endDate);
        
        for (const event of unlockEvents) {
          const dateKey = event.date.toISOString().split('T')[0];
          
          if (dailyUnlocks[dateKey]) {
            // Add to daily totals
            const totalAmount = parseFloat(dailyUnlocks[dateKey].totalUnlockAmount) + parseFloat(event.amount);
            dailyUnlocks[dateKey].totalUnlockAmount = totalAmount.toFixed(7);
            
            // Categorize unlock type
            if (event.type === 'cliff') {
              const cliffAmount = parseFloat(dailyUnlocks[dateKey].cliffUnlocks) + parseFloat(event.amount);
              dailyUnlocks[dateKey].cliffUnlocks = cliffAmount.toFixed(7);
            } else {
              const vestingAmount = parseFloat(dailyUnlocks[dateKey].vestingUnlocks) + parseFloat(event.amount);
              dailyUnlocks[dateKey].vestingUnlocks = vestingAmount.toFixed(7);
            }

            // Add to vault breakdown
            dailyUnlocks[dateKey].vaultBreakdown.push({
              vaultAddress: vault.address,
              vaultName: vault.name || vault.address,
              vaultTag: vault.tag,
              amount: event.amount,
              type: event.type,
              beneficiaryCount: schedule.beneficiaries ? schedule.beneficiaries.length : 0
            });
          }
        }
      }
    }

    // Calculate cumulative totals and top vaults for each day
    const sortedDates = Object.keys(dailyUnlocks).sort();
    for (const dateKey of sortedDates) {
      const dayData = dailyUnlocks[dateKey];
      cumulativeUnlocked += parseFloat(dayData.totalUnlockAmount);
      dayData.cumulativeUnlocked = cumulativeUnlocked.toFixed(7);

      // Sort vaults by unlock amount for this day
      dayData.vaultBreakdown.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
      dayData.topVaults = dayData.vaultBreakdown.slice(0, 5); // Top 5 vaults for the day
    }

    return dailyUnlocks;
  }

  /**
   * Calculate unlock events for a specific schedule within date range
   * @param {Object} schedule - SubSchedule object
   * @param {Date} startDate - Start date for calculation
   * @param {Date} endDate - End date for calculation
   * @returns {Array} Array of unlock events
   */
  calculateScheduleUnlocks(schedule, startDate, endDate) {
    const unlockEvents = [];
    const { 
      cliff_date, 
      vesting_start_date, 
      vesting_duration, 
      cliff_duration,
      top_up_amount,
      amount_withdrawn 
    } = schedule;

    const remainingAmount = parseFloat(top_up_amount) - parseFloat(amount_withdrawn);
    if (remainingAmount <= 0) {
      return unlockEvents; // No remaining tokens to unlock
    }

    // Calculate cliff unlock
    if (cliff_date) {
      const cliffDate = new Date(cliff_date);
      if (cliffDate >= startDate && cliffDate <= endDate) {
        const cliffAmount = this.calculateCliffAmount(schedule);
        if (cliffAmount > 0) {
          unlockEvents.push({
            date: cliffDate,
            amount: cliffAmount.toFixed(7),
            type: 'cliff'
          });
        }
      }
    }

    // Calculate daily vesting unlocks
    const vestingStart = new Date(vesting_start_date);
    const vestingEnd = new Date(vestingStart.getTime() + (vesting_duration * 1000));
    const dailyVestingRate = remainingAmount / (vesting_duration / (24 * 60 * 60)); // tokens per second

    // Generate daily vesting events
    for (let date = new Date(Math.max(startDate, vestingStart)); 
         date <= endDate && date <= vestingEnd; 
         date.setDate(date.getDate() + 1)) {
      
      // Skip if before cliff
      if (cliff_date && date < new Date(cliff_date)) {
        continue;
      }

      const dailyUnlock = dailyVestingRate * 24 * 60 * 60; // tokens per day
      unlockEvents.push({
        date: new Date(date),
        amount: dailyUnlock.toFixed(7),
        type: 'vesting'
      });
    }

    return unlockEvents;
  }

  /**
   * Calculate cliff unlock amount for a schedule
   * @param {Object} schedule - SubSchedule object
   * @returns {number} Cliff unlock amount
   */
  calculateCliffAmount(schedule) {
    const { top_up_amount, cliff_duration, vesting_duration } = schedule;
    
    // Cliff typically releases a percentage (e.g., 25%) of total tokens
    const cliffPercentage = 0.25; // Default 25% cliff - this could be configurable
    const cliffAmount = parseFloat(top_up_amount) * cliffPercentage;
    
    return cliffAmount;
  }

  /**
   * Generate insights from projection data
   * @param {Object} projectionData - Daily unlock projection data
   * @returns {Object} Insights and analytics
   */
  generateInsights(projectionData) {
    const dailyValues = Object.values(projectionData);
    const totalUnlocks = dailyValues.reduce((sum, day) => sum + parseFloat(day.totalUnlockAmount), 0);
    
    // Find peak unlock days
    const sortedByVolume = [...dailyValues].sort((a, b) => 
      parseFloat(b.totalUnlockAmount) - parseFloat(a.totalUnlockAmount)
    );
    
    const topUnlockDays = sortedByVolume.slice(0, 10).map(day => ({
      date: day.date,
      amount: day.totalUnlockAmount,
      type: parseFloat(day.cliffUnlocks) > parseFloat(day.vestingUnlocks) ? 'cliff_heavy' : 'vesting_heavy'
    }));

    // Calculate monthly aggregates
    const monthlyAggregates = this.calculateMonthlyAggregates(projectionData);

    // Identify risk periods (high unlock volume)
    const riskPeriods = this.identifyRiskPeriods(projectionData);

    // Calculate average daily unlocks
    const activeDays = dailyValues.filter(day => parseFloat(day.totalUnlockAmount) > 0);
    const avgDailyUnlocks = activeDays.length > 0 ? 
      (totalUnlocks / activeDays.length).toFixed(7) : '0';

    return {
      summary: {
        totalProjectedUnlocks: totalUnlocks.toFixed(7),
        averageDailyUnlocks: avgDailyUnlocks,
        peakUnlockDay: sortedByVolume[0] ? {
          date: sortedByVolume[0].date,
          amount: sortedByVolume[0].totalUnlockAmount
        } : null,
        totalActiveDays: activeDays.length,
        totalProjectionDays: dailyValues.length
      },
      topUnlockDays,
      monthlyAggregates,
      riskPeriods,
      recommendations: this.generateRecommendations(riskPeriods, topUnlockDays)
    };
  }

  /**
   * Calculate monthly aggregates from daily data
   * @param {Object} projectionData - Daily unlock data
   * @returns {Array} Monthly aggregates
   */
  calculateMonthlyAggregates(projectionData) {
    const monthlyData = {};

    for (const dayData of Object.values(projectionData)) {
      const month = dayData.date.substring(0, 7); // YYYY-MM format
      
      if (!monthlyData[month]) {
        monthlyData[month] = {
          month,
          totalUnlocks: '0',
          cliffUnlocks: '0',
          vestingUnlocks: '0',
          activeDays: 0,
          peakDay: null,
          peakAmount: '0'
        };
      }

      const monthData = monthlyData[month];
      monthData.totalUnlocks = (
        parseFloat(monthData.totalUnlocks) + parseFloat(dayData.totalUnlockAmount)
      ).toFixed(7);
      monthData.cliffUnlocks = (
        parseFloat(monthData.cliffUnlocks) + parseFloat(dayData.cliffUnlocks)
      ).toFixed(7);
      monthData.vestingUnlocks = (
        parseFloat(monthData.vestingUnlocks) + parseFloat(dayData.vestingUnlocks)
      ).toFixed(7);

      if (parseFloat(dayData.totalUnlockAmount) > 0) {
        monthData.activeDays++;
      }

      if (parseFloat(dayData.totalUnlockAmount) > parseFloat(monthData.peakAmount)) {
        monthData.peakDay = dayData.date;
        monthData.peakAmount = dayData.totalUnlockAmount;
      }
    }

    return Object.values(monthlyData);
  }

  /**
   * Identify risk periods with high unlock volumes
   * @param {Object} projectionData - Daily unlock data
   * @returns {Array} Risk periods
   */
  identifyRiskPeriods(projectionData) {
    const dailyValues = Object.values(projectionData);
    const amounts = dailyValues.map(day => parseFloat(day.totalUnlockAmount));
    
    // Calculate statistical measures
    const mean = amounts.reduce((sum, val) => sum + val, 0) / amounts.length;
    const variance = amounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / amounts.length;
    const stdDev = Math.sqrt(variance);
    
    // Define risk threshold as mean + 2 * standard deviation
    const riskThreshold = mean + (2 * stdDev);
    
    // Find periods exceeding threshold
    const riskPeriods = [];
    let currentPeriod = null;

    for (const dayData of dailyValues) {
      const amount = parseFloat(dayData.totalUnlockAmount);
      
      if (amount > riskThreshold) {
        if (!currentPeriod) {
          currentPeriod = {
            startDate: dayData.date,
            endDate: dayData.date,
            peakAmount: amount,
            totalUnlocks: amount,
            days: 1
          };
        } else {
          currentPeriod.endDate = dayData.date;
          currentPeriod.totalUnlocks += amount;
          currentPeriod.days++;
          if (amount > parseFloat(currentPeriod.peakAmount)) {
            currentPeriod.peakAmount = amount;
          }
        }
      } else {
        if (currentPeriod) {
          riskPeriods.push(currentPeriod);
          currentPeriod = null;
        }
      }
    }

    if (currentPeriod) {
      riskPeriods.push(currentPeriod);
    }

    return riskPeriods.map(period => ({
      ...period,
      // Emit amounts as fixed-precision strings, consistent with every other
      // amount this service returns (the raw accumulator values are numbers).
      peakAmount: period.peakAmount.toFixed(7),
      totalUnlocks: period.totalUnlocks.toFixed(7),
      averageDailyUnlocks: (period.totalUnlocks / period.days).toFixed(7),
      riskLevel: this.calculateRiskLevel(period.totalUnlocks, mean, stdDev)
    }));
  }

  /**
   * Calculate risk level for a period
   * @param {number} totalUnlocks - Total unlocks in period
   * @param {number} mean - Mean daily unlocks
   * @param {number} stdDev - Standard deviation
   * @returns {string} Risk level
   */
  calculateRiskLevel(totalUnlocks, mean, stdDev) {
    const zScore = (totalUnlocks - mean) / stdDev;
    
    if (zScore > 3) return 'critical';
    if (zScore > 2) return 'high';
    if (zScore > 1) return 'medium';
    return 'low';
  }

  /**
   * Generate recommendations based on risk analysis
   * @param {Array} riskPeriods - Identified risk periods
   * @param {Array} topUnlockDays - Top unlock days
   * @returns {Array} Recommendations
   */
  generateRecommendations(riskPeriods, topUnlockDays) {
    const recommendations = [];

    // Analyze cliff events
    const cliffHeavyDays = topUnlockDays.filter(day => day.type === 'cliff_heavy');
    if (cliffHeavyDays.length > 0) {
      recommendations.push({
        type: 'cliff_management',
        priority: 'high',
        title: 'Major Cliff Events Detected',
        description: `${cliffHeavyDays.length} significant cliff unlock events identified. Consider preparing liquidity or buy-back programs.`,
        actionItems: [
          'Schedule buy-back programs before major cliff dates',
          'Prepare community announcements in advance',
          'Consider staggered cliff releases if possible'
        ],
        affectedDates: cliffHeavyDays.map(day => day.date)
      });
    }

    // Analyze risk periods
    if (riskPeriods.length > 0) {
      const criticalPeriods = riskPeriods.filter(period => period.riskLevel === 'critical');
      if (criticalPeriods.length > 0) {
        recommendations.push({
          type: 'risk_mitigation',
          priority: 'critical',
          title: 'Critical Unlock Pressure Periods',
          description: `${criticalPeriods.length} periods with extremely high unlock volume detected.`,
          actionItems: [
            'Implement market maker support during these periods',
            'Prepare treasury for potential buy-back operations',
            'Coordinate with exchanges for liquidity support',
            'Consider temporary incentive programs'
          ],
          affectedPeriods: criticalPeriods
        });
      }
    }

    // General recommendations
    recommendations.push({
      type: 'general_strategy',
      priority: 'medium',
      title: 'Ongoing Market Protection Strategy',
      description: 'Implement continuous monitoring and strategic planning.',
      actionItems: [
        'Set up automated alerts for unlock volume spikes',
        'Maintain treasury reserves for buy-back operations',
        'Regular community communication about unlock schedules',
        'Monitor trading volumes during unlock events'
      ]
    });

    return recommendations;
  }

  /**
   * Get current unlock statistics (real-time data)
   * @param {Object} filters - Filter criteria
   * @returns {Promise<Object>} Current unlock statistics
   */
  async getCurrentUnlockStats(filters = {}) {
    try {
      const vaults = await this.getVaultsWithSchedules(filters);
      const today = new Date();
      const thirtyDaysAgo = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000));

      let recentUnlocks = 0;
      let totalUnlockedToDate = 0;
      let totalAllocated = 0;

      for (const vault of vaults) {
        for (const schedule of vault.subSchedules) {
          totalAllocated += parseFloat(schedule.top_up_amount);
          totalUnlockedToDate += parseFloat(schedule.amount_withdrawn);
          
          // Calculate recent unlocks (last 30 days)
          const recentEvents = this.calculateScheduleUnlocks(schedule, thirtyDaysAgo, today);
          recentUnlocks += recentEvents.reduce((sum, event) => sum + parseFloat(event.amount), 0);
        }
      }

      const remainingLocked = totalAllocated - totalUnlockedToDate;
      const unlockProgress = totalAllocated > 0 ? (totalUnlockedToDate / totalAllocated) * 100 : 0;

      return {
        success: true,
        data: {
          summary: {
            totalVaults: vaults.length,
            totalAllocated: totalAllocated.toFixed(7),
            totalUnlockedToDate: totalUnlockedToDate.toFixed(7),
            remainingLocked: remainingLocked.toFixed(7),
            unlockProgressPercentage: unlockProgress.toFixed(2),
            recentUnlocks30Days: recentUnlocks.toFixed(7)
          },
          lastUpdated: today.toISOString()
        }
      };

    } catch (error) {
      console.error('Error getting current unlock stats:', error);
      throw error;
    }
  }
}

module.exports = TokenUnlockVolumeService;
