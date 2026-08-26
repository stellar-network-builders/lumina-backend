const logger = require('../utils/logger');
const partnerManagementService = require('../services/partnerManagementService');
const PartnerUsageTracking = require('../models/partnerUsageTracking');

/**
 * Extract API key from request headers
 * @param {Object} req - Express request object
 * @returns {string|null} API key or null
 */
function extractApiKey(req) {
  // Check Authorization header with Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (token.startsWith('pk_')) {
      return token;
    }
  }

  // Check X-API-Key header
  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader && apiKeyHeader.startsWith('pk_')) {
    return apiKeyHeader;
  }

  return null;
}

/**
 * Partner rate limiting middleware
 * Applies tier-based rate limits for institutional partners
 */
async function partnerRateLimitMiddleware(req, res, next) {
  const apiKey = extractApiKey(req);

  if (!apiKey) {
    // Not a partner request, skip to standard rate limiting
    return next();
  }

  try {
    // Verify API key and check rate limits
    const verification = await partnerManagementService.verifyApiKey(apiKey, req.path);

    if (!verification.valid) {
      if (verification.error === 'Invalid or inactive API key') {
        return res.status(401).json({
          success: false,
          error: 'Invalid API key'
        });
      } else if (verification.error === 'Rate limit exceeded') {
        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded',
          retryAfter: verification.retryAfter,
          rateLimitStatus: verification.rateLimitStatus
        });
      } else {
        return res.status(403).json({
          success: false,
          error: verification.error
        });
      }
    }

    // Attach partner info to request
    req.partner = verification.partner;
    req.partnerRateLimits = verification.rateLimits;

    // Track request asynchronously
    trackPartnerRequest(req, res);

    next();
  } catch (error) {
    logger.error('Error in partner rate limit middleware:', error);
    next();
  }
}

/**
 * Track partner API request for usage analytics
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function trackPartnerRequest(req, res) {
  if (!req.partner) {
    return;
  }

  // Track request when response finishes
  res.on('finish', async () => {
    try {
      const requestData = {
        partner_id: req.partner.id,
        api_key: extractApiKey(req),
        endpoint: req.path,
        request_method: req.method,
        response_status: res.statusCode,
        response_time_ms: calculateResponseTime(req),
        request_size_bytes: Buffer.byteLength(JSON.stringify(req.body) || ''),
        response_size_bytes: parseInt(res.get('Content-Length')) || 0,
        error_message: res.statusCode >= 400 ? 'Request failed' : null,
        ip_address: req.ip || req.connection.remoteAddress,
        user_agent: req.get('user-agent'),
        metadata: {
          query_params: req.query,
          partner_tier: req.partner.partner_tier
        }
      };

      await partnerManagementService.trackRequest(requestData);
    } catch (error) {
      logger.error('Error tracking partner request:', error);
    }
  });
}

/**
 * Calculate response time in milliseconds
 * @param {Object} req - Express request object
 * @returns {number} Response time
 */
function calculateResponseTime(req) {
  if (req.startTime) {
    return Date.now() - req.startTime.getTime();
  }
  return 0;
}

/**
 * Middleware to record request start time for response time calculation
 */
function recordRequestStart(req, res, next) {
  req.startTime = new Date();
  next();
}

module.exports = {
  partnerRateLimitMiddleware,
  recordRequestStart,
  extractApiKey
};
