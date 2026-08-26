const express = require('express');
const router = express.Router();
const {
  Vault,
  SubSchedule,
  Beneficiary,
  ClaimsHistory,
  Organization,
  Token,
  VestingMilestone
} = require('../models');
const { Op } = require('sequelize');
const cacheService = require('../services/cacheService');
const logger = require('../utils/logger');

/**
 * Get user's complete vesting history (optimized REST endpoint)
 */
router.get('/user/:userAddress/history', async (req, res) => {
  try {
    const { userAddress } = req.params;
    const {
      page = 1,
      limit = 50,
      sortBy = 'updatedAt',
      sortOrder = 'desc',
      status,
      dateFrom,
      dateTo
    } = req.query;

    // Validate pagination
    const parsedLimit = Math.min(parseInt(limit) || 50, 100);
    const parsedPage = Math.max(parseInt(page) || 1, 1);
    const offset = (parsedPage - 1) * parsedLimit;

    // Build cache key
    const cacheKey = `vesting_history_${userAddress}_${parsedPage}_${parsedLimit}_${sortBy}_${sortOrder}_${status || 'all'}_${dateFrom || ''}_${dateTo || ''}`;
    
    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        cached: true
      });
    }

    // Build where clause
    const whereClause = {
      '$vault.beneficiaries.address$': userAddress
    };

    // Add status filter
    if (status) {
      switch (status) {
        case 'active':
          whereClause.is_active = true;
          whereClause.end_timestamp = { [Op.gt]: new Date() };
          break;
        case 'completed':
          whereClause.end_timestamp = { [Op.lte]: new Date() };
          break;
        case 'cliff':
          whereClause.cliff_date = { [Op.gt]: new Date() };
          break;
      }
    }

    // Add date range filter
    if (dateFrom || dateTo) {
      const dateFilter = {};
      if (dateFrom) dateFilter[Op.gte] = new Date(dateFrom);
      if (dateTo) dateFilter[Op.lte] = new Date(dateTo);
      whereClause.createdAt = dateFilter;
    }

    // Execute optimized query
    const { count, rows: schedules } = await SubSchedule.findAndCountAll({
      where: whereClause,
      include: [
        {
          model: Vault,
          as: 'vault',
          attributes: ['id', 'address', 'name', 'owner_address', 'token_address'],
          include: [
            {
              model: Organization,
              as: 'organization',
              attributes: ['id', 'name']
            },
            {
              model: Token,
              as: 'token',
              attributes: ['address', 'symbol', 'decimals']
            }
          ]
        },
        {
          model: ClaimsHistory,
          as: 'claims',
          separate: true,
          order: [['claim_timestamp', 'DESC']],
          limit: 5 // Recent claims only
        }
      ],
      order: [[sortBy, sortOrder.toUpperCase()]],
      limit: parsedLimit,
      offset,
      subQuery: false
    });

    // Process and enrich data
    const now = new Date();
    const enrichedSchedules = schedules.map(schedule => {
      const isCliffPassed = !schedule.cliff_date || schedule.cliff_date <= now;
      const isFullyVested = schedule.end_timestamp <= now;
      
      let vestedAmount = '0';
      let withdrawableAmount = '0';
      let vestingProgress = 0;

      if (isCliffPassed) {
        const timePassed = Math.max(0, now - schedule.vesting_start_date);
        const totalVestingTime = schedule.vesting_duration * 1000;
        vestingProgress = Math.min(1, timePassed / totalVestingTime);
        vestedAmount = (parseFloat(schedule.top_up_amount) * vestingProgress).toString();
        withdrawableAmount = Math.max(0, parseFloat(vestedAmount) - parseFloat(schedule.amount_withdrawn)).toString();
      }

      return {
        id: schedule.id,
        vaultId: schedule.vault_id,
        vaultAddress: schedule.vault?.address,
        vaultName: schedule.vault?.name,
        tokenAddress: schedule.vault?.token_address,
        tokenSymbol: schedule.vault?.token?.symbol,
        ownerAddress: schedule.vault?.owner_address,
        organizationId: schedule.vault?.organization?.id,
        organizationName: schedule.vault?.organization?.name,
        beneficiaryAddress: userAddress,
        
        // Financial data
        totalAllocated: schedule.top_up_amount,
        totalWithdrawn: schedule.amount_withdrawn,
        remainingAmount: (parseFloat(schedule.top_up_amount) - parseFloat(schedule.amount_withdrawn)).toString(),
        vestedAmount,
        withdrawableAmount,
        
        // Schedule data
        topUpAmount: schedule.top_up_amount,
        cliffDuration: schedule.cliff_duration,
        cliffDate: schedule.cliff_date,
        vestingStartDate: schedule.vesting_start_date,
        vestingDuration: schedule.vesting_duration,
        startTimestamp: schedule.start_timestamp,
        endTimestamp: schedule.end_timestamp,
        
        // Status
        isActive: schedule.is_active,
        isFullyVested,
        isCliffPassed,
        vestingProgress,
        
        // Metadata
        createdAt: schedule.created_at,
        updatedAt: schedule.updated_at,
        blockNumber: schedule.block_number,
        transactionHash: schedule.transaction_hash,
        
        // Associated data
        claims: schedule.claims?.map(claim => ({
          id: claim.id,
          amountClaimed: claim.amount_claimed,
          claimTimestamp: claim.claim_timestamp,
          transactionHash: claim.transaction_hash,
          blockNumber: claim.block_number,
          priceAtClaimUsd: claim.price_at_claim_usd
        })) || []
      };
    });

    const result = {
      schedules: enrichedSchedules,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total: count,
        totalPages: Math.ceil(count / parsedLimit),
        hasNext: offset + parsedLimit < count,
        hasPrevious: parsedPage > 1
      }
    };

    // Cache the result (5 minutes)
    await cacheService.set(cacheKey, result, 300);

    res.json({
      success: true,
      data: result,
      cached: false
    });

  } catch (error) {
    logger.error('Error fetching vesting history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch vesting history'
    });
  }
});

