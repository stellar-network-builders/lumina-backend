const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const batchClaimProcessor = require('../services/batchClaimProcessor');
const AutoClaimConsent = require('../models/autoClaimConsent');
const logger = require('../utils/logger');

/**
 * @swagger
 * tags:
 *   name: Batch Claims
 *   description: Enterprise payroll batch claim processing for team token management
 */

/**
 * @swagger
 * /api/batch-claims/process:
 *   post:
 *     summary: Process batch claims for multiple beneficiaries
 *     description: Bundle multiple claim requests into a single atomic transaction for gas optimization
 *     tags: [Batch Claims]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - vaultAddress
 *               - beneficiaryAddresses
 *             properties:
 *               vaultAddress:
 *                 type: string
 *                 description: Vault contract address
 *               beneficiaryAddresses:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of beneficiary addresses to process claims for
 *               requireConsent:
 *                 type: boolean
 *                 default: true
 *                 description: Whether to require auto-claim consent
 *     responses:
 *       200:
 *         description: Batch claims processed successfully
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
 *                     totalProcessed:
 *                       type: integer
 *                     totalSuccessful:
 *                       type: integer
 *                     totalFailed:
 *                       type: integer
 *                     totalAmountClaimed:
 *                       type: string
 *                     successful:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           beneficiaryAddress:
 *                             type: string
 *                           amountClaimed:
 *                             type: string
 *                           transactionHash:
 *                             type: string
 *                     failed:
 *                       type: array
 *                       items:
 *                         type: object
 *       400:
 *         description: Invalid request or batch size exceeded
 *       403:
 *         description: Admin lacks permission
 */
router.post('/process', authService.authenticate(), async (req, res) => {
  try {
    const { 
      vaultAddress, 
      beneficiaryAddresses,
      requireConsent = true 
    } = req.body;

    if (!vaultAddress || !beneficiaryAddresses || !Array.isArray(beneficiaryAddresses)) {
      return res.status(400).json({
        success: false,
        error: 'vaultAddress and beneficiaryAddresses array are required'
      });
    }

    const results = await batchClaimProcessor.processBatchClaims({
      vaultAddress,
      beneficiaryAddresses,
      adminAddress: req.user.address,
      requireConsent
    });

    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    logger.error('Error processing batch claims:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/batch-claims/consent/enable:
 *   post:
 *     summary: Enable auto-claim consent
 *     description: Allow automated batch claim processing for your tokens
 *     tags: [Batch Claims]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - vaultAddress
 *             properties:
 *               vaultAddress:
 *                 type: string
 *               maxClaimPercentage:
 *                 type: number
 *                 default: 100
 *                 description: Maximum percentage of vested amount that can be auto-claimed
 *               minClaimAmount:
 *                 type: string
 *                 description: Minimum amount threshold for auto-claim
 *               claimFrequency:
 *                 type: string
 *                 enum: [immediate, daily, weekly, monthly]
 *                 default: immediate
 *               metadata:
 *                 type: object
 *                 description: Additional consent metadata
 *     responses:
 *       200:
 *         description: Auto-claim consent enabled
 *       400:
 *         description: Invalid parameters
 */
router.post('/consent/enable', authService.authenticate(), async (req, res) => {
  try {
    const { 
      vaultAddress,
      maxClaimPercentage = 100,
      minClaimAmount = null,
      claimFrequency = 'immediate',
      metadata = {}
    } = req.body;

    if (!vaultAddress) {
      return res.status(400).json({
        success: false,
        error: 'vaultAddress is required'
      });
    }

    const consent = await batchClaimProcessor.enableAutoClaimConsent({
      beneficiaryAddress: req.user.address,
      vaultAddress,
      maxClaimPercentage,
      minClaimAmount,
      claimFrequency,
      metadata
    });

    res.json({
      success: true,
      data: consent
    });
  } catch (error) {
    logger.error('Error enabling auto-claim consent:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/batch-claims/consent/disable:
 *   post:
 *     summary: Disable auto-claim consent
 *     description: Opt-out of automated batch claim processing
 *     tags: [Batch Claims]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - vaultAddress
 *             properties:
 *               vaultAddress:
 *                 type: string
 *     responses:
 *       200:
 *         description: Auto-claim consent disabled
 */
router.post('/consent/disable', authService.authenticate(), async (req, res) => {
  try {
    const { vaultAddress } = req.body;

    if (!vaultAddress) {
      return res.status(400).json({
        success: false,
        error: 'vaultAddress is required'
      });
    }

    await batchClaimProcessor.disableAutoClaimConsent(req.user.address, vaultAddress);

    res.json({
      success: true,
      message: 'Auto-claim consent disabled'
    });
  } catch (error) {
    logger.error('Error disabling auto-claim consent:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/batch-claims/eligibility:
 *   get:
 *     summary: Get batch claim eligibility
 *     description: Check if a beneficiary is eligible for batch claims
 *     tags: [Batch Claims]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: vaultAddress
 *         required: true
 *         schema:
 *           type: string
 *         description: Vault address
 *     responses:
 *       200:
 *         description: Eligibility information
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
 *                     eligible:
 *                       type: boolean
 *                     hasConsent:
 *                       type: boolean
 *                     claimableAmount:
 *                       type: string
 *                     consentSettings:
 *                       type: object
 */
router.get('/eligibility', authService.authenticate(), async (req, res) => {
  try {
    const { vaultAddress } = req.query;

    if (!vaultAddress) {
      return res.status(400).json({
        success: false,
        error: 'vaultAddress query parameter is required'
      });
    }

    const eligibility = await batchClaimProcessor.getBatchClaimEligibility(
      req.user.address,
      vaultAddress
    );

    res.json({
      success: true,
      data: eligibility
    });
  } catch (error) {
    logger.error('Error getting batch claim eligibility:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/batch-claims/consent/status:
 *   get:
 *     summary: Get auto-claim consent status
 *     description: Check current auto-claim consent settings
 *     tags: [Batch Claims]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: vaultAddress
 *         required: true
 *         schema:
 *           type: string
 *         description: Vault address
 *     responses:
 *       200:
 *         description: Consent status
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
 *                     isEnabled:
 *                       type: boolean
 *                     maxClaimPercentage:
 *                       type: number
 *                     minClaimAmount:
 *                       type: string
 *                     claimFrequency:
 *                       type: string
 *                     lastClaimedAt:
 *                       type: string
 *                       format: date-time
 */
router.get('/consent/status', authService.authenticate(), async (req, res) => {
  try {
    const { vaultAddress } = req.query;

    if (!vaultAddress) {
      return res.status(400).json({
        success: false,
        error: 'vaultAddress query parameter is required'
      });
    }

    const consent = await AutoClaimConsent.findOne({
      where: {
        beneficiary_address: req.user.address,
        vault_address: vaultAddress
      },
      attributes: [
        'is_enabled',
        'max_claim_percentage',
        'min_claim_amount',
        'claim_frequency',
        'last_claimed_at',
        'consent_metadata'
      ]
    });

    res.json({
      success: true,
      data: consent || { isEnabled: false }
    });
  } catch (error) {
    logger.error('Error getting consent status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
