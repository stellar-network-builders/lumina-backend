const logger = require('../utils/logger');
const ledgerSyncService = require('../services/ledgerSyncService');
const Sentry = require('@sentry/node');

/**
 * Middleware to check if vault is paused due to inconsistency
 * This prevents API calls to vaults with balance discrepancies
 */
const vaultPauseMiddleware = (req, res, next) => {
  try {
    // Extract vault address from request parameters or body
    const vaultAddress = extractVaultAddress(req);
    
    if (!vaultAddress) {
      // No vault address in request, proceed normally
      return next();
    }

    // Check if vault is paused
    if (ledgerSyncService.isVaultPaused(vaultAddress)) {
      logger.warn(`🔒 API access denied for paused vault: ${vaultAddress}`);
      
      // Log the attempt for security monitoring
      Sentry.addBreadcrumb({
        category: 'vault-pause',
        message: `API access attempt for paused vault: ${vaultAddress}`,
        level: 'warning',
        data: {
          method: req.method,
          path: req.path,
          ip: req.ip,
          userAgent: req.get('User-Agent')
        }
      });

      return res.status(503).json({
        success: false,
        error: 'VAULT_PAUSED',
        message: 'This vault is temporarily paused due to balance inconsistencies. Please try again later.',
        vaultAddress,
        timestamp: new Date().toISOString(),
        retryAfter: 300 // Suggest retry after 5 minutes
      });
    }

    // Vault is not paused, proceed normally
    next();

  } catch (error) {
    logger.error('❌ Error in vault pause middleware:', error);
    Sentry.captureException(error, {
      tags: { middleware: 'vault-pause' },
      extra: { path: req.path, method: req.method }
    });
    
    // Fail open - if middleware fails, allow request but log error
    next();
  }
};

/**
 * Extract vault address from various request locations
 */
function extractVaultAddress(req) {
  // Check URL parameters
  if (req.params && req.params.address) {
    return req.params.address;
  }
  
  if (req.params && req.params.vaultAddress) {
    return req.params.vaultAddress;
  }
  
  if (req.params && req.params.id) {
    // Could be vault ID or address, need to determine
    // For now, assume it's an address if it looks like one
    const id = req.params.id;
    if (id && id.startsWith('0x') && id.length === 42) {
      return id;
    }
  }
  
  // Check request body
  if (req.body) {
    if (req.body.vaultAddress) {
      return req.body.vaultAddress;
    }
    if (req.body.address) {
      return req.body.address;
    }
    if (req.body.vault_id && req.body.vault_id.startsWith('0x') && req.body.vault_id.length === 42) {
      return req.body.vault_id;
    }
  }
  
  // Check query parameters
  if (req.query) {
    if (req.query.vaultAddress) {
      return req.query.vaultAddress;
    }
    if (req.query.address) {
      return req.query.address;
    }
  }
  
  return null;
}

/**
 * Enhanced middleware that also provides vault status information
 */
const vaultStatusMiddleware = async (req, res, next) => {
  try {
    const vaultAddress = extractVaultAddress(req);
    
    if (vaultAddress) {
      const isPaused = ledgerSyncService.isVaultPaused(vaultAddress);
      
      // Add vault status to response headers
      res.set('X-Vault-Status', isPaused ? 'paused' : 'active');
      res.set('X-Vault-Address', vaultAddress);
      
      // Add vault status to request for downstream use
      req.vaultStatus = {
        address: vaultAddress,
        isPaused: isPaused
      };
    }
    
    next();
  } catch (error) {
    logger.error('❌ Error in vault status middleware:', error);
    next();
  }
};

/**
 * Middleware for admin endpoints to show paused vaults
 */
const pausedVaultsInfoMiddleware = async (req, res, next) => {
  try {
    const pausedVaults = ledgerSyncService.getPausedVaults();
    const serviceStatus = ledgerSyncService.getStatus();
    
    req.pausedVaultsInfo = {
      pausedVaults,
      count: pausedVaults.length,
      serviceStatus
    };
    
    next();
  } catch (error) {
    logger.error('❌ Error in paused vaults info middleware:', error);
    req.pausedVaultsInfo = { pausedVaults: [], count: 0, serviceStatus: null };
    next();
  }
};

/**
 * Middleware to check specific vault operations
 */
const vaultOperationMiddleware = (operation) => {
  return (req, res, next) => {
    try {
      const vaultAddress = extractVaultAddress(req);
      
      if (!vaultAddress) {
        return next();
      }

      const isPaused = ledgerSyncService.isVaultPaused(vaultAddress);
      
      if (isPaused) {
        // Different responses based on operation type
        const operationMessages = {
          'read': {
            message: 'Vault data is temporarily unavailable due to balance inconsistencies.',
            retryAfter: 60
          },
          'write': {
            message: 'Vault operations are paused due to balance inconsistencies.',
            retryAfter: 300
          },
          'claim': {
            message: 'Claim operations are paused for this vault due to balance inconsistencies.',
            retryAfter: 300
          },
          'admin': {
            message: 'Admin operations for this vault are paused due to balance inconsistencies.',
            retryAfter: 300
          }
        };

        const config = operationMessages[operation] || operationMessages['write'];
        
        logger.warn(`🔒 ${operation} operation denied for paused vault: ${vaultAddress}`);
        
        return res.status(503).json({
          success: false,
          error: 'VAULT_PAUSED',
          operation: operation,
          message: config.message,
          vaultAddress,
          timestamp: new Date().toISOString(),
          retryAfter: config.retryAfter
        });
      }

      next();
    } catch (error) {
      logger.error(`❌ Error in vault operation middleware (${operation}):`, error);
      next();
    }
  };
};

/**
 * API endpoint to get paused vaults status (admin only)
 */
const getPausedVaultsEndpoint = (req, res) => {
  try {
    const pausedVaults = ledgerSyncService.getPausedVaults();
    const serviceStatus = ledgerSyncService.getStatus();
    
    res.json({
      success: true,
      data: {
        pausedVaults,
        count: pausedVaults.length,
        serviceStatus,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('❌ Error getting paused vaults:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

/**
 * API endpoint to manually unpause a vault (admin only)
 */
const unpauseVaultEndpoint = async (req, res) => {
  try {
    const { vaultAddress, reason } = req.body;
    
    if (!vaultAddress) {
      return res.status(400).json({
        success: false,
        error: 'vaultAddress is required'
      });
    }

    const isPaused = ledgerSyncService.isVaultPaused(vaultAddress);
    
    if (!isPaused) {
      return res.status(400).json({
        success: false,
        error: 'Vault is not currently paused'
      });
    }

    // Unpause the vault
    await ledgerSyncService.unpauseVault(vaultAddress, reason || 'Manual unpause by admin');
    
    logger.info(`✅ Vault ${vaultAddress} manually unpaused by admin`);
    
    res.json({
      success: true,
      message: 'Vault unpaused successfully',
      vaultAddress,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('❌ Error unpausing vault:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

module.exports = {
  vaultPauseMiddleware,
  vaultStatusMiddleware,
  pausedVaultsInfoMiddleware,
  vaultOperationMiddleware,
  getPausedVaultsEndpoint,
  unpauseVaultEndpoint
};
