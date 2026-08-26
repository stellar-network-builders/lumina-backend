const express = require('express');
const router = express.Router();
const hsmGatewayService = require('../services/hsmGatewayService');
const { authenticateAdmin, hsmSecurityMiddleware, validateHSMOperation } = require('../middleware/auth.middleware');
const auditLogger = require('../services/auditLogger');
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

// Security: Rate limiting for HSM operations
const hsmRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 HSM operations per minute
  message: {
    success: false,
    error: 'Too many HSM operations. Please try again later.'
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/**
 * POST /api/hsm/prepare-transaction
 * Prepare Soroban transaction XDR for HSM signing
 */
router.post('/prepare-transaction', authenticateAdmin, hsmSecurityMiddleware, validateHSMOperation('prepare'), hsmRateLimit, async (req, res) => {
  try {
    const { proposal } = req.body;
    
    if (!proposal || !proposal.id) {
      return res.status(400).json({
        success: false,
        error: 'Invalid proposal data'
      });
    }

    logger.info(`🔐 Preparing HSM transaction for proposal ${proposal.id}`);
    
    const result = await hsmGatewayService.prepareRevocationTransaction(proposal);
    
    // Log the preparation
    await auditLogger.log({
      action: 'PREPARE_HSM_TRANSACTION',
      actor: req.user?.address || 'admin',
      target: proposal.id,
      details: {
        proposalId: proposal.id,
        vaultAddress: proposal.vault_address,
        transactionHash: result.transactionHash
      }
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('❌ Error preparing HSM transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Transaction preparation failed',
      message: error.message
    });
  }
});

/**
 * POST /api/hsm/sign-transaction
 * Sign transaction using HSM
 */
router.post('/sign-transaction', authenticateAdmin, hsmSecurityMiddleware, validateHSMOperation('sign'), hsmRateLimit, async (req, res) => {
  try {
    const { transactionXDR, keyId, signerAddress } = req.body;
    
    if (!transactionXDR || !keyId || !signerAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    logger.info(`🔐 Signing transaction with HSM for signer ${signerAddress}`);
    
    const result = await hsmGatewayService.signWithHSM(transactionXDR, keyId, signerAddress);
    
    // Log the signing
    await auditLogger.log({
      action: 'HSM_SIGN_TRANSACTION',
      actor: req.user?.address || 'admin',
      target: signerAddress,
      details: {
        keyId,
        transactionHash: result.transactionHash,
        signatureLength: result.signature.length
      }
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('❌ Error signing with HSM:', error);
    res.status(500).json({
      success: false,
      error: 'HSM signing failed',
      message: error.message
    });
  }
});

/**
 * POST /api/hsm/batch-revoke
 * Execute complete batch revoke with HSM signing
 */
router.post('/batch-revoke', authenticateAdmin, hsmSecurityMiddleware, validateHSMOperation('batch-revoke'), hsmRateLimit, async (req, res) => {
  try {
    const { proposal, signingKeyIds } = req.body;
    
    if (!proposal || !proposal.id || !signingKeyIds) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request: proposal and signingKeyIds required'
      });
    }

    logger.info(`🔐 Executing batch revoke with HSM for proposal ${proposal.id}`);
    
    const result = await hsmGatewayService.executeBatchRevokeWithHSM(proposal, signingKeyIds);
    
    // Log the batch revoke
    await auditLogger.log({
      action: 'HSM_BATCH_REVOKE',
      actor: req.user?.address || 'admin',
      target: proposal.beneficiary_address,
      details: {
        proposalId: proposal.id,
        vaultAddress: proposal.vault_address,
        transactionHash: result.transactionHash,
        ledger: result.ledger,
        signatures: result.signatures
      }
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('❌ Error in batch revoke with HSM:', error);
    res.status(500).json({
      success: false,
      error: 'Batch revoke failed',
      message: error.message
    });
  }
});

/**
 * POST /api/hsm/broadcast-transaction
 * Broadcast signed transaction to Stellar network
 */
router.post('/broadcast-transaction', authenticateAdmin, hsmSecurityMiddleware, validateHSMOperation('broadcast'), hsmRateLimit, async (req, res) => {
  try {
    const { signedTransactionXDR } = req.body;
    
    if (!signedTransactionXDR) {
      return res.status(400).json({
        success: false,
        error: 'Signed transaction XDR is required'
      });
    }

    logger.info('🚀 Broadcasting HSM-signed transaction');
    
    const result = await hsmGatewayService.broadcastTransaction(signedTransactionXDR);
    
    // Log the broadcast
    await auditLogger.log({
      action: 'HSM_BROADCAST_TRANSACTION',
      actor: req.user?.address || 'admin',
      target: result.transactionHash,
      details: {
        transactionHash: result.transactionHash,
        ledger: result.ledger,
        feePaid: result.feePaid
      }
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    logger.error('❌ Error broadcasting transaction:', error);
    res.status(500).json({
      success: false,
      error: 'Transaction broadcast failed',
      message: error.message
    });
  }
});

/**
 * GET /api/hsm/status
 * Get HSM provider status and health
 */
router.get('/status', authenticateAdmin, hsmSecurityMiddleware, async (req, res) => {
  try {
    const status = await hsmGatewayService.getHSMStatus();
    
    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    logger.error('❌ Error getting HSM status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get HSM status',
      message: error.message
    });
  }
});

/**
 * GET /api/hsm/health
 * Health check endpoint (no auth required for load balancers)
 */
router.get('/health', async (req, res) => {
  try {
    // Basic health check without sensitive information
    const status = await hsmGatewayService.getHSMStatus();
    
    res.json({
      success: true,
      status: status.status === 'connected' ? 'healthy' : 'unhealthy',
      provider: status.provider,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(503).json({
      success: false,
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;
