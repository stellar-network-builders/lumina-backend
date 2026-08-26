const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");

/**
 * SEP-10 JWT Authentication Middleware
 *
 * This middleware validates SEP-10 JWT tokens according to the Stellar Ecosystem Proposal:
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
 *
 * Key requirements:
 * - JWT must be signed by the anchor's server
 * - Must contain 'sub' claim with Stellar public key
 * - Must contain 'iss' claim with anchor's server URL
 * - Must contain proper expiration time
 * - Users can only access their own PII (sub claim matches requested resource)
 */
class SEP10AuthMiddleware {
  constructor() {
    // No cache needed for simple JWT verification
  }

  /**
   * Verify JWT token with Ed25519 signature
   * @param {string} token - JWT token to verify
   * @param {string} serverPublicKey - Anchor's server public key
   * @returns {Promise<object>} Decoded token payload
   */
  async verifyJWT(token, serverPublicKey) {
    try {
      // For SEP-10, we need to handle Ed25519 signatures
      // Since jsonwebtoken doesn't natively support Ed25519, we'll use a basic verification
      // In production, you should use stellar-sdk or a library that supports Ed25519 JWT verification

      const decoded = jwt.verify(token, serverPublicKey, {
        algorithms: ["EdDSA"], // SEP-10 requires Ed25519 signatures
        clockTolerance: 30, // Allow 30 seconds clock skew
      });

      return decoded;
    } catch (error) {
      throw new Error(`JWT verification failed: ${error.message}`);
    }
  }

  /**
   * Extract JWT token from Authorization header
   * @param {object} req - Express request object
   * @returns {string|null} JWT token or null
   */
  extractToken(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return authHeader.substring(7);
    }
    return null;
  }

  /**
   * Validate SEP-10 JWT token structure and claims
   * @param {object} decoded - Decoded JWT payload
   * @returns {object} Validation result
   */
  validateSEP10Claims(decoded) {
    const errors = [];

    // Required claims according to SEP-10
    const requiredClaims = ["iss", "sub", "exp", "iat"];
    for (const claim of requiredClaims) {
      if (!(claim in decoded)) {
        errors.push(`Missing required claim: ${claim}`);
      }
    }

    // Validate 'sub' is a valid Stellar public key
    if (decoded.sub && !this.isValidStellarPublicKey(decoded.sub)) {
      errors.push('Invalid "sub" claim - must be a valid Stellar public key');
    }

    // Validate 'iss' is a valid URL
    if (decoded.iss) {
      try {
        new URL(decoded.iss);
      } catch {
        errors.push('Invalid "iss" claim - must be a valid URL');
      }
    }

    // Check token expiration
    if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
      errors.push("Token has expired");
    }

    // Check issued at time (should not be in future)
    if (decoded.iat && decoded.iat > Math.floor(Date.now() / 1000) + 30) {
      errors.push("Token issued in future");
    }

    return {
      isValid: errors.length === 0,
      errors,
      stellarPublicKey: decoded.sub,
    };
  }

  /**
   * Basic validation for Stellar public key format
   * @param {string} publicKey - Public key to validate
   * @returns {boolean} Whether the key appears to be valid
   */
  isValidStellarPublicKey(publicKey) {
    // Stellar public keys start with 'G' and are 56 characters long
    // This is basic validation - for production, use stellar-sdk
    return (
      typeof publicKey === "string" &&
      publicKey.startsWith("G") &&
      publicKey.length === 56 &&
      /^[GABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz234567]+$/.test(
        publicKey,
      )
    );
  }

  /**
   * Check if user is authorized to access the requested resource
   * @param {string} userPublicKey - User's Stellar public key from JWT
   * @param {object} req - Express request object
   * @returns {boolean} Whether user is authorized
   */
  isUserAuthorized(userPublicKey, req) {
    const requestedAddress =
      req.params.userAddress || req.query.account || req.body.userAddress;

    // If no specific user address is being requested, allow access
    if (!requestedAddress) {
      return true;
    }

    // User can only access their own data
    return userPublicKey === requestedAddress;
  }

  /**
   * SEP-10 authentication middleware
   * @param {object} options - Configuration options
   * @returns {function} Express middleware function
   */
  authenticate(options = {}) {
    const {
      serverPublicKey = process.env.STELLAR_SERVER_PUBLIC_KEY,
      requireUserMatch = true, // Whether to enforce user can only access own data
    } = options;

    return async (req, res, next) => {
      try {
        // Extract token from header
        const token = this.extractToken(req);

        if (!token) {
          return res.status(401).json({
            success: false,
            error: "authentication_required",
            message: "SEP-10 JWT token required in Authorization header",
          });
        }

        // Verify server public key is available
        if (!serverPublicKey) {
          return res.status(500).json({
            success: false,
            error: "server_configuration_error",
            message: "Server public key not configured",
          });
        }

        // Verify JWT signature and decode
        let decoded;
        try {
          decoded = await this.verifyJWT(token, serverPublicKey);
        } catch (error) {
          return res.status(401).json({
            success: false,
            error: "invalid_token",
            message: "Invalid JWT signature or format",
            details: error.message,
          });
        }

        // Validate SEP-10 specific claims
        const claimValidation = this.validateSEP10Claims(decoded);
        if (!claimValidation.isValid) {
          return res.status(401).json({
            success: false,
            error: "invalid_claims",
            message: "Invalid SEP-10 JWT claims",
            details: claimValidation.errors,
          });
        }

        // Check user authorization for specific resources
        if (
          requireUserMatch &&
          !this.isUserAuthorized(claimValidation.stellarPublicKey, req)
        ) {
          return res.status(403).json({
            success: false,
            error: "access_denied",
            message: "Access denied: Users can only access their own data",
          });
        }

        // Add user info to request object
        req.sep10User = {
          stellarPublicKey: claimValidation.stellarPublicKey,
          issuer: decoded.iss,
          issuedAt: new Date(decoded.iat * 1000),
          expiresAt: new Date(decoded.exp * 1000),
        };

        next();
      } catch (error) {
        logger.error("SEP-10 authentication error:", error);
        return res.status(500).json({
          success: false,
          error: "authentication_error",
          message: "Authentication failed",
          details:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    };
  }

  /**
   * Middleware for admin endpoints (requires additional validation)
   * @returns {function} Express middleware function
   */
  authenticateAdmin() {
    return this.authenticate({
      requireUserMatch: false, // Admin endpoints may access any user data
    });
  }
}

module.exports = new SEP10AuthMiddleware();
