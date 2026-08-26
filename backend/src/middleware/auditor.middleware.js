const auditorService = require("../services/auditorService");
const logger = require("../utils/logger");

/**
 * Middleware to authenticate auditor tokens.
 * Attaches auditor metadata and org scope to `req.auditor`.
 */
const authenticateAuditor = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error:
          "Auditor token required. Provide a Bearer token in the Authorization header.",
      });
    }

    const token = authHeader.substring(7);
    const auditor = await auditorService.verifyToken(token);

    // Attach auditor context to the request
    req.auditor = {
      id: auditor.id,
      org_id: auditor.org_id,
      scopes: auditor.scopes,
      auditor_name: auditor.auditor_name,
      auditor_firm: auditor.auditor_firm,
      expires_at: auditor.expires_at,
    };

    next();
  } catch (error) {
    logger.error("Auditor authentication error:", error.message);
    return res.status(401).json({
      success: false,
      error: error.message || "Auditor authentication failed",
    });
  }
};

/**
 * Middleware factory to check if the auditor has a specific scope.
 * @param {string} requiredScope - The scope to check for
 */
const requireAuditorScope = (requiredScope) => {
  return (req, res, next) => {
    if (!req.auditor) {
      return res.status(401).json({
        success: false,
        error: "Auditor authentication required",
      });
    }

    if (!req.auditor.scopes.includes(requiredScope)) {
      return res.status(403).json({
        success: false,
        error: `Access denied. Required scope: ${requiredScope}`,
      });
    }

    next();
  };
};

module.exports = { authenticateAuditor, requireAuditorScope };
