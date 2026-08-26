'use strict';

const logger = require('../utils/logger');
const { ConversionEvent, ClaimsHistory, Beneficiary, Vault } = require('../models');
const { sequelize } = require('../database/connection');
const { Op } = require('sequelize');

class CostBasisCalculationService {
  constructor() {
    this.fifoMethod = 'FIFO'; // First-In, First-Out
    this.lifoMethod = 'LIFO'; // Last-In, First-Out
    this.averageMethod = 'AVERAGE'; // Average cost basis
  }

  /**
   * Calculate cost basis for a beneficiary's token holdings
   * @param {string} userAddress - Beneficiary wallet address
   * @param {string} assetCode - Asset code to calculate basis for
   * @param {string} method - Cost basis method (FIFO, LIFO, AVERAGE)
   * @returns {Promise<Object>} Cost basis calculation results
   */
  async calculateCostBasis(userAddress, assetCode, method = this.fifoMethod) {
    try {
      const whereClause = { user_address: userAddress };
      if (assetCode) {
        whereClause[Op.or] = [
          { source_asset_code: assetCode },
          { destination_asset_code: assetCode }
        ];
      }

      // Get all conversion events for this user and asset
      const conversionEvents = await ConversionEvent.findAll({
        where: whereClause,
        order: [['transaction_timestamp', 'ASC']],
        include: [
          {
            model: ClaimsHistory,
            as: 'claim',
            required: false
          }
        ]
      });

      // Get all claims for this user and asset
      const claims = await ClaimsHistory.findAll({
        where: {
          user_address: userAddress,
          token_address: { [Op.ne]: null } // Has token address
        },
        order: [['claim_timestamp', 'ASC']]
      });

      // Calculate holdings and cost basis
      const holdings = this.calculateHoldings(conversionEvents, claims, assetCode, method);

      // Calculate current position
      const currentPosition = await this.calculateCurrentPosition(userAddress, assetCode, holdings);

      // Calculate unrealized gains/losses
      const unrealized = await this.calculateUnrealizedGains(holdings, currentPosition);

      // Calculate realized gains/losses
      const realized = this.calculateRealizedGains(holdings, conversionEvents);

      return {
        success: true,
        data: {
          userAddress,
          assetCode,
          method,
          holdings,
          currentPosition,
          unrealized,
          realized,
          summary: {
            totalAcquired: holdings.reduce((sum, h) => sum + parseFloat(h.totalAcquired), 0),
            totalCostBasis: holdings.reduce((sum, h) => sum + parseFloat(h.totalCostBasis), 0),
            currentHolding: currentPosition.amount,
            averageCostBasis: holdings.length > 0 ?
              holdings.reduce((sum, h) => sum + parseFloat(h.totalCostBasis), 0) / holdings.length : 0,
            unrealizedGain: unrealized.totalGain,
            realizedGain: realized.totalGain,
            totalGain: parseFloat(unrealized.totalGain) + parseFloat(realized.totalGain)
          }
        }
      };

    } catch (error) {
      logger.error('Error calculating cost basis:', error);
      throw error;
    }
  }

