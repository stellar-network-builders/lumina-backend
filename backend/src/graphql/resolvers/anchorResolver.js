const logger = require('../utils/logger');
const anchorService = require('../../services/anchorService');
const models = require('../../models');
const ClaimCalculator = require('../../services/claimCalculator');

const anchorResolver = {
  Query: {
    /**
     * Get a single off-ramp quote from best available anchor
     */
    offRampQuote: async (_, { tokenSymbol, tokenAmount, fiatCurrency = 'USD', anchorDomain = null }) => {
      try {
        const quote = await anchorService.getOffRampQuote(
          tokenSymbol,
          tokenAmount,
          fiatCurrency,
          anchorDomain
        );
        return quote;
      } catch (error) {
        logger.error('Error fetching off-ramp quote:', error);
        throw new Error(`Failed to fetch off-ramp quote: ${error.message}`);
      }
    },

    /**
     * Get multiple off-ramp quotes for comparison
     */
    offRampQuotes: async (_, { tokenSymbol, tokenAmount, fiatCurrency = 'USD' }) => {
      try {
        const quotes = await anchorService.getMultipleQuotes(
          tokenSymbol,
          tokenAmount,
          fiatCurrency
        );
        return quotes;
      } catch (error) {
        logger.error('Error fetching off-ramp quotes:', error);
        throw new Error(`Failed to fetch off-ramp quotes: ${error.message}`);
      }
    },

    /**
     * Get liquidity estimate for a beneficiary's claimable amount
     * This provides the "Total Cost of Liquidity" for the vesting dashboard
     */
    liquidityEstimate: async (_, { vaultAddress, beneficiaryAddress, fiatCurrency = 'USD' }) => {
      try {
        // Step 1: Find the vault
        const vault = await models.Vault.findOne({
          where: { address: vaultAddress },
          include: [
            {
              model: models.SubSchedule,
              as: 'subSchedules',
              where: { is_active: true },
              required: false
            },
            {
              model: models.Beneficiary,
              as: 'beneficiaries',
              where: { address: beneficiaryAddress },
              required: true
            }
          ]
        });

        if (!vault) {
          throw new Error('Vault not found');
        }

        const beneficiary = vault.beneficiaries[0];
        if (!beneficiary) {
          throw new Error('Beneficiary not found in vault');
        }

        // Step 2: Get token info
        const token = await models.Token.findOne({
          where: { address: vault.token_address }
        });

        if (!token) {
          throw new Error('Token not found');
        }

        // Step 3: Calculate claimable amount
        const claimCalculator = new ClaimCalculator();
        const currentTime = new Date();
        
        // Calculate total claimable across all subschedules for this beneficiary
        let totalClaimable = 0;
        
        for (const subSchedule of vault.subSchedules || []) {
          const claimable = await claimCalculator.calculateClaimable(
            vault,
            subSchedule,
            currentTime,
            vault.subSchedules
          );
          totalClaimable += parseFloat(claimable);
        }

        // Adjust for already withdrawn amount
        const remainingClaimable = Math.max(
          0,
          totalClaimable - parseFloat(beneficiary.total_withdrawn)
        );

        if (remainingClaimable === 0) {
          return {
            tokenSymbol: token.symbol,
            claimableAmount: '0',
            quotes: [],
            bestQuote: null,
            totalCostOfLiquidity: '0'
          };
        }

        // Step 4: Get off-ramp quotes
        const quotes = await anchorService.getMultipleQuotes(
          token.symbol,
          remainingClaimable.toString(),
          fiatCurrency
        );

        if (quotes.length === 0) {
          throw new Error('No quotes available from anchors');
        }

        // Step 5: Select best quote (highest net payout)
        const bestQuote = quotes[0]; // Already sorted by net payout

        // Step 6: Calculate total cost of liquidity
        const grossValue = parseFloat(bestQuote.grossAmount);
        const netPayout = parseFloat(bestQuote.netPayout);
        const totalCost = grossValue - netPayout;

        return {
          tokenSymbol: token.symbol,
          claimableAmount: remainingClaimable.toFixed(token.decimals || 7),
          quotes,
          bestQuote,
          totalCostOfLiquidity: totalCost.toFixed(2)
        };

      } catch (error) {
        logger.error('Error calculating liquidity estimate:', error);
        throw new Error(`Failed to calculate liquidity estimate: ${error.message}`);
      }
    }
  }
};

module.exports = { anchorResolver };
