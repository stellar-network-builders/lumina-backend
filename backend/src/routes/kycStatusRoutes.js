const express = require("express");
const router = express.Router();
const { KycStatus } = require("../models");
// jobs/kycExpirationWorker exports a singleton instance (not a class).
const kycWorker = require("../jobs/kycExpirationWorker");
const authService = require("../services/authService");
const AuditService = require("../services/auditService");
const sep10Auth = require("../middleware/sep10Auth.middleware");
const { Op } = require("sequelize");
const logger = require("../utils/logger");

// GET /api/kyc-status/user/:userAddress
// Get KYC status for a specific user
router.get(
  "/user/:userAddress",
  sep10Auth.authenticate(), // Require SEP-10 JWT authentication
  async (req, res) => {
    try {
      const { userAddress } = req.params;
      const { includeExpired = "false" } = req.query;

      // Validate user address
      if (!userAddress) {
        return res.status(400).json({
          success: false,
          message: "User address is required",
        });
      }

      const kycStatus = await KycStatus.findOne({
        where: { user_address: userAddress },
        include: [
          {
            model: require("../models").User,
            as: "user",
            required: false,
            attributes: ["address", "email"],
          },
        ],
      });

      if (!kycStatus) {
        return res.status(404).json({
          success: false,
          message: "KYC status not found for this user",
        });
      }

      // Include expired status if requested
      let resultData = {
        userAddress,
        kycStatus: kycStatus.toJSON(),
        lastUpdated: kycStatus.updated_at,
      };

      if (includeExpired === "true") {
        const expiredStatuses = await KycStatus.findAll({
          where: {
            user_address: userAddress,
            kyc_status: "EXPIRED",
          },
          order: [["expiration_date", "DESC"]],
          limit: 5,
        });

        resultData.expiredHistory = expiredStatuses.map((status) =>
          status.toJSON(),
        );
      }

      res.json({
        success: true,
        data: resultData,
      });
    } catch (error) {
      logger.error("Error getting KYC status:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// GET /api/kyc-status/expiring
// Get all users with expiring KYC statuses
router.get(
  "/expiring",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      const { days = 7, includeCritical = "true" } = req.query;

      // Validate parameters
      if (isNaN(days) || days < 1 || days > 30) {
        return res.status(400).json({
          success: false,
          message: "Days parameter must be between 1 and 30",
        });
      }

      const thresholdDate = new Date();
      thresholdDate.setDate(thresholdDate.getDate() - days);
      thresholdDate.setHours(0, 0, 0, 0);

      const whereClause = {
        expiration_date: {
          [Op.lte]: thresholdDate,
          [Op.gt]: new Date(),
        },
        is_active: true,
        kyc_status: {
          [Op.notIn]: ["EXPIRED", "SOFT_LOCKED"],
        },
      };

      if (includeCritical === "true") {
        // Include only critical expirations (≤3 days)
        const criticalThresholdDate = new Date();
        criticalThresholdDate.setDate(criticalThresholdDate.getDate() - 3);
        whereClause.expiration_date[Op.lte] = criticalThresholdDate;
      }

      const expiringStatuses = await KycStatus.findAll({
        where: whereClause,
        include: [
          {
            model: require("../models").User,
            as: "user",
            required: false,
            attributes: ["address", "email"],
          },
        ],
        order: [["expiration_date", "ASC"]],
      });

      const result = expiringStatuses.map((status) => ({
        ...status.toJSON(),
        daysUntilExpiration: status.days_until_expiration,
        isCritical: status.days_until_expiration <= 3,
      }));

      res.json({
        success: true,
        data: {
          thresholdDays: days,
          expiringUsers: result,
          summary: {
            total: result.length,
            critical: result.filter((s) => s.isCritical).length,
            soonExpiring: result.filter((s) => !s.isCritical).length,
          },
        },
      });
    } catch (error) {
      logger.error("Error getting expiring KYC statuses:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// GET /api/kyc-status/expired
// Get all users with expired KYC statuses
router.get(
  "/expired",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      const { limit = 50, offset = 0 } = req.query;

      const expiredStatuses = await KycStatus.findAll({
        where: {
          kyc_status: "EXPIRED",
          is_active: true,
        },
        include: [
          {
            model: require("../models").User,
            as: "user",
            required: false,
            attributes: ["address", "email"],
          },
        ],
        order: [["expiration_date", "DESC"]],
        limit: parseInt(limit),
        offset: parseInt(offset),
      });

      const result = expiredStatuses.map((status) => ({
        ...status.toJSON(),
        daysExpired: Math.abs(status.days_until_expiration) || 0,
      }));

      res.json({
        success: true,
        data: {
          expiredUsers: result,
          summary: {
            total: result.length,
            averageDaysExpired:
              result.reduce((sum, s) => sum + s.daysExpired, 0) / result.length,
          },
        },
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: result.length === parseInt(limit),
        },
      });
    } catch (error) {
      logger.error("Error getting expired KYC statuses:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// GET /api/kyc-status/statistics
// Get KYC status statistics
router.get(
  "/statistics",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      const stats = await kycWorker.getDailyStatistics();

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      logger.error("Error getting KYC statistics:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// POST /api/kyc-status/worker/start
// Start the KYC expiration worker
router.post(
  "/worker/start",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      await kycWorker.start();

      res.json({
        success: true,
        message: "KYC expiration worker started",
      });
    } catch (error) {
      logger.error("Error starting KYC expiration worker:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// POST /api/kyc-status/worker/stop
// Stop the KYC expiration worker
router.post(
  "/worker/stop",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      await kycWorker.stop();

      res.json({
        success: true,
        message: "KYC expiration worker stopped",
      });
    } catch (error) {
      logger.error("Error stopping KYC expiration worker:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// POST /api/kyc-status/worker/check
// Manually trigger expiration check
router.post(
  "/worker/check",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      await kycWorker.checkExpiringStatuses();

      res.json({
        success: true,
        message: "Manual expiration check completed",
      });
    } catch (error) {
      logger.error("Error triggering manual expiration check:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// POST /api/kyc-status/:kycId/soft-lock
// Apply soft lock to a user's KYC status
router.post(
  "/:kycId/soft-lock",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      const { kycId } = req.params;
      const { reason } = req.body;

      if (!reason) {
        return res.status(400).json({
          success: false,
          message: "Reason is required for soft lock",
        });
      }

      const kycStatus = await KycStatus.findByPk(kycId);

      if (!kycStatus) {
        return res.status(404).json({
          success: false,
          message: "KYC status not found",
        });
      }

      await kycStatus.applySoftLock(reason);

      res.json({
        success: true,
        message: `Soft lock applied: ${reason}`,
      });
    } catch (error) {
      logger.error("Error applying soft lock:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// POST /api/kyc-status/:kycId/remove-soft-lock
// Remove soft lock from a user's KYC status
router.post(
  "/:kycId/remove-soft-lock",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      const { kycId } = req.params;
      const { reason } = req.body;

      const kycStatus = await KycStatus.findByPk(kycId);

      if (!kycStatus) {
        return res.status(404).json({
          success: false,
          message: "KYC status not found",
        });
      }

      await kycStatus.removeSoftLock(reason);

      res.json({
        success: true,
        message: `Soft lock removed: ${reason}`,
      });
    } catch (error) {
      logger.error("Error removing soft lock:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// POST /api/kyc-status/:kycId/update-risk-score
// Update risk score for a user's KYC status
router.post(
  "/:kycId/update-risk-score",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      const { kycId } = req.params;
      const { riskScore } = req.body;

      if (typeof riskScore !== "number" || riskScore < 0 || riskScore > 1) {
        return res.status(400).json({
          success: false,
          message: "Risk score must be a number between 0 and 1",
        });
      }

      const kycStatus = await KycStatus.findByPk(kycId);

      if (!kycStatus) {
        return res.status(404).json({
          success: false,
          message: "KYC status not found",
        });
      }

      await kycStatus.updateRiskScore(riskScore);

      res.json({
        success: true,
        message: `Risk score updated to ${riskScore}`,
      });
    } catch (error) {
      logger.error("Error updating risk score:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// GET /api/kyc-status/worker/status
// Get worker status
router.get(
  "/worker/status",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      const status = kycWorker.getStatus();

      res.json({
        success: true,
        data: status,
      });
    } catch (error) {
      logger.error("Error getting worker status:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// GET /api/kyc-status/compliance-report
// Generate compliance report
router.get(
  "/compliance-report",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      const { days = 30 } = req.query;

      if (isNaN(days) || days < 1 || days > 90) {
        return res.status(400).json({
          success: false,
          message: "Days parameter must be between 1 and 90",
        });
      }

      const stats = await kycWorker.getDailyStatistics();

      // Generate compliance report
      const reportData = {
        reportPeriod: days,
        generatedAt: new Date(),
        summary: {
          totalUsers: stats.totalUsers,
          verifiedUsers: stats.verifiedUsers,
          pendingUsers: stats.pendingUsers,
          expiredUsers: stats.expiredUsers,
          complianceRate: stats.complianceRate,
          softLockedUsers: stats.softLocked,
          riskDistribution: await this.getRiskDistribution(),
        },
        recommendations: this.generateComplianceRecommendations(stats),
      };

      res.json({
        success: true,
        data: reportData,
      });
    } catch (error) {
      logger.error("Error generating compliance report:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// Helper function to get risk distribution
async function getRiskDistribution() {
  try {
    const riskBreakdown = await KycStatus.findAll({
      attributes: [
        "risk_level",
        [
          require("sequelize").fn("COUNT", require("sequelize").col("id")),
          "count",
        ],
      ],
      where: {
        is_active: true,
      },
      group: ["risk_level"],
      raw: true,
    });

    return riskBreakdown.reduce((acc, item) => {
      acc[item.risk_level] = parseInt(item.count);
      return acc;
    }, {});
  } catch (error) {
    logger.error("Error getting risk distribution:", error);
    return {};
  }
}

// Helper function to generate compliance recommendations
function generateComplianceRecommendations(stats) {
  const recommendations = [];

  if (stats.expiredUsers > 0) {
    recommendations.push({
      type: "compliance_action",
      priority: "critical",
      title: "Expired KYC Statuses Require Attention",
      description: `${stats.expiredUsers} users have expired KYC verification. Immediate action required to restore account access and ensure compliance.`,
      actionItems: [
        "Reach out to expired users with re-verification instructions",
        "Consider temporary restrictions until re-verification is complete",
        "Review verification process for potential issues causing expirations",
        "Update risk scores for expired users to maximum",
      ],
    });
  }

  if (stats.softLockedUsers > 0) {
    recommendations.push({
      type: "compliance_review",
      priority: "high",
      title: "Soft-Locked Users Require Review",
      description: `${stats.softLockedUsers} users are currently soft-locked. Review the circumstances and determine if additional restrictions are necessary.`,
      actionItems: [
        "Review soft-lock reasons and timing",
        "Assess if soft-lock criteria are appropriate",
        "Consider graduated unlock process based on risk assessment",
      ],
    });
  }

  if (stats.complianceRate < 95) {
    recommendations.push({
      type: "process_improvement",
      priority: "medium",
      title: "Low Compliance Rate Detected",
      description: `Current compliance rate is ${stats.complianceRate}%. Consider improving the KYC verification process or user education.`,
      actionItems: [
        "Analyze common reasons for verification failures",
        "Improve user guidance and support documentation",
        "Consider automated reminders for expiring KYC",
      ],
    });
  }

  if (stats.pendingUsers > stats.totalUsers * 0.1) {
    recommendations.push({
      type: "user_engagement",
      priority: "medium",
      title: "High Number of Pending KYC",
      description: `${stats.pendingUsers} users (${((stats.pendingUsers / stats.totalUsers) * 100).toFixed(1)}%) have pending KYC verification. This may impact user experience and compliance.`,
      actionItems: [
        "Send reminder notifications for pending verifications",
        "Offer additional support channels for KYC completion",
        "Identify and address common verification barriers",
        "Consider simplifying the verification process",
      ],
    });
  }

  return recommendations;
}

// ── ADMIN APPROVAL ENDPOINTS ─────────────────────────────────────────────────

// GET /api/kyc-status/admin/kyc/pending
// Get all pending KYC applications for manual review
router.get(
  "/admin/kyc/pending",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 20,
        riskLevel,
        sortBy = "created_at",
        sortOrder = "DESC",
      } = req.query;

      // Validate pagination
      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      if (pageNum < 1 || limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
          success: false,
          message: "Invalid pagination parameters",
        });
      }

      // Build where clause
      const whereClause = {
        kyc_status: "PENDING",
        is_active: true,
      };

      if (riskLevel) {
        whereClause.risk_level = riskLevel;
      }

      // Build order clause
      const orderClause = [];
      const validSortFields = [
        "created_at",
        "updated_at",
        "risk_level",
        "user_address",
      ];
      if (validSortFields.includes(sortBy)) {
        orderClause.push([
          sortBy,
          sortOrder.toUpperCase() === "ASC" ? "ASC" : "DESC",
        ]);
      } else {
        orderClause.push(["created_at", "DESC"]);
      }

      const { count, rows } = await KycStatus.findAndCountAll({
        where: whereClause,
        include: [
          {
            model: require("../models").User,
            as: "user",
            required: false,
            attributes: ["address", "email"],
          },
        ],
        order: orderClause,
        limit: limitNum,
        offset: (pageNum - 1) * limitNum,
        attributes: {
          exclude: ["id_document_image", "proof_of_address_image"], // Don't send sensitive images
        },
      });

      res.json({
        success: true,
        data: {
          pendingApplications: rows,
          pagination: {
            currentPage: pageNum,
            totalPages: Math.ceil(count / limitNum),
            totalItems: count,
            itemsPerPage: limitNum,
          },
        },
      });
    } catch (error) {
      logger.error("Error getting pending KYC applications:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// POST /api/kyc-status/admin/kyc/approve
// Manually approve or reject a KYC application
router.post(
  "/admin/kyc/approve",
  sep10Auth.authenticateAdmin(), // Require SEP-10 admin authentication
  async (req, res) => {
    try {
      const { kycId, action, reason, notes } = req.body;

      // Validate input
      if (!kycId || !action) {
        return res.status(400).json({
          success: false,
          message: "kycId and action are required",
        });
      }

      if (!["approve", "reject"].includes(action)) {
        return res.status(400).json({
          success: false,
          message: 'Action must be either "approve" or "reject"',
        });
      }

      // Find the KYC status
      const kycStatus = await KycStatus.findByPk(kycId);
      if (!kycStatus) {
        return res.status(404).json({
          success: false,
          message: "KYC application not found",
        });
      }

      if (kycStatus.kyc_status !== "PENDING") {
        return res.status(400).json({
          success: false,
          message: "KYC application is not in PENDING status",
        });
      }

      // Update the KYC status
      const newStatus = action === "approve" ? "VERIFIED" : "REJECTED";
      const updateData = {
        kyc_status: newStatus,
        manual_review_date: new Date(),
        manual_review_reason: reason,
        manual_review_notes: notes,
        reviewed_by: req.user?.address || "admin", // Assuming auth middleware sets req.user
      };

      // Set expiration date for approved applications (5 years from now)
      if (action === "approve") {
        const expirationDate = new Date();
        expirationDate.setFullYear(expirationDate.getFullYear() + 5);
        updateData.expiration_date = expirationDate;
      }

      await kycStatus.update(updateData);

      // Create notification for the user
      const notificationService = require("../services/notificationService");
      const notificationMessage =
        action === "approve"
          ? "Your KYC application has been approved. You now have full access to the platform."
          : `Your KYC application has been rejected. Reason: ${reason || "Manual review"}`;

      await notificationService.createKycNotification(
        kycStatus.id,
        action === "approve" ? "KYC_APPROVED" : "KYC_REJECTED",
        notificationMessage,
        "admin_manual_review",
      );

      // Immutable Audit Log
      await AuditService.logAction({
        adminPubkey: req.user?.address || "admin",
        action: action === "approve" ? AuditService.ACTIONS.APPROVE_KYC : AuditService.ACTIONS.REJECT_KYC,
        ipAddress: req.ip || req.headers['x-forwarded-for'] || 'unknown',
        payload: { kycId, action, reason, notes },
        resourceId: kycId
      });

      res.json({
        success: true,
        message: `KYC application ${action}d successfully`,
        data: {
          kycId,
          newStatus,
          reviewedAt: updateData.manual_review_date,
        },
      });
    } catch (error) {
      logger.error("Error processing KYC approval:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  },
);

// ── ZK-PROOF GENERATION ENDPOINTS ─────────────────────────────────────────────

// POST /api/kyc-status/zk-proof
// Generate ZK-proof for verified user proving age >= 18 without revealing birthdate
router.post(
  "/zk-proof",
  sep10Auth.authenticate(), // Require SEP-10 JWT authentication
  async (req, res) => {
    try {
      const { userAddress } = req.body;

      // Validate input
      if (!userAddress) {
        return res.status(400).json({
          success: false,
          message: "userAddress is required",
        });
      }

      // Get user's KYC status to ensure they are verified
      const kycStatus = await KycStatus.findOne({
        where: { user_address: userAddress },
      });

      if (!kycStatus) {
        return res.status(404).json({
          success: false,
          message: "KYC status not found for this user",
        });
      }

      if (kycStatus.kyc_status !== "VERIFIED") {
        return res.status(403).json({
          success: false,
          message: "User must have VERIFIED KYC status to generate ZK-proof",
        });
      }

      // Check if user has required data for age verification
      if (!kycStatus.birth_date) {
        return res.status(400).json({
          success: false,
          message: "User birth date is required for age verification proof",
        });
      }

      // Prepare user data for ZK-proof generation
      const userData = {
        userAddress: kycStatus.user_address,
        birthDate: kycStatus.birth_date,
        firstName: kycStatus.first_name,
        lastName: kycStatus.last_name,
      };

      // Generate ZK-proof
      const ZKProofService = require("../services/zkProofService");
      const zkService = new ZKProofService();
      const proofResult = await zkService.generateAgeProof(userData);

      res.json({
        success: true,
        message: "ZK-proof generated successfully",
        data: proofResult,
      });
    } catch (error) {
      logger.error("Error generating ZK-proof:", error);
      res.status(500).json({
        success: false,
        message: error.message || "Failed to generate ZK-proof",
      });
    }
  },
);

module.exports = router;