  /**
   * Calculate holdings using specified cost basis method
   * @param {Array} conversionEvents - Conversion events
   * @param {Array} claims - Claim events
   * @param {string} assetCode - Asset code
   * @param {string} method - Cost basis method
   * @returns {Array} Holdings array
   */
  calculateHoldings(conversionEvents, claims, assetCode, method) {
    const holdings = [];
    const assetHoldings = {}; // Track holdings by asset

    // Process claims (acquisitions)
    for (const claim of claims) {
      if (!claim.token_address || !claim.amount_claimed) continue;

      const tokenCode = this.extractAssetCode(claim.token_address);
      if (assetCode && tokenCode !== assetCode) continue;

      if (!assetHoldings[tokenCode]) {
        assetHoldings[tokenCode] = [];
      }

      assetHoldings[tokenCode].push({
        type: 'acquisition',
        timestamp: claim.claim_timestamp,
        amount: parseFloat(claim.amount_claimed),
        price: 0, // Claims have no cost basis (vested tokens)
        costBasis: 0,
        transactionId: claim.id,
        transactionType: 'claim'
      });
    }

    // Process conversion events (acquisitions and disposals)
    for (const conversion of conversionEvents) {
      const destCode = conversion.destination_asset_code;
      const sourceCode = conversion.source_asset_code;

      if (destCode && (!assetCode || destCode === assetCode)) {
        // User acquired this asset
        if (!assetHoldings[destCode]) {
          assetHoldings[destCode] = [];
        }

        assetHoldings[destCode].push({
          type: 'acquisition',
          timestamp: conversion.transaction_timestamp,
          amount: parseFloat(conversion.destination_amount),
          price: parseFloat(conversion.exchange_rate_usd || 0),
          costBasis: parseFloat(conversion.destination_amount) * parseFloat(conversion.exchange_rate_usd || 0),
          exchangeRate: parseFloat(conversion.exchange_rate),
          transactionId: conversion.id,
          transactionType: conversion.conversion_type,
          sourceAsset: conversion.source_asset_code,
          gasFee: parseFloat(conversion.gas_fee_xlm || 0)
        });
      }

      if (sourceCode && (!assetCode || sourceCode === assetCode)) {
        // User disposed of this asset
        if (!assetHoldings[sourceCode]) {
          assetHoldings[sourceCode] = [];
        }

        assetHoldings[sourceCode].push({
          type: 'disposal',
          timestamp: conversion.transaction_timestamp,
          amount: parseFloat(conversion.source_amount),
          price: parseFloat(conversion.exchange_rate_usd || 0),
          exchangeRate: parseFloat(conversion.exchange_rate),
          transactionId: conversion.id,
          transactionType: conversion.conversion_type,
          destinationAsset: conversion.destination_asset_code,
          gasFee: parseFloat(conversion.gas_fee_xlm || 0)
        });
      }
    }

    // Calculate holdings based on method
    for (const [code, events] of Object.entries(assetHoldings)) {
      events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      let calculatedHoldings;
      switch (method) {
        case this.fifoMethod:
          calculatedHoldings = this.calculateFIFOHoldings(events);
          break;
        case this.lifoMethod:
          calculatedHoldings = this.calculateLIFOHoldings(events);
          break;
        case this.averageMethod:
          calculatedHoldings = this.calculateAverageHoldings(events);
          break;
        default:
          calculatedHoldings = this.calculateFIFOHoldings(events);
      }

      holdings.push(...calculatedHoldings);
    }

    return holdings;
  }

