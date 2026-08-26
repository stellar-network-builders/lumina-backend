// stellar-sdk v11 replaced the old top-level `Server` with `Horizon.Server`.
const logger = require('../utils/logger');
const { Horizon, Networks, TransactionBuilder, Operation } = require('stellar-sdk');
const { sequelize } = require('../database/connection');
const { ConversionEvent, ClaimsHistory } = require('../models');
const { Op } = require('sequelize');
const EventEmitter = require('events');

/**
 * Service for listening to Stellar DEX path payments and tracking conversion events
 * Monitors the Stellar network for path payment operations and records exchange rates
 */
class StellarPathPaymentListener extends EventEmitter {
  constructor() {
    super();
    this.horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon.stellar.org';
    this.network = process.env.STELLAR_NETWORK === 'public' ? Networks.PUBLIC : Networks.TESTNET;
    this.server = new Horizon.Server(this.horizonUrl);
    this.isListening = false;
    this.lastLedger = 0;
    this.cursor = 'now';
    this.retryCount = 0;
    this.maxRetries = 5;
    this.retryDelay = 5000; // 5 seconds
  }

  /**
   * Start listening for path payments
   */
  async start() {
    if (this.isListening) {
      logger.info('Path payment listener is already running');
      return;
    }

    try {
      // Get the last processed ledger from the database
      await this.getLastProcessedLedger();
      
      logger.info(`Starting Stellar path payment listener from ledger ${this.lastLedger}`);
      this.isListening = true;
      
      // Start listening for new transactions
      await this.listenForPayments();
    } catch (error) {
      logger.error('Failed to start path payment listener:', error);
      this.isListening = false;
      throw error;
    }
  }

  /**
   * Stop listening for path payments
   */
  async stop() {
    this.isListening = false;
    logger.info('Stellar path payment listener stopped');
  }

  /**
   * Get the last processed ledger from the database
   */
  async getLastProcessedLedger() {
    try {
      const latestEvent = await ConversionEvent.findOne({
        order: [['block_number', 'DESC']],
        attributes: ['block_number']
      });
      
      if (latestEvent) {
        this.lastLedger = latestEvent.block_number;
        // Set cursor to start after the last processed ledger
        this.cursor = this.lastLedger.toString();
      } else {
        // If no events exist, start from current ledger
        const latestLedger = await this.server.ledgers().order('desc').limit(1).call();
        this.lastLedger = latestLedger.records[0].sequence - 1; // Start from previous ledger
        this.cursor = 'now';
      }
    } catch (error) {
      logger.error('Error getting last processed ledger:', error);
      this.lastLedger = 0;
      this.cursor = 'now';
    }
  }

  /**
   * Listen for Stellar transactions containing path payments
   */
  async listenForPayments() {
    while (this.isListening) {
      try {
        logger.info(`Fetching transactions from cursor: ${this.cursor}`);
        
        const txStream = this.server.transactions()
          .cursor(this.cursor)
          .order('asc')
          .limit(200)
          .stream();

        for await (const tx of txStream) {
          if (!this.isListening) break;
          
          await this.processTransaction(tx);
          this.cursor = tx.paging_token;
          this.lastLedger = tx.ledger;
        }

        // Reset retry count on successful processing
        this.retryCount = 0;
        
        // Small delay to avoid overwhelming the API
        await this.sleep(1000);
        
      } catch (error) {
        logger.error('Error in payment listener:', error);
        await this.handleError(error);
      }
    }
  }

  /**
   * Process a single Stellar transaction for path payments
   */
  async processTransaction(tx) {
    try {
      // Skip unsuccessful transactions
      if (!tx.successful) {
        return;
      }

      // Get transaction details including operations
      const txDetails = await this.server.transactions()
        .transaction(tx.hash)
        .call();

      // Process each operation in the transaction
      for (const operation of txDetails.operations) {
        if (operation.type === 'path_payment_strict_send' || operation.type === 'path_payment_strict_receive') {
          await this.processPathPayment(operation, txDetails);
        }
      }
    } catch (error) {
      logger.error(`Error processing transaction ${tx.hash}:`, error);
    }
  }

