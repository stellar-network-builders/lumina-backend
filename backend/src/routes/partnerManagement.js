const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const partnerManagementService = require('../services/partnerManagementService');
const PartnerManagement = require('../models/partnerManagement');
const logger = require('../utils/logger');
const PartnerUsageTracking = require('../models/partnerUsageTracking');

/**
 * @swagger
 * tags:
 *   name: Partner Management
 *   description: Institutional partner management with tiered API access
 */

/**
 * @swagger
 * /api/partners/register:
 *   post:
 *     summary: Register a new institutional partner
 *     description: Create a new partner account with tiered API access
 *     tags: [Partner Management]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - partnerName
 *               - contactEmail
 *             properties:
 *               partnerName:
 *                 type: string
 *               partnerTier:
 *                 type: string
 *                 enum: [basic, silver, gold, platinum, enterprise]
 *                 default: basic
 *               contactEmail:
 *                 type: string
 *               contactAddress:
 *                 type: string
 *     responses:
 *       201:
 *         description: Partner registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     partner_name:
 *                       type: string
 *                     api_key:
 *                       type: string
 *                     api_secret:
 *                       type: string
 *                     partner_tier:
 *                       type: string
 */
router.post('/register', authService.authenticate(true), async (req, res) => {
  try {
    const { 
      partnerName, 
      partnerTier = 'basic',
      contactEmail,
      contactAddress 
    } = req.body;

    if (!partnerName || !contactEmail) {
      return res.status(400).json({
        success: false,
        error: 'partnerName and contactEmail are required'
      });
    }

    const partner = await partnerManagementService.registerPartner({
      partnerName,
      partnerTier,
      contactEmail,
      contactAddress,
      approvedBy: req.user.address
    });

    res.status(201).json({
      success: true,
      data: partner
    });
  } catch (error) {
    logger.error('Error registering partner:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/partners/list:
 *   get:
 *     summary: Get all active partners
 *     description: Retrieve list of all active institutional partners
 *     tags: [Partner Management]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: List of active partners
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 */
router.get('/list', authService.authenticate(true), async (req, res) => {
  try {
    const partners = await partnerManagementService.getActivePartners();

    res.json({
      success: true,
      data: partners
    });
  } catch (error) {
    logger.error('Error getting partners:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/partners/report/{partnerId}:
 *   get:
 *     summary: Generate monthly usage report for a partner
 *     description: Get detailed usage statistics and analytics for a specific partner
 *     tags: [Partner Management]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: partnerId
 *         required: true
 *         schema:
 *           type: string
 *         description: Partner ID
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           pattern: '^\d{4}-\d{2}$'
 *         description: Billing period (YYYY-MM), defaults to current month
 *     responses:
 *       200:
 *         description: Monthly usage report
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     partner:
 *                       type: object
 *                     billingPeriod:
 *                       type: string
 *                     summary:
 *                       type: object
 *                     dailyBreakdown:
 *                       type: array
 *                     topEndpoints:
 *                       type: array
 */
router.get('/report/:partnerId', authService.authenticate(true), async (req, res) => {
  try {
    const { partnerId } = req.params;
    const { period } = req.query;

    const billingPeriod = period || new Date().toISOString().slice(0, 7);

    const report = await partnerManagementService.generateMonthlyReport(
      partnerId,
      billingPeriod
    );

    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error('Error generating report:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/partners/suspend/{partnerId}:
 *   post:
 *     summary: Suspend a partner
 *     description: Temporarily suspend partner access
 *     tags: [Partner Management]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: partnerId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Partner suspended successfully
 *       404:
 *         description: Partner not found
 */
router.post('/suspend/:partnerId', authService.authenticate(true), async (req, res) => {
  try {
    const { partnerId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({
        success: false,
        error: 'Suspension reason is required'
      });
    }

    await partnerManagementService.suspendPartner(partnerId, reason, req.user.address);

    res.json({
      success: true,
      message: 'Partner suspended successfully'
    });
  } catch (error) {
    logger.error('Error suspending partner:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/partners/reactivate/{partnerId}:
 *   post:
 *     summary: Reactivate a suspended partner
 *     description: Restore access for a previously suspended partner
 *     tags: [Partner Management]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: partnerId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Partner reactivated successfully
 */
router.post('/reactivate/:partnerId', authService.authenticate(true), async (req, res) => {
  try {
    const { partnerId } = req.params;

    await partnerManagementService.reactivatePartner(partnerId);

    res.json({
      success: true,
      message: 'Partner reactivated successfully'
    });
  } catch (error) {
    logger.error('Error reactivating partner:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/partners/tier/{partnerId}:
 *   put:
 *     summary: Update partner tier
 *     description: Upgrade or downgrade partner tier level
 *     tags: [Partner Management]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: partnerId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tier
 *             properties:
 *               tier:
 *                 type: string
 *                 enum: [basic, silver, gold, platinum, enterprise]
 *     responses:
 *       200:
 *         description: Tier updated successfully
 */
router.put('/tier/:partnerId', authService.authenticate(true), async (req, res) => {
  try {
    const { partnerId } = req.params;
    const { tier } = req.body;

    if (!tier) {
      return res.status(400).json({
        success: false,
        error: 'Tier is required'
      });
    }

    await partnerManagementService.updatePartnerTier(partnerId, tier);

    res.json({
      success: true,
      message: `Partner tier updated to ${tier}`
    });
  } catch (error) {
    logger.error('Error updating tier:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/partners/regenerate-key/{partnerId}:
 *   post:
 *     summary: Regenerate API key
 *     description: Generate new API credentials for a partner
 *     tags: [Partner Management]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: partnerId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: New API credentials
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     api_key:
 *                       type: string
 *                     api_secret:
 *                       type: string
 */
router.post('/regenerate-key/:partnerId', authService.authenticate(true), async (req, res) => {
  try {
    const { partnerId } = req.params;

    const credentials = await partnerManagementService.regenerateApiKey(partnerId);

    res.json({
      success: true,
      data: credentials
    });
  } catch (error) {
    logger.error('Error regenerating API key:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
