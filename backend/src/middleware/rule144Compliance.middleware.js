/**
 * Rule144ComplianceMiddleware - Middleware for enforcing SEC Rule 144 compliance
 * 
 * This middleware provides the security gate that prevents claims before
 * the required holding period is met, providing a secondary security layer.
 */

const rule144ComplianceService = require('../services/rule144ComplianceService');
const Sentry = require('@sentry/node');
const logger = require('../utils/logger');

/**
 * Middleware to check Rule 144 compliance before processing claims
 * This acts as a security gate to prevent violations of securities laws
 */
const rule144ComplianceMiddleware = async (req, res, next) => {
  try {
    // Only apply to claim endpoints
    if (!req.path.includes('/claims')) {
      return next();
    }

    const { user_address, vault_id } = req.body || {};
    
    if (!user_address || !vault_id) {
      return res.status(400).json({
        success: false,
        error: 'user_address and vault_id are required for compliance check'
      });
    }

    // Check compliance status
    const complianceCheck = await rule144ComplianceService.checkClaimCompliance(
      vault_id,
      user_address
    );

    // If not compliant, block the claim
    if (!complianceCheck.isCompliant) {
      logger.warn(`RULE 144 COMPLIANCE BLOCK: Claim blocked for user ${user_address} from vault ${vault_id}`);
      
      // Log compliance violation attempt
      Sentry.captureMessage('Rule 144 compliance violation blocked', {
        level: 'warning',
        tags: { 
          operation: 'rule144ComplianceMiddleware',
          compliance_status: 'BLOCKED'
        },
        extra: {
          user_address,
          vault_id,
          complianceCheck,
          request_body: req.body,
          ip: req.ip,
          user_agent: req.get('User-Agent')
        }
      });

      return res.status(403).json({
        success: false,
        error: 'CLAIM_RESTRICTED_BY_RULE144',
        message: complianceCheck.message,
        data: {
          complianceStatus: complianceCheck.complianceStatus,
          holdingPeriodEndDate: complianceCheck.holdingPeriodEndDate,
          daysUntilCompliance: complianceCheck.daysUntilCompliance,
          isRestrictedSecurity: complianceCheck.isRestrictedSecurity,
          exemptionType: complianceCheck.exemptionType,
          jurisdiction: complianceCheck.jurisdiction
        }
      });
    }

    // If compliant, proceed with claim
    logger.info(`RULE 144 COMPLIANCE PASSED: User ${user_address} claim from vault ${vault_id} approved`);
    
    // Attach compliance data to request for downstream use
    req.rule144Compliance = complianceCheck;
    
    next();
  } catch (error) {
    logger.error('Error in Rule 144 compliance middleware:', error);
    
    // Log middleware error
    Sentry.captureException(error, {
      tags: { operation: 'rule144ComplianceMiddleware' },
      extra: {
        request_body: req.body,
        path: req.path,
        method: req.method
      }
    });

    // In case of compliance check failure, err on the side of caution and block
    return res.status(500).json({
      success: false,
      error: 'COMPLIANCE_CHECK_FAILED',
      message: 'Unable to verify compliance. Please try again later or contact support.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * Middleware to record claim attempts after successful processing
 * This should be applied after the claim is successfully processed
 */
const recordClaimComplianceMiddleware = async (req, res, next) => {
  try {
    // Only apply to successful claim responses
    if (!req.path.includes('/claims') || res.statusCode >= 400) {
      return next();
    }

    const { user_address, vault_id, amount_claimed } = req.body || {};
    
    if (!user_address || !vault_id || !amount_claimed) {
      return next();
    }

    // Record the claim attempt for compliance tracking
    await rule144ComplianceService.recordClaimAttempt(
      vault_id,
      user_address,
      amount_claimed
    );

    logger.info(`RULE 144 CLAIM RECORDED: User ${user_address} claimed ${amount_claimed} from vault ${vault_id}`);
    
    next();
  } catch (error) {
    logger.error('Error recording claim compliance:', error);
    
    // Log error but don't block the response since claim was already processed
    Sentry.captureException(error, {
      tags: { operation: 'recordClaimComplianceMiddleware' },
      extra: {
        request_body: req.body,
        path: req.path
      }
    });

    next();
  }
};

/**
 * Middleware to automatically create compliance records for new beneficiaries
 * This can be applied to vault creation or beneficiary addition endpoints
 */
const autoCreateComplianceMiddleware = async (req, res, next) => {
  try {
    // This middleware would be applied to endpoints that create new beneficiaries
    // Implementation depends on the specific endpoint structure
    
    // Example for beneficiary creation:
    if (req.path.includes('/beneficiaries') && req.method === 'POST') {
      const { vault_id, beneficiary_address, vesting_start_date, top_up_amount } = req.body || {};
      
      if (vault_id && beneficiary_address) {
        try {
          const acquisitionDate = vesting_start_date ? new Date(vesting_start_date) : new Date();
          
          // Validate date to prevent DB errors
          if (isNaN(acquisitionDate.getTime())) {
            throw new Error('Invalid vesting_start_date provided');
          }

          await rule144ComplianceService.createComplianceRecord({
            vaultId: vault_id,
            userAddress: beneficiary_address,
            tokenAddress: req.body?.token_address,
            acquisitionDate: acquisitionDate,
            totalAmountAcquired: top_up_amount || '0',
            isRestrictedSecurity: true // Default to restricted for US investors
          });
          
          logger.info(`Auto-created Rule 144 compliance record for beneficiary ${beneficiary_address} in vault ${vault_id}`);
        } catch (error) {
          // If record already exists, that's fine
          if (!error.message.includes('already exists')) {
            logger.error('Error auto-creating compliance record:', error);
          }
        }
      }
    }
    
    next();
  } catch (error) {
    logger.error('Error in auto-create compliance middleware:', error);
    next();
  }
};

module.exports = {
  rule144ComplianceMiddleware,
  recordClaimComplianceMiddleware,
  autoCreateComplianceMiddleware
};