  /**
   * Calculate holdings using FIFO method
   * @param {Array} events - Sorted events
   * @returns {Array} FIFO holdings
   */
  calculateFIFOHoldings(events) {
    const holdings = [];
    const acquisitionQueue = [];
    let totalAcquired = 0;
    let totalCostBasis = 0;

    for (const event of events) {
      if (event.type === 'acquisition') {
        acquisitionQueue.push({
          amount: event.amount,
          costBasis: event.costBasis,
          price: event.price,
          timestamp: event.timestamp,
          transactionId: event.transactionId
        });

        totalAcquired += event.amount;
        totalCostBasis += event.costBasis;

      } else if (event.type === 'disposal') {
        let remainingAmount = event.amount;
        let disposalCostBasis = 0;
        let disposalAmount = 0;

        // Dispose of earliest acquisitions first (FIFO)
        while (remainingAmount > 0 && acquisitionQueue.length > 0) {
          const nextAcquisition = acquisitionQueue[0];
          const disposeAmount = Math.min(remainingAmount, nextAcquisition.amount);

          const proportion = disposeAmount / nextAcquisition.amount;
          const costBasisForDisposal = nextAcquisition.costBasis * proportion;

          disposalCostBasis += costBasisForDisposal;
          disposalAmount += disposeAmount;
          remainingAmount -= disposeAmount;

          nextAcquisition.amount -= disposeAmount;
          if (nextAcquisition.amount <= 0) {
            acquisitionQueue.shift(); // Remove fully disposed acquisition
          }

          holdings.push({
            type: 'disposal',
            acquisitionTransactionId: nextAcquisition.transactionId,
            disposalTransactionId: event.transactionId,
            amountDisposed: disposeAmount,
            costBasis: costBasisForDisposal,
            proceeds: disposeAmount * event.price,
            gain: (disposeAmount * event.price) - costBasisForDisposal,
            acquisitionDate: nextAcquisition.timestamp,
            disposalDate: event.timestamp,
            holdingPeriod: this.calculateHoldingPeriod(nextAcquisition.timestamp, event.timestamp)
          });
        }

        // Add remaining disposal if couldn't match with acquisitions
        if (remainingAmount > 0) {
          holdings.push({
            type: 'disposal',
            disposalTransactionId: event.transactionId,
            amountDisposed: remainingAmount,
            costBasis: 0,
            proceeds: remainingAmount * event.price,
            gain: remainingAmount * event.price,
            disposalDate: event.timestamp,
            note: 'Unmatched disposal - may indicate missing acquisition data'
          });
        }
      }
    }

    // Add remaining acquisitions to holdings
    for (const acquisition of acquisitionQueue) {
      if (acquisition.amount > 0) {
        holdings.push({
          type: 'holding',
          transactionId: acquisition.transactionId,
          amount: acquisition.amount,
          costBasis: acquisition.costBasis,
          price: acquisition.price,
          acquisitionDate: acquisition.timestamp
        });
      }
    }

    return holdings.map(h => ({
      ...h,
      totalAcquired,
      totalCostBasis: totalAcquired > 0 ? totalCostBasis / totalAcquired : 0
    }));
  }

  /**
   * Calculate holdings using LIFO method
   * @param {Array} events - Sorted events
   * @returns {Array} LIFO holdings
   */
  calculateLIFOHoldings(events) {
    // Similar to FIFO but dispose of most recent acquisitions first
    const holdings = [];
    const acquisitionStack = [];
    let totalAcquired = 0;
    let totalCostBasis = 0;

    for (const event of events) {
      if (event.type === 'acquisition') {
        acquisitionStack.push({
          amount: event.amount,
          costBasis: event.costBasis,
          price: event.price,
          timestamp: event.timestamp,
          transactionId: event.transactionId
        });

        totalAcquired += event.amount;
        totalCostBasis += event.costBasis;

      } else if (event.type === 'disposal') {
        let remainingAmount = event.amount;
        let disposalCostBasis = 0;
        let disposalAmount = 0;

        // Dispose of most recent acquisitions first (LIFO)
        while (remainingAmount > 0 && acquisitionStack.length > 0) {
          const nextAcquisition = acquisitionStack[acquisitionStack.length - 1];
          const disposeAmount = Math.min(remainingAmount, nextAcquisition.amount);

          const proportion = disposeAmount / nextAcquisition.amount;
          const costBasisForDisposal = nextAcquisition.costBasis * proportion;

          disposalCostBasis += costBasisForDisposal;
          disposalAmount += disposeAmount;
          remainingAmount -= disposeAmount;

          nextAcquisition.amount -= disposeAmount;
          if (nextAcquisition.amount <= 0) {
            acquisitionStack.pop(); // Remove fully disposed acquisition
          }

          holdings.push({
            type: 'disposal',
            acquisitionTransactionId: nextAcquisition.transactionId,
            disposalTransactionId: event.transactionId,
            amountDisposed: disposeAmount,
            costBasis: costBasisForDisposal,
            proceeds: disposeAmount * event.price,
            gain: (disposeAmount * event.price) - costBasisForDisposal,
            acquisitionDate: nextAcquisition.timestamp,
            disposalDate: event.timestamp,
            holdingPeriod: this.calculateHoldingPeriod(nextAcquisition.timestamp, event.timestamp)
          });
        }

        if (remainingAmount > 0) {
          holdings.push({
            type: 'disposal',
            disposalTransactionId: event.transactionId,
            amountDisposed: remainingAmount,
            costBasis: 0,
            proceeds: remainingAmount * event.price,
            gain: remainingAmount * event.price,
            disposalDate: event.timestamp,
            note: 'Unmatched disposal - may indicate missing acquisition data'
          });
        }
      }
    }

    // Add remaining acquisitions to holdings
    for (const acquisition of acquisitionStack) {
      if (acquisition.amount > 0) {
        holdings.push({
          type: 'holding',
          transactionId: acquisition.transactionId,
          amount: acquisition.amount,
          costBasis: acquisition.costBasis,
          price: acquisition.price,
          acquisitionDate: acquisition.timestamp
        });
      }
    }

    return holdings.map(h => ({
      ...h,
      totalAcquired,
      totalCostBasis: totalAcquired > 0 ? totalCostBasis / totalAcquired : 0
    }));
  }

