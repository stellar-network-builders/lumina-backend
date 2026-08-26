const express = require('express');
const router = express.Router();
const contractUpgradeService = require('../services/contractUpgradeService');
const contractUpgradeMultiSigService = require('../services/contractUpgradeMultiSigService');
const wasmHashVerificationService = require('../services/wasmHashVerificationService');
const logger = require('../utils/logger');
const { ContractUpgradeProposal, CertifiedBuild } = require('../models');
const Sentry = require('@sentry/node');

// Middleware to validate admin authentication (placeholder)
const requireAdminAuth = (req, res, next) => {
  // This would implement proper JWT verification
  // For now, we'll assume the admin_address in the body is authenticated
  const { admin_address } = req.body;
  if (!admin_address) {
    return res.status(401).json({
      success: false,
      error: 'Admin authentication required'
    });
  }
  req.adminAddress = admin_address;
  next();
};

/**
 * POST /api/contract-upgrade/proposals
 * Create a new contract upgrade proposal
 */
router.post('/proposals', requireAdminAuth, async (req, res) => {
  try {
    const {
      vault_address,
      proposed_wasm_hash,
      upgrade_reason,
      signers,
      required_signatures
    } = req.body;

    const proposal = await contractUpgradeService.createUpgradeProposal({
      vault_address,
      proposed_wasm_hash,
      upgrade_reason,
      signers,
      required_signatures
    }, req.adminAddress);

    res.status(201).json({
      success: true,
      data: proposal
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error creating upgrade proposal:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/contract-upgrade/proposals/multisig
 * Create a multi-sig upgrade proposal
 */
router.post('/proposals/multisig', requireAdminAuth, async (req, res) => {
  try {
    const {
      vault_address,
      proposed_wasm_hash,
      upgrade_reason
    } = req.body;

    const result = await contractUpgradeMultiSigService.createMultiSigUpgradeProposal({
      vault_address,
      proposed_wasm_hash,
      upgrade_reason
    }, req.adminAddress);

    res.status(201).json({
      success: true,
      data: result
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error creating multi-sig upgrade proposal:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/contract-upgrade/proposals/:proposalId
 * Get proposal details
 */
router.get('/proposals/:proposalId', async (req, res) => {
  try {
    const { proposalId } = req.params;
    
    const proposal = await contractUpgradeService.getProposalDetails(proposalId);
    
    res.json({
      success: true,
      data: proposal
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error getting proposal details:', error);
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/contract-upgrade/vaults/:vaultAddress/proposals
 * Get all proposals for a vault
 */
router.get('/vaults/:vaultAddress/proposals', async (req, res) => {
  try {
    const { vaultAddress } = req.params;
    const { status, date_from, date_to, page = 1, limit = 20 } = req.query;

    const filters = {};
    if (status) filters.status = status;
    if (date_from) filters.date_from = date_from;
    if (date_to) filters.date_to = date_to;

    const proposals = await contractUpgradeService.getVaultProposals(vaultAddress, filters);

    // Apply pagination
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedProposals = proposals.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        proposals: paginatedProposals,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: proposals.length,
          pages: Math.ceil(proposals.length / limit)
        }
      }
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error getting vault proposals:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/contract-upgrade/proposals/:proposalId/approve
 * Approve or reject a proposal
 */
router.post('/proposals/:proposalId/approve', async (req, res) => {
  try {
    const { proposalId } = req.params;
    const {
      signer_address,
      signature,
      decision,
      reason
    } = req.body;

    const result = await contractUpgradeService.approveProposal(
      proposalId,
      signer_address,
      signature,
      decision,
      reason
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error approving proposal:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/contract-upgrade/proposals/:proposalId/multisig-approve
 * Submit multi-sig approval
 */
router.post('/proposals/:proposalId/multisig-approve', async (req, res) => {
  try {
    const { proposalId } = req.params;
    const {
      signer_address,
      signature,
      decision,
      reason
    } = req.body;

    const result = await contractUpgradeMultiSigService.submitMultiSigApproval(
      proposalId,
      signer_address,
      signature,
      decision,
      reason
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error submitting multi-sig approval:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/contract-upgrade/proposals/:proposalId/execute
 * Execute an approved upgrade
 */
router.post('/proposals/:proposalId/execute', requireAdminAuth, async (req, res) => {
  try {
    const { proposalId } = req.params;

    const result = await contractUpgradeService.executeUpgrade(
      proposalId,
      req.adminAddress
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error executing upgrade:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/contract-upgrade/proposals/:proposalId/voting-status
 * Get voting status for a proposal
 */
router.get('/proposals/:proposalId/voting-status', async (req, res) => {
  try {
    const { proposalId } = req.params;

    const status = await contractUpgradeMultiSigService.getProposalVotingStatus(proposalId);

    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error getting voting status:', error);
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/contract-upgrade/multisig-config
 * Create multi-sig configuration for a vault
 */
router.post('/multisig-config', requireAdminAuth, async (req, res) => {
  try {
    const {
      vault_address,
      signers,
      required_signatures
    } = req.body;

    const config = await contractUpgradeMultiSigService.createUpgradeMultiSigConfig(
      vault_address,
      signers,
      required_signatures,
      req.adminAddress
    );

    res.status(201).json({
      success: true,
      data: config
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error creating multi-sig config:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/contract-upgrade/multisig-config/:vaultAddress
 * Get multi-sig configuration for a vault
 */
router.get('/multisig-config/:vaultAddress', async (req, res) => {
  try {
    const { vaultAddress } = req.params;

    const config = await contractUpgradeMultiSigService.getMultiSigConfig(vaultAddress);

    res.json({
      success: true,
      data: config
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error getting multi-sig config:', error);
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/contract-upgrade/multisig-config/:vaultAddress
 * Update multi-sig configuration
 */
router.put('/multisig-config/:vaultAddress', requireAdminAuth, async (req, res) => {
  try {
    const { vaultAddress } = req.params;
    const updates = req.body;

    const config = await contractUpgradeMultiSigService.updateMultiSigConfig(
      vaultAddress,
      updates,
      req.adminAddress
    );

    res.json({
      success: true,
      data: config
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error updating multi-sig config:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/contract-upgrade/verify-wasm-hash
 * Verify a WASM hash against certified builds
 */
router.post('/verify-wasm-hash', async (req, res) => {
  try {
    const {
      wasm_hash,
      vault_address,
      admin_address
    } = req.body;

    const result = await wasmHashVerificationService.verifyWasmHash(
      wasm_hash,
      vault_address,
      admin_address
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error verifying WASM hash:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/contract-upgrade/certified-builds
 * Register a new certified build
 */
router.post('/certified-builds', requireAdminAuth, async (req, res) => {
  try {
    const buildData = req.body;

    const certifiedBuild = await wasmHashVerificationService.registerCertifiedBuild(
      buildData,
      req.adminAddress
    );

    res.status(201).json({
      success: true,
      data: certifiedBuild
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error registering certified build:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/contract-upgrade/certified-builds
 * Get all certified builds
 */
router.get('/certified-builds', async (req, res) => {
  try {
    const { 
      is_active, 
      security_audit_passed, 
      page = 1, 
      limit = 20 
    } = req.query;

    const whereClause = {};
    if (is_active !== undefined) whereClause.is_active = is_active === 'true';
    if (security_audit_passed !== undefined) {
      whereClause.security_audit_passed = security_audit_passed === 'true';
    }

    const builds = await CertifiedBuild.findAndCountAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    });

    res.json({
      success: true,
      data: {
        builds: builds.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: builds.count,
          pages: Math.ceil(builds.count / limit)
        }
      }
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error getting certified builds:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/contract-upgrade/certified-builds/:wasmHash
 * Get certified build by WASM hash
 */
router.get('/certified-builds/:wasmHash', async (req, res) => {
  try {
    const { wasmHash } = req.params;

    const build = await CertifiedBuild.findOne({
      where: { wasm_hash: wasmHash }
    });

    if (!build) {
      return res.status(404).json({
        success: false,
        error: 'Certified build not found'
      });
    }

    res.json({
      success: true,
      data: build
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error getting certified build:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/contract-upgrade/audit-logs/:proposalId
 * Get audit logs for a proposal
 */
router.get('/audit-logs/:proposalId', async (req, res) => {
  try {
    const { proposalId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const proposal = await ContractUpgradeProposal.findByPk(proposalId, {
      include: [
        {
          model: require('../models').ContractUpgradeAuditLog,
          as: 'auditLogs',
          order: [['created_at', 'DESC']]
        }
      ]
    });

    if (!proposal) {
      return res.status(404).json({
        success: false,
        error: 'Proposal not found'
      });
    }

    // Apply pagination to audit logs
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedLogs = proposal.auditLogs.slice(startIndex, endIndex);

    res.json({
      success: true,
      data: {
        proposal_id: proposalId,
        audit_logs: paginatedLogs,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: proposal.auditLogs.length,
          pages: Math.ceil(proposal.auditLogs.length / limit)
        }
      }
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error getting audit logs:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/contract-upgrade/stats
 * Get upgrade statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const { vault_address, days = 30 } = req.query;

    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - parseInt(days));

    const whereClause = {
      created_at: { $gte: dateFrom }
    };

    if (vault_address) {
      whereClause.vault_address = vault_address;
    }

    const stats = await ContractUpgradeProposal.findAll({
      where: whereClause,
      attributes: [
        'status',
        [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']
      ],
      group: ['status'],
      raw: true
    });

    const totalProposals = stats.reduce((sum, stat) => sum + parseInt(stat.count), 0);

    res.json({
      success: true,
      data: {
        period: `${days} days`,
        vault_address: vault_address || 'all',
        total_proposals: totalProposals,
        status_breakdown: stats,
        success_rate: totalProposals > 0 ? 
          (stats.find(s => s.status === 'executed')?.count || 0) / totalProposals : 0
      }
    });

  } catch (error) {
    Sentry.captureException(error);
    logger.error('Error getting upgrade stats:', error);
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
