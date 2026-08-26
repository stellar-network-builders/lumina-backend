const logger = require('../utils/logger');
const axios = require('axios');
const crypto = require('crypto');
const MilestoneCelebrationWebhook = require('../models/milestoneCelebrationWebhook');
const VestingMilestone = require('../models/vestingMilestone');
const Vault = require('../models/vault');
const Beneficiary = require('../models/beneficiary');
const idempotencyKeyService = require('./idempotencyKeyService');

class MilestoneCelebrationService {
  constructor() {
    this.defaultMessages = {
      cliff_end: (milestoneData) => 
        `🎉 **Cliff Period Ended!** The ${milestoneData.vaultName} cliff has ended! ${milestoneData.vestedAmount.toLocaleString()} tokens are now available for vesting. 🚀`,
      
      vesting_complete: (milestoneData) => 
        `🏆 **Vesting Complete!** The ${milestoneData.vaultName} has fully vested! All ${milestoneData.cumulativeVested.toLocaleString()} tokens are now unlocked! 🎊`,
      
      vesting_increment: (milestoneData) => 
        `📈 **Vesting Milestone!** ${milestoneData.vestedAmount.toLocaleString()} tokens have vested from ${milestoneData.vaultName}. Total vested: ${milestoneData.cumulativeVested.toLocaleString()} tokens. ✨`
    };
  }

  /**
   * Trigger celebration webhooks for a milestone
   */
  async triggerCelebration(milestoneId) {
    try {
      // Get milestone details with associations
      const milestone = await VestingMilestone.findByPk(milestoneId, {
        include: [
          {
            model: Vault,
            as: 'vault',
            attributes: ['id', 'name', 'token_address', 'total_amount']
          },
          {
            model: Beneficiary,
            as: 'beneficiary',
            attributes: ['id', 'email', 'wallet_address']
          }
        ]
      });

      if (!milestone) {
        throw new Error(`Milestone with ID ${milestoneId} not found`);
      }

      // Get active webhooks for this organization
      const webhooks = await MilestoneCelebrationWebhook.findAll({
        where: {
          organization_id: milestone.vault.org_id,
          is_active: true,
          milestone_types: {
            [require('sequelize').Op.contains]: [milestone.milestone_type]
          }
        }
      });

      if (webhooks.length === 0) {
        logger.info(`No active webhooks found for milestone type: ${milestone.milestone_type}`);
        return { triggered: 0, message: 'No matching webhooks found' };
      }

      // Prepare milestone data
      const milestoneData = {
        id: milestone.id,
        type: milestone.milestone_type,
        vaultName: milestone.vault.name || 'Community Pool',
        vaultId: milestone.vault.id,
        tokenAddress: milestone.vault.token_address,
        vestedAmount: parseFloat(milestone.vested_amount),
        cumulativeVested: parseFloat(milestone.cumulative_vested),
        milestoneDate: milestone.milestone_date,
        priceUsd: milestone.price_usd ? parseFloat(milestone.price_usd) : null,
        beneficiaryWallet: milestone.beneficiary?.wallet_address,
        totalVaultAmount: parseFloat(milestone.vault.total_amount)
      };

      // Check amount threshold
      const validWebhooks = webhooks.filter(webhook => 
        !webhook.min_amount_threshold || 
        milestoneData.vestedAmount >= parseFloat(webhook.min_amount_threshold)
      );

      if (validWebhooks.length === 0) {
        logger.info(`No webhooks meet the amount threshold for milestone: ${milestoneData.vestedAmount}`);
        return { triggered: 0, message: 'No webhooks meet amount threshold' };
      }

      // Trigger webhooks in parallel
      const webhookPromises = validWebhooks.map(webhook => 
        this.sendWebhook(webhook, milestoneData)
      );

      const results = await Promise.allSettled(webhookPromises);
      
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      logger.info(`Milestone celebration webhooks: ${successful} successful, ${failed} failed`);

      return {
        triggered: successful,
        failed,
        total: validWebhooks.length,
        milestoneData
      };

    } catch (error) {
      logger.error('Error triggering milestone celebration:', error);
      throw error;
    }
  }

