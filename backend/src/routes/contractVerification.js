const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const contractVerificationService = require('../services/contractVerificationService');
const ApprovedContractRegistry = require('../models/approvedContractRegistry');
const logger = require('../utils/logger');

/**
 * @swagger
 * tags:
 *   name: Contract Verification
 *   description: Verify and manage approved Soroban contracts to prevent impersonation scams
 */

/**
 * @swagger
 * /api/contract-verification/verify:
 *   post:
 *     summary: Verify if a contract is approved and safe to link
 *     description: Verifies that a contract's WASM hash matches an approved version in the registry
 *     tags: [Contract Verification]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - contractAddress
 *               - wasmHash
 *             properties:
 *               contractAddress:
 *                 type: string
 *                 description: Stellar contract address to verify
 *               wasmHash:
 *                 type: string
 *                 description: SHA256 hash of the contract WASM file
 *     responses:
 *       200:
 *         description: Verification result
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
 *                     valid:
 *                       type: boolean
 *                     contractAddress:
 *                       type: string
 *                     projectName:
 *                       type: string
 *                     version:
 *                       type: string
 *                     auditTimestamp:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Contract is blacklisted or not approved
 */
router.post('/verify', authService.authenticate(), async (req, res) => {
  try {
    const { contractAddress, wasmHash } = req.body;

    if (!contractAddress || !wasmHash) {
      return res.status(400).json({
        success: false,
        error: 'contractAddress and wasmHash are required'
      });
    }

    const result = await contractVerificationService.verifyContract({
      contractAddress,
      wasmHash,
      requesterAddress: req.user.address
    });

    if (!result.valid) {
      return res.status(403).json({
        success: false,
        error: result.error,
        data: result
      });
    }

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Error verifying contract:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/contract-verification/register:
 *   post:
 *     summary: Register a new approved contract
 *     description: Add a contract to the approved registry after security audit
 *     tags: [Contract Verification]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - contractAddress
 *               - wasmHash
 *               - projectName
 *               - version
 *               - auditorAddress
 *             properties:
 *               contractAddress:
 *                 type: string
 *               wasmHash:
 *                 type: string
 *               projectName:
 *                 type: string
 *               version:
 *                 type: string
 *               auditorAddress:
 *                 type: string
 *               auditReportUrl:
 *                 type: string
 *               metadata:
 *                 type: object
 *     responses:
 *       201:
 *         description: Contract registered successfully
 *       400:
 *         description: Invalid request or contract already exists
 */
router.post('/register', authService.authenticate(true), async (req, res) => {
  try {
    const { 
      contractAddress, 
      wasmHash, 
      projectName, 
      version,
      auditorAddress,
      auditReportUrl,
      metadata 
    } = req.body;

    if (!contractAddress || !wasmHash || !projectName || !version) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const registry = await contractVerificationService.registerContract({
      contractAddress,
      wasmHash,
      projectName,
      version,
      auditorAddress: auditorAddress || req.user.address,
      auditReportUrl,
      metadata
    });

    res.status(201).json({
      success: true,
      data: registry
    });
  } catch (error) {
    logger.error('Error registering contract:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/contract-verification/blacklist:
 *   post:
 *     summary: Blacklist a malicious contract
 *     description: Mark a contract as malicious/impersonation to protect users
 *     tags: [Contract Verification]
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - contractAddress
 *               - reason
 *             properties:
 *               contractAddress:
 *                 type: string
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Contract blacklisted successfully
 *       400:
 *         description: Invalid request
 */
router.post('/blacklist', authService.authenticate(true), async (req, res) => {
  try {
    const { contractAddress, reason } = req.body;

    if (!contractAddress || !reason) {
      return res.status(400).json({
        success: false,
        error: 'contractAddress and reason are required'
      });
    }

    const success = await contractVerificationService.blacklistContract({
      contractAddress,
      reason,
      blacklistedBy: req.user.address
    });

    if (!success) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found in registry'
      });
    }

    res.json({
      success: true,
      message: 'Contract has been blacklisted'
    });
  } catch (error) {
    logger.error('Error blacklisting contract:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/contract-verification/list:
 *   get:
 *     summary: Get list of approved contracts
 *     description: Retrieve all approved contracts from the registry
 *     tags: [Contract Verification]
 *     parameters:
 *       - in: query
 *         name: projectName
 *         schema:
 *           type: string
 *         description: Filter by project name
 *       - in: query
 *         name: version
 *         schema:
 *           type: string
 *         description: Filter by version
 *     responses:
 *       200:
 *         description: List of approved contracts
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
router.get('/list', async (req, res) => {
  try {
    const { projectName, version } = req.query;

    const contracts = await contractVerificationService.getApprovedContracts({
      projectName,
      version
    });

    res.json({
      success: true,
      data: contracts
    });
  } catch (error) {
    logger.error('Error getting approved contracts:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * @swagger
 * /api/contract-verification/{contractAddress}:
 *   get:
 *     summary: Get contract details
 *     description: Retrieve details of a specific contract by address
 *     tags: [Contract Verification]
 *     parameters:
 *       - in: path
 *         name: contractAddress
 *         required: true
 *         schema:
 *           type: string
 *         description: Contract address
 *     responses:
 *       200:
 *         description: Contract details
 *       404:
 *         description: Contract not found
 */
router.get('/:contractAddress', async (req, res) => {
  try {
    const { contractAddress } = req.params;

    const contract = await contractVerificationService.getContractDetails(contractAddress);

    if (!contract) {
      return res.status(404).json({
        success: false,
        error: 'Contract not found'
      });
    }

    res.json({
      success: true,
      data: contract
    });
  } catch (error) {
    logger.error('Error getting contract details:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
