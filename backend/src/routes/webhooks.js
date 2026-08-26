const express = require("express");
const router = express.Router();
const Beneficiary = require("../models/beneficiary");
const milestoneCelebrationService = require("../services/milestoneCelebrationService");
const logger = require("../utils/logger");

/**
 * POST /webhooks/ses-bounces
 * Handle AWS SES bounce notifications via SNS
 */
router.post("/ses-bounces", async (req, res) => {
  try {
    // Log the incoming request for debugging
    logger.info("SES webhook received:", JSON.stringify(req.body, null, 2));

    // Handle SNS subscription confirmation
    if (req.body.Type === "SubscriptionConfirmation" && req.body.SubscribeURL) {
      logger.info("Confirming SNS subscription");
      const axios = require("axios");
      await axios.get(req.body.SubscribeURL);
      return res.status(200).json({ message: "Subscription confirmed" });
    }

    // Handle SNS notification (contains SES bounce message)
    if (req.body.Type === "Notification" && req.body.Message) {
      const message = JSON.parse(req.body.Message);

      // Process bounce notifications
      if (message.notificationType === "bounce") {
        const bounce = message.bounce;
        logger.info("Processing bounce notification:", bounce);

        // Handle bounced recipients
        for (const recipient of bounce.bouncedRecipients) {
          const emailAddress = recipient.emailAddress;
          logger.info(`Marking email as invalid: ${emailAddress}`);

          // Update all beneficiaries with this email address
          await Beneficiary.update(
            { email_valid: false },
            {
              where: {
                email: require("../util/cryptoUtils").encryptEmail(
                  emailAddress,
                ),
                email_valid: true, // Only update if currently marked as valid
              },
            },
          );

          logger.info(
            `Updated beneficiaries with email ${emailAddress} as invalid`,
          );
        }
      }

      // Process complaint notifications
      if (message.notificationType === "complaint") {
        const complaint = message.complaint;
        logger.info("Processing complaint notification:", complaint);

        // Handle complained recipients
        for (const recipient of complaint.complainedRecipients) {
          const emailAddress = recipient.emailAddress;
          logger.info(
            `Marking email as invalid due to complaint: ${emailAddress}`,
          );

          // Update all beneficiaries with this email address
          await Beneficiary.update(
            { email_valid: false },
            {
              where: {
                email: require("../util/cryptoUtils").encryptEmail(
                  emailAddress,
                ),
                email_valid: true, // Only update if currently marked as valid
              },
            },
          );

          logger.info(
            `Updated beneficiaries with email ${emailAddress} as invalid due to complaint`,
          );
        }
      }
    }

    res.status(200).json({ message: "Webhook processed successfully" });
  } catch (error) {
    logger.error("Error processing SES webhook:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /webhooks/milestone-celebration
 * Trigger celebration webhooks for major vesting milestones
 */
router.post("/milestone-celebration", async (req, res) => {
  try {
    const { milestone_id } = req.body;

    if (!milestone_id) {
      return res.status(400).json({ 
        error: "Missing required parameter: milestone_id" 
      });
    }

    logger.info(`Triggering milestone celebration for milestone: ${milestone_id}`);
    
    const result = await milestoneCelebrationService.triggerCelebration(milestone_id);
    
    res.status(200).json({
      message: "Milestone celebration webhooks triggered",
      ...result
    });

  } catch (error) {
    logger.error("Error processing milestone celebration webhook:", error);
    res.status(500).json({ 
      error: "Internal server error",
      details: error.message 
    });
  }
});

/**
 * POST /webhooks/celebration-config
 * Create a new milestone celebration webhook configuration
 */
router.post("/celebration-config", async (req, res) => {
  try {
    const webhook = await milestoneCelebrationService.createWebhook(req.body);
    
    res.status(201).json({
      message: "Celebration webhook created successfully",
      webhook
    });

  } catch (error) {
    logger.error("Error creating celebration webhook:", error);
    res.status(500).json({ 
      error: "Internal server error",
      details: error.message 
    });
  }
});

/**
 * GET /webhooks/celebration-config/:organizationId
 * Get all celebration webhooks for an organization
 */
router.get("/celebration-config/:organizationId", async (req, res) => {
  try {
    const { organizationId } = req.params;
    const webhooks = await milestoneCelebrationService.getWebhooks(organizationId);
    
    res.status(200).json({
      message: "Celebration webhooks retrieved successfully",
      webhooks
    });

  } catch (error) {
    logger.error("Error fetching celebration webhooks:", error);
    res.status(500).json({ 
      error: "Internal server error",
      details: error.message 
    });
  }
});

/**
 * PUT /webhooks/celebration-config/:webhookId
 * Update a celebration webhook configuration
 */
router.put("/celebration-config/:webhookId", async (req, res) => {
  try {
    const { webhookId } = req.params;
    const webhook = await milestoneCelebrationService.updateWebhook(webhookId, req.body);
    
    res.status(200).json({
      message: "Celebration webhook updated successfully",
      webhook
    });

  } catch (error) {
    logger.error("Error updating celebration webhook:", error);
    res.status(500).json({ 
      error: "Internal server error",
      details: error.message 
    });
  }
});

/**
 * DELETE /webhooks/celebration-config/:webhookId
 * Delete a celebration webhook configuration
 */
router.delete("/celebration-config/:webhookId", async (req, res) => {
  try {
    const { webhookId } = req.params;
    await milestoneCelebrationService.deleteWebhook(webhookId);
    
    res.status(200).json({
      message: "Celebration webhook deleted successfully"
    });

  } catch (error) {
    logger.error("Error deleting celebration webhook:", error);
    res.status(500).json({ 
      error: "Internal server error",
      details: error.message 
    });
  }
});

module.exports = router;
