/**
 * KYC Soft Lock Middleware - Middleware to enforce KYC compliance on claim operations
 * 
 * This middleware checks user KYC status before allowing claim operations,
 * enforcing soft-locks when KYC is expired or expiring soon.
 */

const { KycStatus } = require('../models');
const Sentry = require('@sentry/node');
const logger = require('../utils/logger');

/**
 * Middleware to check KYC status before allowing claims
 */
const kycSoftLockMiddleware = async (req, res, next) => {
  try {
    // Only apply to claim endpoints
    if (!req.path.includes('/claims')) {
      return next();
    }

    // Extract user address from request
    const userAddress = req.body.user_address || req.params.userAddress || req.user?.address;
    
    if (!userAddress) {
      return res.status(400).json({
        success: false,
        error: 'USER_ADDRESS_REQUIRED',
        message: 'User address is required for KYC verification'
      });
    }

    logger.info(`🔍 Checking KYC status for claim by user: ${userAddress}`);

    // Get user's KYC status
    const kycStatus = await KycStatus.findByUserAddress(userAddress);
    
    if (!kycStatus) {
      logger.info(`⚠️ No KYC record found for user: ${userAddress}`);
      
      // Create pending KYC record and block claim
      await KycStatus.createKycStatus({
        userAddress,
        kycStatus: 'PENDING',
        kycLevel: 'BASIC'
      });
      
      return res.status(403).json({
        success: false,
        error: 'KYC_VERIFICATION_REQUIRED',
        message: 'KYC verification is required before claiming tokens',
        data: {
          kycStatus: 'PENDING',
          canClaim: false,
          actionRequired: 'complete_kyc',
          kycUrl: `${process.env.FRONTEND_URL}/kyc/verify`
        }
      });
    }

    // Check compliance status
    const complianceStatus = kycStatus.getComplianceStatus();
    
    logger.info(`📊 KYC compliance status for user ${userAddress}: ${complianceStatus.status}`);

    // Log the check for audit purposes
    await kycStatus.addNotification('CLAIM_ATTEMPT', `Claim attempt - Status: ${complianceStatus.status}`);

    // If user cannot claim, block the request
    if (!complianceStatus.canClaim) {
      logger.info(`🚫 Claim blocked for user ${userAddress}: ${complianceStatus.message}`);
      
      // Send Sentry alert for compliance violations
      Sentry.captureMessage(`Claim blocked due to KYC compliance - User: ${userAddress}`, {
        level: 'warning',
        tags: { 
          operation: 'kycSoftLock',
          kycStatus: complianceStatus.status,
          urgency: complianceStatus.urgency
        },
        extra: { 
          userAddress,
          kycStatus: kycStatus.toJSON(),
          claimData: req.body
        }
      });

      return res.status(403).json({
        success: false,
        error: 'CLAIM_BLOCKED_BY_KYC',
        message: complianceStatus.message,
        data: {
          kycStatus: complianceStatus.status,
          canClaim: complianceStatus.canClaim,
          urgency: complianceStatus.urgency,
          actionRequired: complianceStatus.action,
          daysUntilExpiration: kycStatus.days_until_expiration,
          expirationDate: kycStatus.expiration_date,
          softLockEnabled: kycStatus.soft_lock_enabled,
          softLockReason: kycStatus.soft_lock_reason,
          kycUrl: `${process.env.FRONTEND_URL}/kyc/reverify`
        }
      });
    }

    // If KYC is expiring soon, add warning but allow claim
    if (complianceStatus.status === 'EXPIRING_SOON') {
      logger.info(`⚠️ Warning: User ${userAddress} KYC expiring soon`);
      
      // Add warning header to response (will be processed after next())
      req.kycWarning = {
        message: complianceStatus.message,
        daysUntilExpiration: kycStatus.days_until_expiration,
        urgency: complianceStatus.urgency
      };
    }

    // User can proceed with claim
    logger.info(`✅ KYC check passed for user ${userAddress}`);
    
    // Attach KYC status to request for downstream use
    req.kycStatus = kycStatus.toJSON();
    req.kycComplianceStatus = complianceStatus;
    
    next();
    
  } catch (error) {
    logger.error('❌ Error in KYC soft-lock middleware:', error);
    Sentry.captureException(error, {
      tags: { operation: 'kycSoftLockMiddleware' },
      extra: { userAddress: req.body.user_address, path: req.path }
    });
    
    // Fail safe: block claim if KYC check fails
    return res.status(500).json({
      success: false,
      error: 'KYC_VERIFICATION_FAILED',
      message: 'Unable to verify KYC status. Please try again later or contact support.',
      data: {
        canClaim: false,
        actionRequired: 'contact_support',
        supportUrl: `${process.env.FRONTEND_URL}/support`
      }
    });
  }
};

/**
 * Middleware to check KYC status for admin operations
 */