/**
 * Get user's vesting summary
 */
router.get('/user/:userAddress/summary', async (req, res) => {
  try {
    const { userAddress } = req.params;
    
    // Build cache key
    const cacheKey = `vesting_summary_${userAddress}`;
    
    // Try to get from cache
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        cached: true
      });
    }

    // Get all schedules for the user
    const schedules = await SubSchedule.findAll({
      where: {
        '$vault.beneficiaries.address$': userAddress
      },
      include: [
        {
          model: Vault,
          as: 'vault',
          include: [
            {
              model: Organization,
              as: 'organization',
              attributes: ['id', 'name']
            },
            {
              model: Token,
              as: 'token',
              attributes: ['address', 'symbol', 'decimals']
            }
          ]
        },
        {
          model: ClaimsHistory,
          as: 'claims',
          separate: true,
          order: [['claim_timestamp', 'DESC']],
          limit: 10
        }
      ],
      subQuery: false
    });

    // Calculate summary
    const now = new Date();
    let totalAllocated = 0;
    let totalWithdrawn = 0;
    let activeVaults = 0;
    let completedVaults = 0;
    let totalProgress = 0;
    let nextClaimAmount = 0;
    let nextClaimTime = null;

    const recentClaims = [];
    const vaultsByToken = new Map();

    for (const schedule of schedules) {
      const isCliffPassed = !schedule.cliff_date || schedule.cliff_date <= now;
      const isFullyVested = schedule.end_timestamp <= now;
      const isActive = schedule.is_active && !isFullyVested;

      totalAllocated += parseFloat(schedule.top_up_amount);
      totalWithdrawn += parseFloat(schedule.amount_withdrawn);

      if (isActive) activeVaults++;
      if (isFullyVested) completedVaults++;

      // Calculate progress
      let progress = 0;
      if (isCliffPassed) {
        const timePassed = Math.max(0, now - schedule.vesting_start_date);
        const totalVestingTime = schedule.vesting_duration * 1000;
        progress = Math.min(1, timePassed / totalVestingTime);
        totalProgress += progress;

        const vestedAmount = parseFloat(schedule.top_up_amount) * progress;
        const withdrawable = Math.max(0, vestedAmount - parseFloat(schedule.amount_withdrawn));
        
        if (withdrawable > 0) {
          nextClaimAmount += withdrawable;
          if (!nextClaimTime || schedule.end_timestamp < nextClaimTime) {
            nextClaimTime = schedule.end_timestamp;
          }
        }
      }

      // Group by token
      const tokenSymbol = schedule.vault?.token?.symbol || 'UNKNOWN';
      if (!vaultsByToken.has(tokenSymbol)) {
        vaultsByToken.set(tokenSymbol, {
          tokenSymbol,
          tokenAddress: schedule.vault?.token?.address,
          vaults: [],
          totalAllocated: 0,
          totalWithdrawn: 0
        });
      }
      
      const tokenData = vaultsByToken.get(tokenSymbol);
      tokenData.vaults.push({
        id: schedule.id,
        vaultAddress: schedule.vault?.address,
        vaultName: schedule.vault?.name,
        progress,
        withdrawableAmount: isCliffPassed ? Math.max(0, parseFloat(schedule.top_up_amount) * progress - parseFloat(schedule.amount_withdrawn)) : 0
      });
      tokenData.totalAllocated += parseFloat(schedule.top_up_amount);
      tokenData.totalWithdrawn += parseFloat(schedule.amount_withdrawn);

      // Add recent claims
      if (schedule.claims) {
        recentClaims.push(...schedule.claims.map(claim => ({
          id: claim.id,
          vaultAddress: schedule.vault?.address,
          vaultName: schedule.vault?.name,
          tokenSymbol,
          amountClaimed: claim.amount_claimed,
          claimTimestamp: claim.claim_timestamp,
          transactionHash: claim.transaction_hash
        })));
      }
    }

    const totalRemaining = totalAllocated - totalWithdrawn;
    const averageProgress = schedules.length > 0 ? totalProgress / schedules.length : 0;

    // Sort recent claims and take latest 10
    recentClaims.sort((a, b) => new Date(b.claimTimestamp) - new Date(a.claimTimestamp));
    const latestClaims = recentClaims.slice(0, 10);

    const summary = {
      userAddress,
      totalVaults: schedules.length,
      activeVaults,
      completedVaults,
      
      // Financial summary
      totalAllocated: totalAllocated.toString(),
      totalWithdrawn: totalWithdrawn.toString(),
      totalRemaining: totalRemaining.toString(),
      totalValueUsd: '0', // TODO: Calculate based on current token prices
      
      // Performance metrics
      averageVestingProgress: averageProgress,
      nextClaimAmount: nextClaimAmount.toString(),
      nextClaimTime,
      
      // Token breakdown
      tokensByToken: Array.from(vaultsByToken.values()).map(token => ({
        ...token,
        totalAllocated: token.totalAllocated.toString(),
        totalWithdrawn: token.totalWithdrawn.toString(),
        totalRemaining: (token.totalAllocated - token.totalWithdrawn).toString()
      })),
      
      // Recent activity
      recentClaims: latestClaims
    };

    // Cache the result (2 minutes)
    await cacheService.set(cacheKey, summary, 120);

    res.json({
      success: true,
      data: summary,
      cached: false
    });

  } catch (error) {
    logger.error('Error fetching vesting summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch vesting summary'
    });
  }
});

