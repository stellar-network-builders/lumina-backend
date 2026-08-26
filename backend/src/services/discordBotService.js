const logger = require('../utils/logger');
const { Client, GatewayIntentBits } = require('discord.js');
const { Vault } = require('../models');

class DiscordBotService {
  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
      ]
    });
    this.channelId = process.env.DISCORD_CHANNEL_ID;
    this.updateInterval = null;
    this.isRunning = false;

    this.client.on('ready', () => {
      logger.info(`Discord bot logged in as ${this.client.user.tag}`);
    });

    this.client.on('error', (error) => {
      logger.error('Discord bot error:', error);
    });
  }

  /**
   * Calculate Total Value Locked (TVL) across all active vaults
   * @returns {Promise<number>} Total TVL in USD
   */
  async calculateTVL() {
    try {
      const vaults = await Vault.findAll({
        where: { is_active: true }
      });

      let totalTVL = 0;
      for (const vault of vaults) {
        totalTVL += parseFloat(vault.total_amount || 0);
      }

      return totalTVL;
    } catch (error) {
      logger.error('Error calculating TVL:', error);
      return 0;
    }
  }

  /**
   * Format TVL value to human-readable string
   * @param {number} tvl - TVL value
   * @returns {string} Formatted TVL string (e.g., "$5M", "$500K")
   */
  formatTVL(tvl) {
    if (tvl >= 1000000) {
      return `$${(tvl / 1000000).toFixed(1)}M`;
    } else if (tvl >= 1000) {
      return `$${(tvl / 1000).toFixed(1)}K`;
    }
    return `$${tvl.toFixed(2)}`;
  }

  /**
   * Update Discord channel topic with current TVL
   */
  async updateChannelTopic() {
    try {
      if (!this.channelId) {
        logger.warn('DISCORD_CHANNEL_ID not set, skipping channel topic update');
        return;
      }

      const channel = await this.client.channels.fetch(this.channelId);
      if (!channel) {
        logger.error(`Discord channel ${this.channelId} not found`);
        return;
      }

      const tvl = await this.calculateTVL();
      const formattedTVL = this.formatTVL(tvl);
      const newTopic = `Current TVL: ${formattedTVL}`;

      await channel.setTopic(newTopic);
      logger.info(`Updated Discord channel topic to: ${newTopic}`);
    } catch (error) {
      logger.error('Error updating Discord channel topic:', error);
    }
  }

  /**
   * Start the Discord bot and begin hourly updates
   */
  async start() {
    try {
      if (this.isRunning) {
        logger.info('Discord bot is already running');
        return;
      }

      const token = process.env.DISCORD_BOT_TOKEN;
      if (!token) {
        logger.warn('DISCORD_BOT_TOKEN not set, Discord bot will not start');
        return;
      }

      await this.client.login(token);
      this.isRunning = true;

      // Update channel topic immediately on start
      await this.updateChannelTopic();

      // Schedule hourly updates (every hour = 3600000 ms)
      this.updateInterval = setInterval(() => {
        this.updateChannelTopic();
      }, 3600000);

      logger.info('Discord bot started with hourly TVL updates');
    } catch (error) {
      logger.error('Error starting Discord bot:', error);
    }
  }

  /**
   * Stop the Discord bot and clear the update interval
   */
  async stop() {
    try {
      if (this.updateInterval) {
        clearInterval(this.updateInterval);
        this.updateInterval = null;
      }

      if (this.client) {
        await this.client.destroy();
      }

      this.isRunning = false;
      logger.info('Discord bot stopped');
    } catch (error) {
      logger.error('Error stopping Discord bot:', error);
    }
  }
}

module.exports = new DiscordBotService();