const kycAdminMiddleware = async (req, res, next) => {
  try {
    // Only apply to admin endpoints that might affect user funds
    const adminEndpoints = ['/admin/revoke', '/admin/transfer', '/admin/create'];
    const isAdminEndpoint = adminEndpoints.some(endpoint => req.path.includes(endpoint));
    
    if (!isAdminEndpoint) {
      return next();
    }

    const targetUserAddress = req.body.targetAddress || req.body.user_address;
    
    if (!targetUserAddress) {
      return next(); // No target user, proceed
    }

    logger.info(`🔍 Admin operation - Checking KYC status for target user: ${targetUserAddress}`);

    const kycStatus = await KycStatus.findByUserAddress(targetUserAddress);
    
    if (!kycStatus) {
      logger.info(`⚠️ No KYC record found for target user: ${targetUserAddress}`);
      return next(); // Allow admin operation for users without KYC record
    }

    const complianceStatus = kycStatus.getComplianceStatus();
    
    // Log admin operation for compliance
    await kycStatus.addNotification('ADMIN_OPERATION', `Admin operation by ${req.user?.address} - Status: ${complianceStatus.status}`);

    // Add KYC context to admin request
    req.targetKycStatus = kycStatus.toJSON();
    req.targetKycComplianceStatus = complianceStatus;
    
    // If target user has critical compliance issues, warn admin
    if (complianceStatus.urgency === 'CRITICAL') {
      logger.info(`🚨 Admin operation on user with critical KYC status: ${targetUserAddress}`);
      
      Sentry.captureMessage(`Admin operation on user with critical KYC status`, {
        level: 'warning',
        tags: { 
          operation: 'kycAdminCheck',
          kycStatus: complianceStatus.status
        },
        extra: { 
          adminAddress: req.user?.address,
          targetUserAddress,
          operation: req.path,
          kycStatus: kycStatus.toJSON()
        }
      });
    }
    
    next();
    
  } catch (error) {
    logger.error('❌ Error in KYC admin middleware:', error);
    Sentry.captureException(error, {
      tags: { operation: 'kycAdminMiddleware' },
      extra: { adminAddress: req.user?.address, path: req.path }
    });
    
    next(); // Don't block admin operations due to KYC check failures
  }
};

/**
 * Middleware to add KYC status headers to responses
 */
const kycStatusHeaderMiddleware = (req, res, next) => {
  const originalSend = res.send;
  
  res.send = function(data) {
    // Add KYC status headers if KYC was checked
    if (req.kycComplianceStatus) {
      res.setHeader('X-KYC-Status', req.kycComplianceStatus.status);
      res.setHeader('X-KYC-Can-Claim', req.kycComplianceStatus.canClaim);
      res.setHeader('X-KYC-Urgency', req.kycComplianceStatus.urgency);
      
      if (req.kycStatus.days_until_expiration !== undefined) {
        res.setHeader('X-KYC-Days-Until-Expiration', req.kycStatus.days_until_expiration);
      }
    }
    
    // Add KYC warning if applicable
    if (req.kycWarning) {
      res.setHeader('X-KYC-Warning', req.kycWarning.message);
      res.setHeader('X-KYC-Warning-Urgency', req.kycWarning.urgency);
    }
    
    originalSend.call(this, data);
  };
  
  next();
};

/**
 * Middleware to log KYC compliance events
 */
const kycAuditMiddleware = async (req, res, next) => {
  const originalSend = res.send;
  
  res.send = async function(data) {
    // Log successful claim operations with KYC context
    if (req.path.includes('/claims') && res.statusCode >= 200 && res.statusCode < 300) {
      if (req.kycStatus && req.userAddress) {
        try {
          const { KycAuditLog } = require('../models');
          
          await KycAuditLog.create({
            user_address: req.userAddress,
            operation: 'CLAIM',
            kyc_status: req.kycStatus.kyc_status,
            kyc_level: req.kycStatus.kyc_level,
            risk_level: req.kycStatus.risk_level,
            days_until_expiration: req.kycStatus.days_until_expiration,
            soft_lock_enabled: req.kycStatus.soft_lock_enabled,
            claim_data: req.body,
            success: true,
            ip_address: req.ip,
            user_agent: req.get('User-Agent')
          });
          
          logger.info(`📝 KYC audit log created for claim by user ${req.userAddress}`);
          
        } catch (error) {
          logger.error('❌ Error creating KYC audit log:', error);
          // Don't fail the request due to audit logging errors
        }
      }
    }
    
    originalSend.call(this, data);
  };
  
  next();
};

/**
 * Middleware to check for KYC updates after claim
 */
const kycPostClaimMiddleware = async (req, res, next) => {
  const originalSend = res.send;
  
  res.send = async function(data) {
    await originalSend.call(this, data);
    
    // After successful claim, check if we need to trigger KYC re-verification
    if (req.path.includes('/claims') && res.statusCode >= 200 && res.statusCode < 300) {
      if (req.kycStatus && req.kycComplianceStatus) {
        try {
          // If claim was successful but KYC is expiring soon, schedule follow-up
          if (req.kycComplianceStatus.status === 'EXPIRING_SOON' && req.kycStatus.days_until_expiration <= 3) {
            const { notificationService } = require('../services');
            
            await notificationService.sendPushNotification(req.userAddress, {
              title: 'Claim Successful - KYC Action Required',
              body: 'Your claim was successful, but your KYC verification expires soon. Please complete re-verification.',
              data: {
                type: 'kyc_expiration_post_claim',
                urgency: 'HIGH',
                daysUntilExpiration: req.kycStatus.days_until_expiration
              }
            });
            
            logger.info(`📬 Sent post-claim KYC reminder to user ${req.userAddress}`);
          }
          
        } catch (error) {
          logger.error('❌ Error in post-claim KYC middleware:', error);
        }
      }
    }
  };
  
  next();
};

module.exports = {
  kycSoftLockMiddleware,
  kycAdminMiddleware,
  kycStatusHeaderMiddleware,
  kycAuditMiddleware,
  kycPostClaimMiddleware
};