  /**
   * Send webhook to specific endpoint
   */
  async sendWebhook(webhook, milestoneData) {
    try {
      const payload = this.formatPayload(webhook, milestoneData);
      
      // Generate idempotency key for this milestone webhook
      const idempotencyKey = idempotencyKeyService.generateIdempotencyKey(
        'milestone',
        webhook.webhook_url,
        payload,
        `milestone_${milestoneData.id}_${webhook.id}_${milestoneData.type}`
      );

      // Execute webhook with idempotency protection
      const result = await idempotencyKeyService.executeWithIdempotency(
        'milestone',
        webhook.webhook_url,
        payload,
        async () => {
          // Add signature if secret token is configured
          const headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'VestingVault-MilestoneCelebration/1.0',
            'Idempotency-Key': idempotencyKey,
          };

          if (webhook.secret_token) {
            const signature = this.generateSignature(payload, webhook.secret_token);
            headers['X-Vesting-Signature'] = signature;
          }

          const response = await axios.post(webhook.webhook_url, payload, {
            headers,
            timeout: 10000,
            maxRedirects: 3
          });

          if (response.status >= 200 && response.status < 300) {
            return {
              success: true,
              responseStatus: response.status,
              responseBody: response.data,
            };
          }

          throw new Error(`Milestone webhook failed with status ${response.status}`);
        }
      );

      if (result.success) {
        logger.info(`Webhook sent successfully to ${webhook.webhook_type}: ${webhook.webhook_url}${result.fromCache ? ' (from cache)' : ''}`);
        return result.responseBody;
      }

      throw new Error(result.message || 'Milestone webhook operation failed');

    } catch (error) {
      logger.error(`Failed to send webhook to ${webhook.webhook_url}:`, error.message);
      throw error;
    }
  }

  /**
   * Format payload based on webhook type
   */
  formatPayload(webhook, milestoneData) {
    const message = webhook.custom_message_template || 
                   this.defaultMessages[milestoneData.milestone_type]?.(milestoneData) ||
                   `🎉 Milestone achieved: ${milestoneData.type} for ${milestoneData.vaultName}`;

    const basePayload = {
      event: 'milestone_celebration',
      timestamp: new Date().toISOString(),
      milestone: {
        id: milestoneData.id,
        type: milestoneData.type,
        vault_name: milestoneData.vaultName,
        vault_id: milestoneData.vaultId,
        token_address: milestoneData.tokenAddress,
        vested_amount: milestoneData.vestedAmount,
        cumulative_vested: milestoneData.cumulativeVested,
        milestone_date: milestoneData.milestoneDate,
        price_usd: milestoneData.priceUsd,
        beneficiary_wallet: milestoneData.beneficiaryWallet,
        total_vault_amount: milestoneData.totalVaultAmount
      }
    };

    switch (webhook.webhook_type) {
      case 'discord':
        return {
          ...basePayload,
          content: message,
          embeds: [{
            title: `${milestoneData.type.replace('_', ' ').toUpperCase()} Milestone!`,
            description: message,
            color: this.getDiscordColor(milestoneData.type),
            fields: [
              {
                name: 'Vault',
                value: milestoneData.vaultName,
                inline: true
              },
              {
                name: 'Vested Amount',
                value: `${milestoneData.vestedAmount.toLocaleString()} tokens`,
                inline: true
              },
              {
                name: 'Total Vested',
                value: `${milestoneData.cumulativeVested.toLocaleString()} tokens`,
                inline: true
              }
            ],
            timestamp: milestoneData.milestoneDate
          }]
        };

      case 'telegram':
        return {
          ...basePayload,
          text: message,
          parse_mode: 'Markdown'
        };

      case 'custom':
      default:
        return {
          ...basePayload,
          message
        };
    }
  }

  /**
   * Get Discord embed color based on milestone type
   */
  getDiscordColor(milestoneType) {
    const colors = {
      cliff_end: 0x00ff00,      // Green
      vesting_complete: 0xffd700, // Gold
      vesting_increment: 0x00bfff // Deep sky blue
    };
    return colors[milestoneType] || 0x808080; // Gray default
  }

  /**
   * Generate HMAC signature for webhook security
   */
  generateSignature(payload, secret) {
    const payloadString = JSON.stringify(payload);
    return crypto
      .createHmac('sha256', secret)
      .update(payloadString)
      .digest('hex');
  }

  /**
   * Verify webhook signature
   */
  verifySignature(payload, signature, secret) {
    const expectedSignature = this.generateSignature(payload, secret);
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Create new celebration webhook
   */
  async createWebhook(webhookData) {
    try {
      const webhook = await MilestoneCelebrationWebhook.create(webhookData);
      return webhook;
    } catch (error) {
      logger.error('Error creating celebration webhook:', error);
      throw error;
    }
  }

  /**
   * Get webhooks for organization
   */
  async getWebhooks(organizationId) {
    try {
      return await MilestoneCelebrationWebhook.findAll({
        where: { organization_id: organizationId },
        order: [['created_at', 'DESC']]
      });
    } catch (error) {
      logger.error('Error fetching celebration webhooks:', error);
      throw error;
    }
  }

  /**
   * Update webhook
   */
  async updateWebhook(webhookId, updateData) {
    try {
      const [updated] = await MilestoneCelebrationWebhook.update(updateData, {
        where: { id: webhookId },
        returning: true
      });

      if (updated === 0) {
        throw new Error('Webhook not found');
      }

      return await MilestoneCelebrationWebhook.findByPk(webhookId);
    } catch (error) {
      logger.error('Error updating celebration webhook:', error);
      throw error;
    }
  }

  /**
   * Delete webhook
   */
  async deleteWebhook(webhookId) {
    try {
      const deleted = await MilestoneCelebrationWebhook.destroy({
        where: { id: webhookId }
      });

      if (deleted === 0) {
        throw new Error('Webhook not found');
      }

      return true;
    } catch (error) {
      logger.error('Error deleting celebration webhook:', error);
      throw error;
    }
  }
}

module.exports = new MilestoneCelebrationService();
