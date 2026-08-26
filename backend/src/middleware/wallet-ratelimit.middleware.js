const logger = require('../utils/logger');
const { walletRateLimiter } = require('../util/wallet-ratelimit.util');

// Express middleware for wallet-based rate limiting
const walletRateLimitMiddleware = async (req, res, next) => {
  try {
    // Get wallet address from x-wallet-address header
    const walletAddress = req.headers['x-wallet-address'];
    
    // If no wallet address, skip wallet-based rate limiting (let other rate limiters handle it)
    if (!walletAddress) {
      return next();
    }

    // Check rate limit for this wallet
    const rateLimitResult = await walletRateLimiter.checkRateLimit(walletAddress);

    // Add rate limit headers to response
    res.set({
      'X-RateLimit-Limit': rateLimitResult.total,
      'X-RateLimit-Remaining': rateLimitResult.remaining,
      'X-RateLimit-Reset': new Date(rateLimitResult.resetTime).toISOString(),
      'X-RateLimit-Policy': `100;w=60;wallet=${walletAddress}`
    });

    // If rate limit exceeded, return 429
    if (!rateLimitResult.allowed) {
      return res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests from this wallet. Please try again later.',
        rateLimitInfo: {
          limit: rateLimitResult.total,
          remaining: rateLimitResult.remaining,
          resetTime: new Date(rateLimitResult.resetTime).toISOString(),
          windowMs: 60 * 1000,
          walletAddress: walletAddress,
          retryAfter: Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
        }
      });
    }

    // Add rate limit info to request for downstream middleware
    req.rateLimit = {
      walletAddress,
      limit: rateLimitResult.total,
      remaining: rateLimitResult.remaining,
      resetTime: rateLimitResult.resetTime
    };

    next();
  } catch (error) {
    logger.error('Wallet rate limit middleware error:', error);
    
    // If there's an error (e.g., Redis down), allow the request but log it
    next();
  }
};

// GraphQL middleware for wallet-based rate limiting
const graphqlWalletRateLimitMiddleware = (options = {}) => {
  return async (resolve, parent, args, context, info) => {
    try {
      const req = context.req;
      
      // Get wallet address from x-wallet-address header
      const walletAddress = req?.headers?.['x-wallet-address'];
      
      // If no wallet address, skip wallet-based rate limiting
      if (!walletAddress) {
        return resolve(parent, args, context, info);
      }

      // Check rate limit for this wallet
      const rateLimitResult = await walletRateLimiter.checkRateLimit(walletAddress);

      // If rate limit exceeded, throw error
      if (!rateLimitResult.allowed) {
        const error = new Error('Too many requests from this wallet. Please try again later.');
        error.extensions = {
          code: 'RATE_LIMIT_EXCEEDED',
          rateLimitInfo: {
            limit: rateLimitResult.total,
            current: rateLimitResult.total - rateLimitResult.remaining,
            remaining: rateLimitResult.remaining,
            resetTime: new Date(rateLimitResult.resetTime).toISOString(),
            windowMs: 60 * 1000,
            walletAddress: walletAddress,
            retryAfter: Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
          }
        };
        throw error;
      }

      // Add rate limit info to context
      context.walletRateLimit = {
        walletAddress,
        limit: rateLimitResult.total,
        remaining: rateLimitResult.remaining,
        resetTime: rateLimitResult.resetTime
      };

      return resolve(parent, args, context, info);
    } catch (error) {
      // If it's our rate limit error, re-throw it
      if (error.extensions?.code === 'RATE_LIMIT_EXCEEDED') {
        throw error;
      }
      
      // If there's another error (e.g., Redis down), allow the request but log it
      logger.error('GraphQL wallet rate limit middleware error:', error);
      return resolve(parent, args, context, info);
    }
  };
};

// Helper function to get current rate limit status for a wallet
const getWalletRateLimitStatus = async (walletAddress) => {
  try {
    return await walletRateLimiter.getRateLimitStatus(walletAddress);
  } catch (error) {
    logger.error('Failed to get wallet rate limit status:', error);
    return null;
  }
};

// Helper function to reset rate limit for a wallet (admin function)
const resetWalletRateLimit = async (walletAddress) => {
  try {
    await walletRateLimiter.resetRateLimit(walletAddress);
    return true;
  } catch (error) {
    logger.error('Failed to reset wallet rate limit:', error);
    return false;
  }
};

module.exports = {
  walletRateLimitMiddleware,
  graphqlWalletRateLimitMiddleware,
  getWalletRateLimitStatus,
  resetWalletRateLimit
};
