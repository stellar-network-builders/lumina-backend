const logger = require('../utils/logger');
const axios = require('axios');
const cron = require('node-cron');
const { Op } = require('sequelize');
const {
  Vault,
  Beneficiary,
  Organization,
  Token,
  DeviceToken,
  VaultLiquidityAlert,
} = require('../models');
const emailService = require('./emailService');
const firebaseService = require('./firebaseService');

class LiquidityMonitorService {
  constructor() {
    this.cronJob = null;
    this.horizonUrl = (
      process.env.LIQUIDITY_MONITOR_HORIZON_URL ||
      process.env.STELLAR_RPC_URL ||
      'https://horizon-testnet.stellar.org'
    ).replace(/\/$/, '');
    this.quoteAsset = process.env.LIQUIDITY_MONITOR_QUOTE_ASSET || '';
    this.orderUsd = this.parsePositiveNumber(process.env.LIQUIDITY_ALERT_ORDER_USD, 1000);
    this.maxSlippage = this.parsePositiveNumber(process.env.LIQUIDITY_ALERT_MAX_SLIPPAGE, 0.05);
    this.cronSchedule = process.env.LIQUIDITY_MONITOR_CRON || '15 * * * *';
    this.orderBookTimeoutMs = this.parsePositiveNumber(process.env.LIQUIDITY_MONITOR_TIMEOUT_MS, 10000);
  }

  start() {
    if (!this.isConfigured()) {
      logger.warn(
        'Liquidity monitor is disabled. Set LIQUIDITY_MONITOR_QUOTE_ASSET to a Stellar asset like USDC:G...'
      );
      return;
    }

    this.cronJob = cron.schedule(this.cronSchedule, async () => {
      logger.info('Running liquidity monitor cron job...');
      await this.monitorAllVaults();
    });

    logger.info(`Liquidity monitor cron job started with schedule ${this.cronSchedule}.`);
  }

  isConfigured() {
    return Boolean(this.quoteAsset);
  }

  parsePositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  async monitorAllVaults() {
    if (!this.isConfigured()) {
      return { checked: 0, alerted: 0, skipped: 0 };
    }

    const vaults = await Vault.findAll({
      include: [
        {
          model: Beneficiary,
          as: 'beneficiaries',
          required: false,
        },
        {
          model: Organization,
          as: 'organization',
          required: false,
        },
      ],
    });

    const tokenCache = new Map();
    let alerted = 0;
    let skipped = 0;

    for (const vault of vaults) {
      try {
        const token = await this.getTokenMetadata(vault.token_address, tokenCache);
        const result = await this.evaluateVaultLiquidity(vault, token);
        const didAlert = await this.persistAndNotify(vault, result);
        if (didAlert) {
          alerted += 1;
        }
      } catch (error) {
        skipped += 1;
        logger.error(`Liquidity monitor failed for vault ${vault.address}:`, error.message);
        await this.markUnavailable(vault, error.message);
      }
    }

    return {
      checked: vaults.length,
      alerted,
      skipped,
    };
  }

  async getTokenMetadata(tokenAddress, cache) {
    if (!tokenAddress) {
      return null;
    }

    if (cache.has(tokenAddress)) {
      return cache.get(tokenAddress);
    }

    const token = await Token.findOne({
      where: { address: tokenAddress },
    });
    cache.set(tokenAddress, token);
    return token;
  }

  async evaluateVaultLiquidity(vault, token) {
    const sellAsset = this.parseAsset(vault.token_address, token?.symbol);
    const buyAsset = this.parseAsset(this.quoteAsset);
    const orderBook = await this.fetchOrderBook(sellAsset, buyAsset);
    const topBidPrice = this.getTopBidPrice(orderBook.bids || []);

    if (topBidPrice <= 0) {
      throw new Error('No actionable bids available in the Stellar order book');
    }

    const sellAmount = this.orderUsd / topBidPrice;
    const execution = this.simulateMarketSell(orderBook.bids || [], sellAmount);
    const slippage = execution.filledAmount > 0
      ? Math.max(0, (topBidPrice - execution.averagePrice) / topBidPrice)
      : 1;

    return {
      status: execution.insufficientDepth || slippage > this.maxSlippage ? 'alerting' : 'healthy',
      slippage,
      referencePrice: topBidPrice,
      executionPrice: execution.averagePrice,
      sellAmount,
      quoteAmountReceived: execution.quoteReceived,
      insufficientDepth: execution.insufficientDepth,
      quoteAsset: this.quoteAsset,
      tokenSymbol: token?.symbol || this.extractAssetCode(sellAsset),
      orderUsd: this.orderUsd,
      maxSlippage: this.maxSlippage,
    };
  }

  parseAsset(assetDescriptor, fallbackCode = null) {
    if (!assetDescriptor) {
      throw new Error('Missing Stellar asset descriptor');
    }

    if (assetDescriptor === 'native') {
      return { type: 'native' };
    }

    const parts = assetDescriptor.split(':').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 2) {
      return {
        type: parts[0].length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
        code: parts[0],
        issuer: parts[1],
      };
    }

    if (parts.length === 1 && fallbackCode && /^G[A-Z0-9]{55}$/.test(parts[0])) {
      return {
        type: fallbackCode.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
        code: fallbackCode,
        issuer: parts[0],
      };
    }

