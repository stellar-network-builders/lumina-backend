const logger = require('../utils/logger');
const { Vault, SubSchedule, Token } = require('../models');
const { Op } = require('sequelize');

class UnlockProjectionService {
  /**
   * Project future token unlocks for a given period
   * @param {Object} options - Projection options
   * @returns {Promise<Object>} Projection data
   */
  async projectUnlocks(options = {}) {
    const {
      tokenAddress = null,
      organizationId = null,
      startDate = new Date(),
      endDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // Default 1 year
      groupBy = 'month' // 'day', 'week', 'month', 'quarter'
    } = options;

    try {
      const whereClause = { is_active: true };
      if (tokenAddress) whereClause.token_address = tokenAddress;
      if (organizationId) whereClause.org_id = organizationId;

      // Get all active vaults
      const vaults = await Vault.findAll({
        where: whereClause,
        include: [
          {
            model: SubSchedule,
            as: 'subSchedules',
            where: { is_active: true }
          },
          {
            model: Token,
            as: 'token'
          }
        ]
      });

      if (vaults.length === 0) {
        return {
          projection: [],
          summary: { totalToUnlock: 0, tokenAddress, organizationId }
        };
      }

      const projectionMap = new Map();
      let totalToUnlock = 0;

      // Process each vault and sub-schedule
      for (const vault of vaults) {
        for (const subSchedule of vault.subSchedules) {
          const scheduleUnlocks = this.calculateScheduleUnlocksInPeriod(
            subSchedule,
            startDate,
            endDate,
            groupBy
          );

          for (const unlock of scheduleUnlocks) {
            const key = unlock.period;
            if (!projectionMap.has(key)) {
              projectionMap.set(key, {
                period: key,
                amount: 0,
                tokenAddress: vault.token_address,
                tokenSymbol: vault.token?.symbol
              });
            }
            const periodData = projectionMap.get(key);
            periodData.amount += unlock.amount;
            totalToUnlock += unlock.amount;
          }
        }
      }

      // Convert Map to array and sort by period
      const projection = Array.from(projectionMap.values()).sort((a, b) => 
        a.period.localeCompare(b.period)
      );

      return {
        projection,
        summary: {
          totalToUnlock,
          period: { startDate, endDate },
          tokenAddress,
          organizationId,
          generatedAt: new Date()
        }
      };
    } catch (error) {
      logger.error('Error projecting unlocks:', error);
      throw error;
    }
  }

  /**
   * Calculate unlocks for a specific sub-schedule in the given period
   * @private
   */
  calculateScheduleUnlocksInPeriod(subSchedule, startDate, endDate, groupBy) {
    const unlocks = [];
    const totalAmount = parseFloat(subSchedule.top_up_amount);
    const vStart = new Date(subSchedule.vesting_start_date);
    const vEnd = new Date(subSchedule.end_timestamp);
    const cliff = subSchedule.cliff_date ? new Date(subSchedule.cliff_date) : null;
    const duration = (vEnd - vStart);

    if (duration <= 0) return unlocks;

    // We want to find the change in vested amount over small intervals within [startDate, endDate]
    const interval = this.getIntervalMs(groupBy);
    let current = new Date(Math.max(startDate, vStart));
    
    // Align current to the start of the period
    current = this.alignToPeriod(current, groupBy);

    while (current < endDate && current < vEnd) {
      const intervalEnd = new Date(current.getTime() + interval);
      
      // Amount vested at start of interval
      const amountAtStart = this.calculateVestedAt(subSchedule, current);
      // Amount vested at end of interval (capped by endDate and vEnd)
      const effectiveEnd = new Date(Math.min(intervalEnd, endDate, vEnd));
      const amountAtEnd = this.calculateVestedAt(subSchedule, effectiveEnd);

      const unlockedInPeriod = amountAtEnd - amountAtStart;

      if (unlockedInPeriod > 0) {
        unlocks.push({
          period: this.formatPeriodKey(current, groupBy),
          amount: unlockedInPeriod
        });
      }

      current = intervalEnd;
    }

    return unlocks;
  }

  /**
   * Calculate vested amount at a specific timestamp
   * @private
   */
  calculateVestedAt(subSchedule, date) {
    const totalAmount = parseFloat(subSchedule.top_up_amount);
    const vStart = new Date(subSchedule.vesting_start_date);
    const vEnd = new Date(subSchedule.end_timestamp);
    const cliff = subSchedule.cliff_date ? new Date(subSchedule.cliff_date) : null;

    if (date < vStart) return 0;
    if (cliff && date < cliff) return 0;
    if (date >= vEnd) return totalAmount;

    const duration = vEnd - vStart;
    const elapsed = date - vStart;
    return (totalAmount * elapsed) / duration;
  }

  getIntervalMs(groupBy) {
    switch (groupBy) {
      case 'day': return 24 * 60 * 60 * 1000;
      case 'week': return 7 * 24 * 60 * 60 * 1000;
      case 'month': return 30 * 24 * 60 * 60 * 1000; // Approximation
      case 'quarter': return 90 * 24 * 60 * 60 * 1000; // Approximation
      default: return 30 * 24 * 60 * 60 * 1000;
    }
  }

  alignToPeriod(date, groupBy) {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    if (groupBy === 'week') {
      const day = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() - day);
    } else if (groupBy === 'month') {
      d.setUTCDate(1);
    } else if (groupBy === 'quarter') {
      d.setUTCDate(1);
      const month = d.getUTCMonth();
      d.setUTCMonth(month - (month % 3));
    }
    return d;
  }

  formatPeriodKey(date, groupBy) {
    const d = new Date(date);
    const y = d.getUTCFullYear();
    const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = d.getUTCDate().toString().padStart(2, '0');

    if (groupBy === 'day') return `${y}-${m}-${day}`;
    if (groupBy === 'week') return `${y}-W${this.getWeekNumber(d)}`;
    if (groupBy === 'month') return `${y}-${m}`;
    if (groupBy === 'quarter') return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    return `${y}-${m}`;
  }

  getWeekNumber(d) {
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return weekNo;
  }
}

module.exports = new UnlockProjectionService();