  /**
   * Process a path payment operation
   */
  async processPathPayment(operation, transaction) {
    const t = await sequelize.transaction();
    
    try {
      // Check if this conversion event already exists
      const existingEvent = await ConversionEvent.findOne({
        where: { transaction_hash: transaction.hash },
        transaction: t
      });

      if (existingEvent) {
        await t.rollback();
        return; // Already processed
      }

      // Determine if this is a claim-and-swap by checking for recent claims
      const claimEvent = await this.findAssociatedClaim(
        operation.source_account,
        transaction.created_at,
        t
      );

      // Extract path payment details
      const sourceAsset = this.parseAsset(operation.source_asset);
      const destinationAsset = this.parseAsset(operation.destination_asset);
      
      // Calculate exchange rate
      const exchangeRate = operation.type === 'path_payment_strict_send'
        ? parseFloat(operation.destination_amount) / parseFloat(operation.source_amount)
        : parseFloat(operation.destination_amount) / parseFloat(operation.source_amount);

      // Calculate slippage if path information is available
      const slippage = this.calculateSlippage(operation, exchangeRate);

      // Get gas fee
      const gasFee = this.calculateGasFee(transaction);

      // Assess data quality based on liquidity
      const dataQuality = await this.assessDataQuality(sourceAsset, destinationAsset, operation.destination_amount);

      // Create conversion event record
      const conversionEvent = await ConversionEvent.create({
        transaction_hash: transaction.hash,
        user_address: operation.source_account,
        claim_id: claimEvent?.id || null,
        source_asset_code: sourceAsset.code,
        source_asset_issuer: sourceAsset.issuer,
        source_amount: operation.source_amount,
        destination_asset_code: destinationAsset.code,
        destination_asset_issuer: destinationAsset.issuer,
        destination_amount: operation.destination_amount,
        exchange_rate: exchangeRate,
        exchange_rate_usd: await this.getUSDExchangeRate(sourceAsset, destinationAsset, exchangeRate),
        path_assets: operation.path ? operation.path.map(asset => this.parseAsset(asset)) : null,
        slippage_percentage: slippage,
        gas_fee_xlm: gasFee,
        block_number: transaction.ledger,
        transaction_timestamp: transaction.created_at,
        conversion_type: claimEvent ? 'claim_and_swap' : 'direct_swap',
        price_source: 'stellar_dex',
        data_quality: dataQuality
      }, { transaction: t });

      // Update claim history if this is a claim-and-swap
      if (claimEvent) {
        await claimEvent.update({
          conversion_event_id: conversionEvent.id
        }, { transaction: t });
      }

      await t.commit();

      // Emit event for real-time notifications
      this.emit('conversionEvent', {
        type: claimEvent ? 'claim_and_swap' : 'direct_swap',
        userAddress: operation.source_account,
        sourceAsset: sourceAsset,
        destinationAsset: destinationAsset,
        amount: operation.destination_amount,
        exchangeRate: exchangeRate,
        timestamp: transaction.created_at
      });

      logger.info(`Processed path payment: ${operation.source_account} swapped ${operation.source_amount} ${sourceAsset.code} for ${operation.destination_amount} ${destinationAsset.code}`);

    } catch (error) {
      await t.rollback();
      logger.error('Error processing path payment:', error);
      throw error;
    }
  }

  /**
   * Find a claim associated with this path payment
   */
  async findAssociatedClaim(userAddress, timestamp, transaction) {
    try {
      // Look for claims within the last 10 minutes from the same user
      const tenMinutesAgo = new Date(timestamp.getTime() - 10 * 60 * 1000);
      
      const claim = await ClaimsHistory.findOne({
        where: {
          user_address: userAddress,
          claim_timestamp: {
            [Op.gte]: tenMinutesAgo,
            [Op.lte]: timestamp
          },
          conversion_event_id: null // Not already associated with a conversion
        },
        order: [['claim_timestamp', 'DESC']],
        transaction
      });

      return claim;
    } catch (error) {
      logger.error('Error finding associated claim:', error);
      return null;
    }
  }

  /**
   * Parse Stellar asset object
   */
  parseAsset(asset) {
    if (asset.asset_type === 'native') {
      return { code: 'XLM', issuer: null };
    } else {
      return {
        code: asset.asset_code,
        issuer: asset.asset_issuer
      };
    }
  }

  /**
   * Calculate slippage percentage
   */
  calculateSlippage(operation, actualRate) {
    // This is a simplified calculation - in practice you'd need to compare
    // with the quoted rate at the time of transaction submission
    if (!operation.path || operation.path.length === 0) {
      return 0; // Direct trade, no slippage
    }

    // For path payments, we could calculate expected rate vs actual rate
    // This would require more complex logic with DEX order book analysis
    return 0; // Placeholder
  }

  /**
   * Calculate gas fee in XLM
   */
  calculateGasFee(transaction) {
    // Stellar fees are paid in XLM
    const feeInStroops = parseInt(transaction.fee_charged || 0);
    return feeInStroops / 10000000; // Convert stroops to XLM
  }

  /**
   * Get USD exchange rate for the asset pair
   */
  async getUSDExchangeRate(sourceAsset, destinationAsset, exchangeRate) {
    try {
      // If destination is USDC, return the exchange rate directly
      if (destinationAsset.code === 'USDC' && destinationAsset.issuer === 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN') {
        return exchangeRate;
      }

      // If source is USDC, return the inverse
      if (sourceAsset.code === 'USDC' && sourceAsset.issuer === 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN') {
        return 1 / exchangeRate;
      }

      // For other pairs, we'd need to fetch external price data
      // This is a placeholder - implement based on your price oracle
      return null;
    } catch (error) {
      logger.error('Error getting USD exchange rate:', error);
      return null;
    }
  }

  /**
   * Assess data quality based on liquidity and depth
   */
  async assessDataQuality(sourceAsset, destinationAsset, amount) {
    try {
      // This is a simplified assessment
      // In practice, you'd analyze order book depth, recent volume, etc.
      const amountFloat = parseFloat(amount);
      
      if (amountFloat >= 100000) return 'excellent';
      if (amountFloat >= 10000) return 'good';
      if (amountFloat >= 1000) return 'fair';
      return 'poor';
    } catch (error) {
      logger.error('Error assessing data quality:', error);
      return 'fair';
    }
  }

  /**
   * Handle errors in the listener
   */
  async handleError(error) {
    this.retryCount++;
    
    if (this.retryCount >= this.maxRetries) {
      logger.error('Max retries reached, stopping listener');
      await this.stop();
      this.emit('error', error);
      return;
    }

    logger.info(`Retrying in ${this.retryDelay / 1000} seconds... (attempt ${this.retryCount}/${this.maxRetries})`);
    await this.sleep(this.retryDelay);
    
    // Exponential backoff
    this.retryDelay = Math.min(this.retryDelay * 2, 60000); // Max 1 minute
  }

  /**
   * Sleep helper function
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get listener status
   */
  getStatus() {
    return {
      isListening: this.isListening,
      lastLedger: this.lastLedger,
      cursor: this.cursor,
      retryCount: this.retryCount
    };
  }
}

module.exports = new StellarPathPaymentListener();