/**
 * Get specific vesting schedule details
 */
router.get('/schedule/:scheduleId', async (req, res) => {
  try {
    const { scheduleId } = req.params;
    
    const cacheKey = `vesting_schedule_${scheduleId}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        cached: true
      });
    }

    const schedule = await SubSchedule.findByPk(scheduleId, {
      include: [
        {
          model: Vault,
          as: 'vault',
          include: [
            {
              model: Organization,
              as: 'organization',
              attributes: ['id', 'name']
            },
            {
              model: Token,
              as: 'token',
              attributes: ['address', 'symbol', 'decimals']
            },
            {
              model: Beneficiary,
              as: 'beneficiaries',
              attributes: ['address']
            }
          ]
        },
        {
          model: ClaimsHistory,
          as: 'claims',
          order: [['claim_timestamp', 'DESC']]
        },
        {
          model: VestingMilestone,
          as: 'milestones',
          order: [['targetDate', 'ASC']]
        }
      ]
    });

    if (!schedule) {
      return res.status(404).json({
        success: false,
        error: 'Vesting schedule not found'
      });
    }

    const now = new Date();
    const isCliffPassed = !schedule.cliff_date || schedule.cliff_date <= now;
    const isFullyVested = schedule.end_timestamp <= now;
    
    let vestedAmount = '0';
    let withdrawableAmount = '0';
    let vestingProgress = 0;

    if (isCliffPassed) {
      const timePassed = Math.max(0, now - schedule.vesting_start_date);
      const totalVestingTime = schedule.vesting_duration * 1000;
      vestingProgress = Math.min(1, timePassed / totalVestingTime);
      vestedAmount = (parseFloat(schedule.top_up_amount) * vestingProgress).toString();
      withdrawableAmount = Math.max(0, parseFloat(vestedAmount) - parseFloat(schedule.amount_withdrawn)).toString();
    }

    const enrichedSchedule = {
      id: schedule.id,
      vaultId: schedule.vault_id,
      vaultAddress: schedule.vault?.address,
      vaultName: schedule.vault?.name,
      tokenAddress: schedule.vault?.token_address,
      tokenSymbol: schedule.vault?.token?.symbol,
      tokenDecimals: schedule.vault?.token?.decimals,
      ownerAddress: schedule.vault?.owner_address,
      organizationId: schedule.vault?.organization?.id,
      organizationName: schedule.vault?.organization?.name,
      beneficiaryAddress: schedule.vault?.beneficiaries?.[0]?.address || null,
      
      // Financial data
      totalAllocated: schedule.top_up_amount,
      totalWithdrawn: schedule.amount_withdrawn,
      remainingAmount: (parseFloat(schedule.top_up_amount) - parseFloat(schedule.amount_withdrawn)).toString(),
      vestedAmount,
      withdrawableAmount,
      
      // Schedule data
      topUpAmount: schedule.top_up_amount,
      cliffDuration: schedule.cliff_duration,
      cliffDate: schedule.cliff_date,
      vestingStartDate: schedule.vesting_start_date,
      vestingDuration: schedule.vesting_duration,
      startTimestamp: schedule.start_timestamp,
      endTimestamp: schedule.end_timestamp,
      
      // Status
      isActive: schedule.is_active,
      isFullyVested,
      isCliffPassed,
      vestingProgress,
      
      // Metadata
      createdAt: schedule.created_at,
      updatedAt: schedule.updated_at,
      blockNumber: schedule.block_number,
      transactionHash: schedule.transaction_hash,
      
      // Associated data
      claims: schedule.claims?.map(claim => ({
        id: claim.id,
        amountClaimed: claim.amount_claimed,
        claimTimestamp: claim.claim_timestamp,
        transactionHash: claim.transaction_hash,
        blockNumber: claim.block_number,
        priceAtClaimUsd: claim.price_at_claim_usd,
        conversionEventId: claim.conversion_event_id
      })) || [],
      
      milestones: schedule.milestones?.map(milestone => ({
        id: milestone.id,
        milestoneType: milestone.milestone_type,
        description: milestone.description,
        targetDate: milestone.target_date,
        targetAmount: milestone.target_amount,
        isCompleted: milestone.is_completed,
        completedAt: milestone.completed_at,
        createdAt: milestone.created_at
      })) || []
    };

    // Cache the result (5 minutes)
    await cacheService.set(cacheKey, enrichedSchedule, 300);

    res.json({
      success: true,
      data: enrichedSchedule,
      cached: false
    });

  } catch (error) {
    logger.error('Error fetching vesting schedule:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch vesting schedule'
    });
  }
});

/**
 * Get claim history for a user
 */
router.get('/user/:userAddress/claims', async (req, res) => {
  try {
    const { userAddress } = req.params;
    const {
      page = 1,
      limit = 50,
      sortBy = 'claim_timestamp',
      sortOrder = 'desc',
      vaultId,
      dateFrom,
      dateTo
    } = req.query;

    const parsedLimit = Math.min(parseInt(limit) || 50, 100);
    const parsedPage = Math.max(parseInt(page) || 1, 1);
    const offset = (parsedPage - 1) * parsedLimit;

    // Build where clause
    const whereClause = { user_address: userAddress };
    
    if (vaultId) {
      whereClause[Op.and] = [
        sequelize.where(
          sequelize.literal(`EXISTS (
            SELECT 1 FROM sub_schedules ss 
            JOIN vaults v ON ss.vault_id = v.id 
            JOIN beneficiaries b ON v.id = b.vault_id 
            WHERE ss.id = claims_history.vault_id AND b.address = :userAddress
            AND ss.id = :vaultId
          )`),
          { userAddress, vaultId }
        )
      ];
    }

    // Add date range filter
    if (dateFrom || dateTo) {
      const dateFilter = {};
      if (dateFrom) dateFilter[Op.gte] = new Date(dateFrom);
      if (dateTo) dateFilter[Op.lte] = new Date(dateTo);
      whereClause.claim_timestamp = dateFilter;
    }

    const { count, rows: claims } = await ClaimsHistory.findAndCountAll({
      where: whereClause,
      order: [[sortBy, sortOrder.toUpperCase()]],
      limit: parsedLimit,
      offset,
      include: [
        {
          model: SubSchedule,
          as: 'subSchedule',
          attributes: ['vault_id'],
          include: [
            {
              model: Vault,
              as: 'vault',
              attributes: ['address', 'name'],
              include: [
                {
                  model: Token,
                  as: 'token',
                  attributes: ['address', 'symbol', 'decimals']
                }
              ]
            }
          ]
        }
      ]
    });

    const enrichedClaims = claims.map(claim => ({
      id: claim.id,
      userAddress: claim.user_address,
      tokenAddress: claim.token_address,
      vaultId: claim.subSchedule?.vault_id,
      vaultAddress: claim.subSchedule?.vault?.address,
      vaultName: claim.subSchedule?.vault?.name,
      tokenSymbol: claim.subSchedule?.vault?.token?.symbol,
      amountClaimed: claim.amount_claimed,
      claimTimestamp: claim.claim_timestamp,
      transactionHash: claim.transaction_hash,
      blockNumber: claim.block_number,
      priceAtClaimUsd: claim.price_at_claim_usd,
      conversionEventId: claim.conversion_event_id,
      usdValue: claim.price_at_claim_usd ? (parseFloat(claim.amount_claimed) * parseFloat(claim.price_at_claim_usd)).toString() : '0'
    }));

    const result = {
      claims: enrichedClaims,
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total: count,
        totalPages: Math.ceil(count / parsedLimit),
        hasNext: offset + parsedLimit < count,
        hasPrevious: parsedPage > 1
      }
    };

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('Error fetching claim history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch claim history'
    });
  }
});

/**
 * Get vesting statistics
 */
router.get('/statistics', async (req, res) => {
  try {
    const { organizationId, dateFrom, dateTo } = req.query;
    
    const cacheKey = `vesting_statistics_${organizationId || 'all'}_${dateFrom || ''}_${dateTo || ''}`;
    const cached = await cacheService.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        cached: true
      });
    }

    const whereClause = {};
    
    if (dateFrom || dateTo) {
      const dateFilter = {};
      if (dateFrom) dateFilter[Op.gte] = new Date(dateFrom);
      if (dateTo) dateFilter[Op.lte] = new Date(dateTo);
      whereClause.createdAt = dateFilter;
    }

    if (organizationId) {
      whereClause['$vault.organization_id$'] = organizationId;
    }

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [totalSchedules, activeSchedules, completedSchedules] = await Promise.all([
      SubSchedule.count({ where: whereClause }),
      SubSchedule.count({ 
        where: { 
          ...whereClause,
          is_active: true,
          end_timestamp: { [Op.gt]: now }
        }
      }),
      SubSchedule.count({ 
        where: { 
          ...whereClause,
          end_timestamp: { [Op.lte]: now }
        }
      })
    ]);

    const [totalAllocated, totalWithdrawn] = await Promise.all([
      SubSchedule.sum('top_up_amount', { where: whereClause }) || 0,
      SubSchedule.sum('amount_withdrawn', { where: whereClause }) || 0
    ]);

    const [claims24h, claims7d, claims30d] = await Promise.all([
      ClaimsHistory.count({
        where: {
          ...whereClause,
          claim_timestamp: { [Op.gte]: yesterday }
        }
      }),
      ClaimsHistory.count({
        where: {
          ...whereClause,
          claim_timestamp: { [Op.gte]: sevenDaysAgo }
        }
      }),
      ClaimsHistory.count({
        where: {
          ...whereClause,
          claim_timestamp: { [Op.gte]: thirtyDaysAgo }
        }
      })
    ]);

    const statistics = {
      totalVaults: totalSchedules,
      activeVaults: activeSchedules,
      completedVaults: completedSchedules,
      totalAllocated: totalAllocated.toString(),
      totalWithdrawn: totalWithdrawn.toString(),
      totalRemaining: (totalAllocated - totalWithdrawn).toString(),
      claimsLast24h: claims24h,
      claimsLast7d: claims7d,
      claimsLast30d: claims30d
    };

    // Cache the result (10 minutes)
    await cacheService.set(cacheKey, statistics, 600);

    res.json({
      success: true,
      data: statistics,
      cached: false
    });

  } catch (error) {
    logger.error('Error fetching vesting statistics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch vesting statistics'
    });
  }
});

/**
 * Clear cache for user data (admin endpoint)
 */
router.post('/user/:userAddress/cache/clear', async (req, res) => {
  try {
    const { userAddress } = req.params;
    
    // Clear all cache keys for this user
    const patterns = [
      `vesting_history_${userAddress}_*`,
      `vesting_summary_${userAddress}`,
      `vesting_schedule_*` // Will be cleared selectively
    ];

    for (const pattern of patterns) {
      await cacheService.deletePattern(pattern);
    }

    res.json({
      success: true,
      message: 'Cache cleared successfully'
    });

  } catch (error) {
    logger.error('Error clearing cache:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear cache'
    });
  }
});

module.exports = router;