    throw new Error(
      `Unsupported Stellar asset format "${assetDescriptor}". Use "CODE:ISSUER", "native", or store the issuer with a token symbol.`
    );
  }

  extractAssetCode(asset) {
    return asset.type === 'native' ? 'XLM' : asset.code;
  }

  async fetchOrderBook(sellingAsset, buyingAsset) {
    const params = {
      ...this.toOrderBookParams('base', sellingAsset),
      ...this.toOrderBookParams('counter', buyingAsset),
    };

    const response = await axios.get(`${this.horizonUrl}/order_book`, {
      params,
      timeout: this.orderBookTimeoutMs,
    });

    return response.data;
  }

  toOrderBookParams(prefix, asset) {
    if (asset.type === 'native') {
      return {
        [`${prefix}_asset_type`]: 'native',
      };
    }

    return {
      [`${prefix}_asset_type`]: asset.type,
      [`${prefix}_asset_code`]: asset.code,
      [`${prefix}_asset_issuer`]: asset.issuer,
    };
  }

  getTopBidPrice(bids) {
    if (!Array.isArray(bids) || bids.length === 0) {
      return 0;
    }

    return Number(bids[0].price || 0);
  }

  simulateMarketSell(bids, requestedSellAmount) {
    let remainingSellAmount = requestedSellAmount;
    let quoteReceived = 0;
    let filledAmount = 0;

    for (const bid of bids) {
      if (remainingSellAmount <= 0) {
        break;
      }

      const levelAmount = Number(bid.amount || 0);
      const levelPrice = Number(bid.price || 0);

      if (levelAmount <= 0 || levelPrice <= 0) {
        continue;
      }

      const sellAtLevel = Math.min(levelAmount, remainingSellAmount);
      quoteReceived += sellAtLevel * levelPrice;
      filledAmount += sellAtLevel;
      remainingSellAmount -= sellAtLevel;
    }

    return {
      quoteReceived,
      filledAmount,
      averagePrice: filledAmount > 0 ? quoteReceived / filledAmount : 0,
      insufficientDepth: remainingSellAmount > 1e-9,
    };
  }

  async persistAndNotify(vault, result) {
    const [state] = await VaultLiquidityAlert.findOrCreate({
      where: { vault_id: vault.id },
      defaults: {
        vault_id: vault.id,
        token_address: vault.token_address,
        status: result.status,
        quote_asset: result.quoteAsset,
      },
    });

    const wasAlerting = state.status === 'alerting';
    const shouldAlert = result.status === 'alerting' && !wasAlerting;

    await state.update({
      token_address: vault.token_address,
      status: result.status,
      quote_asset: result.quoteAsset,
      last_checked_at: new Date(),
      last_alerted_at: shouldAlert ? new Date() : state.last_alerted_at,
      last_slippage: result.slippage,
      reference_price: result.referencePrice,
      execution_price: result.executionPrice,
      sell_amount: result.sellAmount,
      quote_amount_received: result.quoteAmountReceived,
      insufficient_depth: result.insufficientDepth,
      error_message: null,
    });

    if (!shouldAlert) {
      return false;
    }

    await this.sendLiquidityAlerts(vault, result);
    return true;
  }

  async markUnavailable(vault, errorMessage) {
    const [state] = await VaultLiquidityAlert.findOrCreate({
      where: { vault_id: vault.id },
      defaults: {
        vault_id: vault.id,
        token_address: vault.token_address,
        quote_asset: this.quoteAsset || 'unconfigured',
      },
    });

    await state.update({
      status: 'unavailable',
      last_checked_at: new Date(),
      error_message: errorMessage,
    });
  }

  async sendLiquidityAlerts(vault, result) {
    const investorEmails = [...new Set(
      (vault.beneficiaries || [])
        .map((beneficiary) => beneficiary.email)
        .filter(Boolean)
    )];

    const founderAddresses = [
      vault.owner_address,
      vault.organization?.admin_address,
    ].filter(Boolean);

    const investorAddresses = (vault.beneficiaries || [])
      .map((beneficiary) => beneficiary.address)
      .filter(Boolean);

    const recipientAddresses = [...new Set([...founderAddresses, ...investorAddresses])];

    const alertPayload = {
      vaultName: vault.name || vault.address,
      vaultAddress: vault.address,
      tokenSymbol: result.tokenSymbol,
      orderUsd: result.orderUsd,
      slippagePercent: result.slippage * 100,
      thresholdPercent: result.maxSlippage * 100,
      insufficientDepth: result.insufficientDepth,
      quoteAsset: result.quoteAsset,
    };

    await Promise.all(
      investorEmails.map((email) => emailService.sendLiquidityRiskAlertEmail(email, alertPayload))
    );

    if (recipientAddresses.length === 0 || !firebaseService.isInitialized()) {
      return;
    }

    const deviceTokens = await DeviceToken.findAll({
      where: {
        user_address: {
          [Op.in]: recipientAddresses,
        },
        is_active: true,
      },
    });

    if (deviceTokens.length === 0) {
      return;
    }

    await firebaseService.sendLiquidityRiskAlertNotification(
      deviceTokens.map((deviceToken) => deviceToken.device_token),
      alertPayload
    );
  }
}

module.exports = new LiquidityMonitorService();