  /**
   * Calculate holdings using Average method
   * @param {Array} events - Sorted events
   * @returns {Array} Average holdings
   */
  calculateAverageHoldings(events) {
    const holdings = [];
    let totalAcquired = 0;
    let totalCostBasis = 0;
    let totalDisposed = 0;

    let currentAmount = 0;
    let currentTotalCost = 0;

    for (const event of events) {
      if (event.type === 'acquisition') {
        currentAmount += event.amount;
        currentTotalCost += event.costBasis;
        totalAcquired += event.amount;
        totalCostBasis += event.costBasis;
      } else if (event.type === 'disposal') {
        const averageCost = currentAmount > 0 ? currentTotalCost / currentAmount : 0;
        const costBasisForDisposal = event.amount * averageCost;

        currentAmount -= event.amount;
        currentTotalCost -= costBasisForDisposal;
        totalDisposed += event.amount;

        holdings.push({
          type: 'disposal',
          disposalTransactionId: event.transactionId,
          amountDisposed: event.amount,
          costBasis: costBasisForDisposal,
          proceeds: event.amount * event.price,
          gain: (event.amount * event.price) - costBasisForDisposal,
          disposalDate: event.timestamp
        });
      }
    }

    if (currentAmount > 0) {
      const averageCostBasis = currentAmount > 0 ? currentTotalCost / currentAmount : 0;
      holdings.push({
        type: 'holding',
        amount: currentAmount,
        costBasis: currentTotalCost,
        averageCostBasis: averageCostBasis,
        totalAcquired,
        totalCostBasis
      });
    }

    return holdings.map(h => ({
      ...h,
      totalAcquired,
      totalCostBasis: totalAcquired > 0 ? totalCostBasis / totalAcquired : 0
    }));
  }

  /**
   * Calculate current position for an asset
   * @param {string} userAddress - User wallet address
   * @param {string} assetCode - Asset code
   * @param {Array} holdings - Holdings array
   * @returns {Promise<Object>} Current position
   */
  async calculateCurrentPosition(userAddress, assetCode, holdings) {
    try {
      // Get current balance from Stellar (or cache)
      // This would integrate with a balance service
      const currentBalance = await this.getCurrentBalance(userAddress, assetCode);

      const totalHeld = holdings
        .filter(h => h.type === 'holding')
        .reduce((sum, h) => sum + parseFloat(h.amount || 0), 0);

      return {
        assetCode,
        currentBalance,
        trackedBalance: totalHeld,
        difference: parseFloat(currentBalance) - totalHeld,
        lastUpdated: new Date()
      };
    } catch (error) {
      logger.error('Error calculating current position:', error);
      return {
        assetCode,
        currentBalance: 0,
        trackedBalance: 0,
        difference: 0,
        lastUpdated: new Date(),
        error: error.message
      };
    }
  }

