const logger = require('../utils/logger');
const axios = require('axios');

class CriticalAlertService {
  constructor() {
    this.slackWebhookUrl =
      process.env.VAULT_BALANCE_MONITOR_SLACK_WEBHOOK_URL ||
      process.env.SLACK_WEBHOOK_URL ||
      '';
    this.discordWebhookUrl =
      process.env.VAULT_BALANCE_MONITOR_DISCORD_WEBHOOK_URL ||
      process.env.DISCORD_WEBHOOK_URL ||
      '';
    const configuredTimeout = Number(
      process.env.VAULT_BALANCE_MONITOR_ALERT_TIMEOUT_MS || 10000
    );
    this.timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 10000;
  }

  async sendVaultBalanceDiscrepancyAlert(payload) {
    const deliveries = [];

    if (this.slackWebhookUrl) {
      deliveries.push(
        this.postWebhook(
          this.slackWebhookUrl,
          this.buildSlackPayload(payload),
          'slack'
        )
      );
    }

    if (this.discordWebhookUrl) {
      deliveries.push(
        this.postWebhook(
          this.discordWebhookUrl,
          this.buildDiscordPayload(payload),
          'discord'
        )
      );
    }

    if (deliveries.length === 0) {
      logger.warn(
        'No critical alert webhook configured for vault balance monitoring. ' +
          'Set VAULT_BALANCE_MONITOR_SLACK_WEBHOOK_URL and/or VAULT_BALANCE_MONITOR_DISCORD_WEBHOOK_URL.'
      );
      return { sent: false, channels: [] };
    }

    const results = await Promise.allSettled(deliveries);
    const channels = results.map((result) =>
      result.status === 'fulfilled'
        ? { ...result.value, success: true }
        : { channel: 'unknown', success: false, error: result.reason?.message || 'Unknown error' }
    );
    const sent = channels.some((channel) => channel.success);

    return { sent, channels };
  }

  async postWebhook(url, body, channel) {
    await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: this.timeoutMs,
    });

    return { channel };
  }

  buildSlackPayload(payload) {
    const differenceLabel = payload.differenceDirection === 'surplus'
      ? 'Surplus'
      : 'Shortfall';

    return {
      text: 'Critical Vesting Vault balance discrepancy detected',
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'Critical Vesting Vault Balance Discrepancy',
            emoji: true,
          },
        },
        {
          type: 'section',
          fields: [
            {
              type: 'mrkdwn',
              text: `*Vault Address:*\n\`${payload.vaultAddress}\``,
            },
            {
              type: 'mrkdwn',
              text: `*Token Address:*\n\`${payload.tokenAddress}\``,
            },
            {
              type: 'mrkdwn',
              text: `*On-chain Balance:*\n${this.formatAmount(payload.onChainBalance)}`,
            },
            {
              type: 'mrkdwn',
              text: `*Expected Unvested:*\n${this.formatAmount(payload.expectedUnvestedBalance)}`,
            },
            {
              type: 'mrkdwn',
              text: `*Expected Unclaimed:*\n${this.formatAmount(payload.expectedUnclaimedBalance)}`,
            },
            {
              type: 'mrkdwn',
              text: `*${differenceLabel}:*\n${this.formatAmount(payload.absoluteDifference)}`,
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Checked at ${payload.timestamp}`,
            },
          ],
        },
      ],
    };
  }

  buildDiscordPayload(payload) {
    const differenceLabel = payload.differenceDirection === 'surplus'
      ? 'Surplus'
      : 'Shortfall';

    return {
      content: 'Critical Vesting Vault balance discrepancy detected',
      embeds: [
        {
          title: 'Critical Vesting Vault Balance Discrepancy',
          color: 0xff0000,
          timestamp: payload.timestamp,
          fields: [
            {
              name: 'Vault Address',
              value: this.truncate(payload.vaultAddress),
              inline: false,
            },
            {
              name: 'Token Address',
              value: this.truncate(payload.tokenAddress),
              inline: false,
            },
            {
              name: 'On-chain Balance',
              value: this.formatAmount(payload.onChainBalance),
              inline: true,
            },
            {
              name: 'Expected Unvested',
              value: this.formatAmount(payload.expectedUnvestedBalance),
              inline: true,
            },
            {
              name: 'Expected Unclaimed',
              value: this.formatAmount(payload.expectedUnclaimedBalance),
              inline: true,
            },
            {
              name: differenceLabel,
              value: this.formatAmount(payload.absoluteDifference),
              inline: true,
            },
          ],
        },
      ],
    };
  }

  formatAmount(value) {
    const asNumber = Number(value);
    if (!Number.isFinite(asNumber)) {
      return String(value);
    }

    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 18,
    }).format(asNumber);
  }

  truncate(value) {
    if (!value || value.length <= 20) {
      return value || '';
    }

    return `${value.slice(0, 10)}...${value.slice(-8)}`;
  }
}

module.exports = new CriticalAlertService();
