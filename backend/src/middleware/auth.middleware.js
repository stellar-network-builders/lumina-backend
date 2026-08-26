const jwt = require('jsonwebtoken');
const { Organization, Admin } = require('../models');
const auditLogger = require('../services/auditLogger');
const logger = require('../utils/logger');

/**
 * Authentication middleware for admin operations
 * Verifies JWT token and admin permissions
 */
const authenticateAdmin = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Authorization token required'
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    if (!decoded.address) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token format'
      });
    }

    // Verify admin status
    const isAdmin = await verifyAdminStatus(decoded.address);
    if (!isAdmin) {
      await auditLogger.log({
        action: 'UNAUTHORIZED_ADMIN_ACCESS',
        actor: decoded.address,
        target: req.path,
        details: {
          ip: req.ip,
          userAgent: req.get('User-Agent'),
          path: req.path,
          method: req.method
        }
      });

      return res.status(403).json({
        success: false,
        error: 'Admin privileges required'
      });
    }

    // Add user info to request
    req.user = {
      address: decoded.address,
      role: 'admin'
    };

    next();

  } catch (error) {
    logger.error('Authentication error:', error);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token'
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired'
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

/**
 * Verify admin status for the given address
 */
const verifyAdminStatus = async (address) => {
  try {
    // Check if address is in admin list (for HSM operations, we need strict verification)
    
    // Method 1: Check against hardcoded admin list (most secure)
    const adminAddresses = process.env.ADMIN_ADDRESSES 
      ? process.env.ADMIN_ADDRESSES.split(',').map(addr => addr.trim().toLowerCase())
      : [];
    
    if (adminAddresses.includes(address.toLowerCase())) {
      return true;
    }

    // Method 2: Check against database (for dynamic admin management)
    const admin = await Admin.findOne({
      where: { 
        address: address.toLowerCase(),
        is_active: true 
      }
    });

    if (admin) {
      return true;
    }

    // Method 3: Check if address is organization admin
    const org = await Organization.findOne({
      where: { 
        admin_address: address.toLowerCase(),
        is_active: true 
      }
    });

    return !!org;

  } catch (error) {
    logger.error('Error verifying admin status:', error);
    return false;
  }
};

/**
 * Enhanced security middleware for HSM operations
 * Adds additional checks for high-value operations
 */
const hsmSecurityMiddleware = async (req, res, next) => {
  try {
    // Additional security checks for HSM operations
    
    // 1. IP whitelist check (optional)
    if (process.env.HSM_IP_WHITELIST) {
      const allowedIPs = process.env.HSM_IP_WHITELIST.split(',').map(ip => ip.trim());
      const clientIP = req.ip || req.connection.remoteAddress;
      
      if (!allowedIPs.includes(clientIP)) {
        await auditLogger.log({
          action: 'HSM_IP_BLOCKED',
          actor: req.user?.address || 'unknown',
          target: req.path,
          details: {
            clientIP,
            allowedIPs,
            path: req.path
          }
        });

        return res.status(403).json({
          success: false,
          error: 'IP address not authorized for HSM operations'
        });
      }
    }

    // 2. Time-based restrictions (optional)
    if (process.env.HSM_TIME_RESTRICTION === 'true') {
      const currentHour = new Date().getHours();
      const businessHours = process.env.HSM_BUSINESS_HOURS 
        ? process.env.HSM_BUSINESS_HOURS.split('-').map(h => parseInt(h))
        : [9, 17]; // Default 9 AM - 5 PM

      if (currentHour < businessHours[0] || currentHour > businessHours[1]) {
        await auditLogger.log({
          action: 'HSM_TIME_BLOCKED',
          actor: req.user?.address || 'unknown',
          target: req.path,
          details: {
            currentHour,
            businessHours,
            path: req.path
          }
        });

        return res.status(403).json({
          success: false,
          error: 'HSM operations only allowed during business hours'
        });
      }
    }

    // 3. Request size validation
    const contentLength = req.get('content-length');
    if (contentLength && parseInt(contentLength) > 1024 * 1024) { // 1MB limit
      return res.status(413).json({
        success: false,
        error: 'Request too large for HSM operations'
      });
    }

    // 4. Add security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');

    next();

  } catch (error) {
    logger.error('HSM security middleware error:', error);
    return res.status(500).json({
      success: false,
      error: 'Security validation failed'
    });
  }
};

/**
 * Middleware to validate HSM operation context
 */
const validateHSMOperation = (operationType) => {
  return async (req, res, next) => {
    try {
      // Validate operation-specific requirements
      switch (operationType) {
        case 'sign':
          if (!req.body.transactionXDR || !req.body.keyId || !req.body.signerAddress) {
            return res.status(400).json({
              success: false,
              error: 'Missing required parameters for signing operation'
            });
          }
          break;

        case 'batch-revoke':
          if (!req.body.proposal || !req.body.signingKeyIds) {
            return res.status(400).json({
              success: false,
              error: 'Missing proposal or signing keys for batch revoke'
            });
          }
          break;

        case 'broadcast':
          if (!req.body.signedTransactionXDR) {
            return res.status(400).json({
              success: false,
              error: 'Missing signed transaction for broadcast'
            });
          }
          break;

        default:
          // No specific validation
          break;
      }

      // Log the operation attempt
      await auditLogger.log({
        action: `HSM_OPERATION_ATTEMPT_${operationType.toUpperCase()}`,
        actor: req.user?.address || 'unknown',
        target: req.path,
        details: {
          operationType,
          ip: req.ip,
          userAgent: req.get('User-Agent')
        }
      });

      next();

    } catch (error) {
      logger.error('HSM operation validation error:', error);
      return res.status(500).json({
        success: false,
        error: 'Operation validation failed'
      });
    }
  };
};

module.exports = {
  authenticateAdmin,
  hsmSecurityMiddleware,
  validateHSMOperation,
  verifyAdminStatus
};