  /**
   * Calculate unrealized gains/losses
   * @param {Array} holdings - Holdings array
   * @param {Object} currentPosition - Current position
   * @returns {Object} Unrealized gains/losses
   */
  async calculateUnrealizedGains(holdings, currentPosition) {
    try {
      const currentPrice = await this.getCurrentPrice(currentPosition.assetCode);
      const holdingRecords = holdings.filter(h => h.type === 'holding');

      let totalCostBasis = 0;
      let totalAmount = 0;

      for (const holding of holdingRecords) {
        totalCostBasis += parseFloat(holding.costBasis || 0);
        totalAmount += parseFloat(holding.amount || 0);
      }

      const currentValue = totalAmount * currentPrice;
      const totalGain = currentValue - totalCostBasis;
      const gainPercentage = totalCostBasis > 0 ? (totalGain / totalCostBasis) * 100 : 0;

      return {
        totalCostBasis,
        totalAmount,
        currentPrice,
        currentValue,
        totalGain,
        gainPercentage,
        unrealizedGain: totalGain > 0 ? totalGain : 0,
        unrealizedLoss: totalGain < 0 ? Math.abs(totalGain) : 0
      };
    } catch (error) {
      logger.error('Error calculating unrealized gains:', error);
      return {
        totalCostBasis: 0,
        totalAmount: 0,
        currentPrice: 0,
        currentValue: 0,
        totalGain: 0,
        gainPercentage: 0,
        error: error.message
      };
    }
  }

  /**
   * Calculate realized gains/losses
   * @param {Array} holdings - Holdings array
   * @param {Array} conversionEvents - Conversion events
   * @returns {Object} Realized gains/losses
   */
  calculateRealizedGains(holdings, conversionEvents) {
    const disposals = holdings.filter(h => h.type === 'disposal');

    let totalRealizedGain = 0;
    let totalRealizedLoss = 0;
    let shortTermGains = 0;
    let longTermGains = 0;

    for (const disposal of disposals) {
      const gain = parseFloat(disposal.gain || 0);

      if (gain > 0) {
        totalRealizedGain += gain;

        // Classify as short-term or long-term (less than 1 year = short-term)
        const holdingDays = disposal.acquisitionDate ? this.calculateHoldingPeriod(disposal.acquisitionDate, disposal.disposalDate) : 0;
        if (holdingDays < 365) {
          shortTermGains += gain;
        } else {
          longTermGains += gain;
        }
      } else {
        totalRealizedLoss += Math.abs(gain);
      }
    }

    return {
      totalRealizedGain,
      totalRealizedLoss,
      netGain: totalRealizedGain - totalRealizedLoss,
      shortTermGains,
      longTermGains,
      totalDisposals: disposals.length
    };
  }

  /**
   * Get current balance for user and asset
   * @param {string} userAddress - User wallet address
   * @param {string} assetCode - Asset code
   * @returns {Promise<number>} Current balance
   */
  async getCurrentBalance(userAddress, assetCode) {
    try {
      // This would integrate with Stellar balance service
      // For now, return a placeholder
      const StellarSdk = require('stellar-sdk');
      const server = new StellarSdk.Server(process.env.STELLAR_HORIZON_URL || 'https://horizon.stellar.org');

      const account = await server.loadAccount(userAddress);
      const balance = account.balances.find(b =>
        b.asset_code === assetCode &&
        (b.asset_issuer === null || b.asset_issuer === undefined)
      );

      return balance ? parseFloat(balance.balance) : 0;
    } catch (error) {
      logger.error('Error getting current balance:', error);
      return 0;
    }
  }

  /**
   * Get current price for asset
   * @param {string} assetCode - Asset code
   * @returns {Promise<number>} Current price
   */
  async getCurrentPrice(assetCode) {
    try {
      // This would integrate with price service
      // For now, return a placeholder
      if (assetCode === 'USDC') return 1.0; // USDC pegged to USD
      if (assetCode === 'XLM') return 0.1; // Example price

      // For other assets, fetch from price oracle
      return 1.0; // Placeholder
    } catch (error) {
      logger.error('Error getting current price:', error);
      return 1.0;
    }
  }

  /**
   * Calculate holding period in days
   * @param {Date} acquisitionDate - Acquisition date
   * @param {Date} disposalDate - Disposal date
   * @returns {number} Days held
   */
  calculateHoldingPeriod(acquisitionDate, disposalDate) {
    const diffTime = new Date(disposalDate) - new Date(acquisitionDate);
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
  }

