const express = require('express');
const router = express.Router();
const BeneficiaryLoyaltyBadgeService = require('../services/beneficiaryLoyaltyBadgeService');
const authService = require('../services/authService');
const logger = require('../utils/logger');

const loyaltyBadgeService = new BeneficiaryLoyaltyBadgeService();

// POST /api/loyalty-badges/monitoring/start
// Start monitoring a beneficiary for Diamond Hands badge
router.post(
  '/monitoring/start',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const { beneficiaryId, startDate } = req.body;

      if (!beneficiaryId) {
        return res.status(400).json({
          success: false,
          message: 'beneficiaryId is required'
        });
      }

      const result = await loyaltyBadgeService.startMonitoring(beneficiaryId, startDate);
      
      res.json(result);
    } catch (error) {
      logger.error('Error starting loyalty badge monitoring:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// POST /api/loyalty-badges/monitoring/check
// Check and update all active monitoring records (admin only)
router.post(
  '/monitoring/check',
  authService.authenticate(true), // Require admin authentication
  async (req, res) => {
    try {
      const result = await loyaltyBadgeService.checkAndUpdateRetentionPeriods();
      
      res.json({
        success: true,
        message: 'Monitoring check completed',
        data: result
      });
    } catch (error) {
      logger.error('Error checking retention periods:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/loyalty-badges/beneficiary/:beneficiaryId
// Get all badges for a specific beneficiary
router.get(
  '/beneficiary/:beneficiaryId',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const { beneficiaryId } = req.params;
      const badges = await loyaltyBadgeService.getBeneficiaryBadges(beneficiaryId);
      
      res.json({
        success: true,
        data: badges
      });
    } catch (error) {
      logger.error('Error fetching beneficiary badges:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/loyalty-badges/diamond-hands
// Get all Diamond Hands badge holders (admin only)
router.get(
  '/diamond-hands',
  authService.authenticate(true), // Require admin authentication
  async (req, res) => {
    try {
      const holders = await loyaltyBadgeService.getDiamondHandsHolders();
      
      res.json({
        success: true,
        data: holders
      });
    } catch (error) {
      logger.error('Error fetching Diamond Hands holders:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/loyalty-badges/statistics
// Get monitoring statistics (admin only)
router.get(
  '/statistics',
  authService.authenticate(true), // Require admin authentication
  async (req, res) => {
    try {
      const stats = await loyaltyBadgeService.getMonitoringStatistics();
      
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('Error fetching monitoring statistics:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// POST /api/loyalty-badges/:badgeId/award
// Manually award a badge (admin only)
router.post(
  '/:badgeId/award',
  authService.authenticate(true), // Require admin authentication
  async (req, res) => {
    try {
      const { badgeId } = req.params;
      const result = await loyaltyBadgeService.awardDiamondHandsBadge(badgeId);
      
      res.json(result);
    } catch (error) {
      logger.error('Error awarding badge:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// GET /api/loyalty-badges/balance/:walletAddress
// Get current wallet balance (helper endpoint)
router.get(
  '/balance/:walletAddress',
  authService.authenticate(true), // Require authentication
  async (req, res) => {
    try {
      const { walletAddress } = req.params;
      const balance = await loyaltyBadgeService.getWalletBalance(walletAddress);
      
      res.json({
        success: true,
        data: {
          walletAddress,
          balance: balance.toString()
        }
      });
    } catch (error) {
      logger.error('Error fetching wallet balance:', error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

module.exports = router;
