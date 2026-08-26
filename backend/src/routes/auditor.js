const express = require("express");
const router = express.Router();
const auditorService = require("../services/auditorService");
const logger = require("../utils/logger");
const authService = require("../services/authService");
const {
  authenticateAuditor,
  requireAuditorScope,
} = require("../middleware/auditor.middleware");

// ── Admin Endpoints (manage auditor tokens) ─────────────────────────────────

/**
 * POST /api/auditor/tokens
 * Issue a new auditor token. Requires admin authentication.
 */
router.post("/tokens", authService.authenticate(true), async (req, res) => {
  try {
    const { auditor_name, auditor_firm, org_id, scopes, expires_in_days } =
      req.body;

    if (!auditor_name || !org_id) {
      return res.status(400).json({
        success: false,
        error: "auditor_name and org_id are required",
      });
    }

    const result = await auditorService.issueToken({
      auditorName: auditor_name,
      auditorFirm: auditor_firm,
      orgId: org_id,
      issuedBy: req.user.address,
      scopes,
      expiresInDays: expires_in_days,
    });

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    logger.error("Error issuing auditor token:", error);
    const status = error.message.includes("not found")
      ? 404
      : error.message.includes("Only organization")
        ? 403
        : error.message.includes("required") ||
            error.message.includes("Invalid scopes") ||
            error.message.includes("duration")
          ? 400
          : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/auditor/tokens/:orgId
 * List all auditor tokens for an organization. Requires admin authentication.
 */
router.get(
  "/tokens/:orgId",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const tokens = await auditorService.listTokens(
        req.params.orgId,
        req.user.address,
      );
      res.json({ success: true, data: tokens });
    } catch (error) {
      logger.error("Error listing auditor tokens:", error);
      const status = error.message.includes("not found")
        ? 404
        : error.message.includes("Only organization")
          ? 403
          : 500;
      res.status(status).json({ success: false, error: error.message });
    }
  },
);

/**
 * DELETE /api/auditor/tokens/:tokenId
 * Revoke an auditor token. Requires admin authentication.
 */
router.delete(
  "/tokens/:tokenId",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const result = await auditorService.revokeToken(
        req.params.tokenId,
        req.user.address,
      );
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error("Error revoking auditor token:", error);
      const status = error.message.includes("not found")
        ? 404
        : error.message.includes("Only the organization")
          ? 403
          : error.message.includes("already revoked")
            ? 409
            : 500;
      res.status(status).json({ success: false, error: error.message });
    }
  },
);

// ── Read-Only Auditor Endpoints (use auditor token) ──────────────────────────

/**
 * GET /api/auditor/report/summary
 * Get a high-level audit summary for the scoped organization.
 */
router.get("/report/summary", authenticateAuditor, async (req, res) => {
  try {
    const summary = await auditorService.getAuditSummary(req.auditor.org_id);
    res.json({ success: true, data: summary });
  } catch (error) {
    logger.error("Error fetching audit summary:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/auditor/report/vesting-schedules
 * Get all vesting schedules for the scoped organization.
 */
router.get(
  "/report/vesting-schedules",
  authenticateAuditor,
  requireAuditorScope("vesting_schedules"),
  async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const data = await auditorService.getVestingSchedules(
        req.auditor.org_id,
        { page, limit },
      );
      res.json({ success: true, data });
    } catch (error) {
      logger.error("Error fetching vesting schedules for audit:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

/**
 * GET /api/auditor/report/withdrawal-history
 * Get withdrawal/claims history for the scoped organization.
 */
router.get(
  "/report/withdrawal-history",
  authenticateAuditor,
  requireAuditorScope("withdrawal_history"),
  async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const data = await auditorService.getWithdrawalHistory(
        req.auditor.org_id,
        { page, limit },
      );
      res.json({ success: true, data });
    } catch (error) {
      logger.error("Error fetching withdrawal history for audit:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

/**
 * GET /api/auditor/report/contract-hashes
 * Get on-chain contract / legal document hashes for the scoped organization.
 */
router.get(
  "/report/contract-hashes",
  authenticateAuditor,
  requireAuditorScope("contract_hashes"),
  async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const data = await auditorService.getContractHashes(req.auditor.org_id, {
        page,
        limit,
      });
      res.json({ success: true, data });
    } catch (error) {
      logger.error("Error fetching contract hashes for audit:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

module.exports = router;