  /**
   * Extract asset code from token address
   * @param {string} tokenAddress - Token address
   * @returns {string} Asset code
   */
  extractAssetCode(tokenAddress) {
    // This would integrate with token registry
    // For now, return a placeholder
    if (tokenAddress.includes('USDC')) return 'USDC';
    if (tokenAddress.includes('XLM')) return 'XLM';
    return 'TOKEN'; // Default
  }

  /**
   * Generate tax report for user
   * @param {string} userAddress - User wallet address
   * @param {number} taxYear - Tax year
   * @returns {Promise<Object>} Tax report
   */
  async generateTaxReport(userAddress, taxYear) {
    try {
      const startDate = new Date(taxYear, 0, 1);
      const endDate = new Date(taxYear + 1, 0, 1);

      // Get all conversion events in tax year
      const conversionEvents = await ConversionEvent.findAll({
        where: {
          user_address: userAddress,
          transaction_timestamp: {
            [Op.gte]: startDate,
            [Op.lt]: endDate
          }
        },
        order: [['transaction_timestamp', 'ASC']]
      });

      // Calculate cost basis for the year
      const costBasisResult = await this.calculateCostBasis(userAddress, null, this.fifoMethod);

      // Filter events for tax year
      const yearEvents = costBasisResult.data.holdings.filter(h => {
        const eventDate = new Date(h.acquisitionDate || h.disposalDate);
        return eventDate >= startDate && eventDate < endDate;
      });

      // Calculate tax totals
      const disposals = yearEvents.filter(h => h.type === 'disposal');
      const shortTermGains = disposals
        .filter(d => this.calculateHoldingPeriod(d.acquisitionDate, d.disposalDate) < 365)
        .reduce((sum, d) => sum + parseFloat(d.gain || 0), 0);

      const longTermGains = disposals
        .filter(d => this.calculateHoldingPeriod(d.acquisitionDate, d.disposalDate) >= 365)
        .reduce((sum, d) => sum + parseFloat(d.gain || 0), 0);

      return {
        success: true,
        data: {
          userAddress,
          taxYear,
          taxPeriod: {
            startDate,
            endDate
          },
          summary: {
            shortTermGains,
            longTermGains,
            totalGains: shortTermGains + longTermGains,
            totalLosses: disposals.reduce((sum, d) => sum + (parseFloat(d.gain || 0) < 0 ? Math.abs(d.gain) : 0), 0),
            netGains: (shortTermGains + longTermGains) - disposals.reduce((sum, d) => sum + (parseFloat(d.gain || 0) < 0 ? Math.abs(d.gain) : 0), 0)
          },
          events: yearEvents,
          recommendations: this.generateTaxRecommendations(shortTermGains, longTermGains)
        }
      };

    } catch (error) {
      logger.error('Error generating tax report:', error);
      throw error;
    }
  }

  /**
   * Generate tax recommendations
   * @param {number} shortTermGains - Short-term gains amount
   * @param {number} longTermGains - Long-term gains amount
   * @returns {Array} Tax recommendations
   */
  generateTaxRecommendations(shortTermGains, longTermGains) {
    const recommendations = [];

    if (shortTermGains > 0) {
      recommendations.push({
        type: 'tax_optimization',
        priority: 'high',
        title: 'Consider Holding for Long-Term Gains',
        description: `You have $${shortTermGains.toFixed(2)} in short-term gains taxed at ordinary income rates.`,
        actionItems: [
          'Consider holding assets for more than 1 year',
          'Review tax loss harvesting opportunities',
          'Consult with tax advisor for optimization strategies'
        ]
      });
    }

    if (longTermGains > 0) {
      recommendations.push({
        type: 'tax_planning',
        priority: 'medium',
        title: 'Long-Term Gains Tax Planning',
        description: `You have $${longTermGains.toFixed(2)} in long-term gains eligible for reduced rates.`,
        actionItems: [
          'Document holding periods accurately',
          'Consider tax-loss harvesting',
          'Review quarterly tax payment requirements'
        ]
      });
    }

    return recommendations;
  }
}

module.exports = CostBasisCalculationService;
