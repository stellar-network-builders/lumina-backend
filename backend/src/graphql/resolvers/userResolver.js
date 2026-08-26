const logger = require('../utils/logger');
const models = require('../../models');

const calculateWithdrawableAmount = async (vault, beneficiary, timestamp = new Date()) => {
  const subSchedules = await models.SubSchedule.findAll({
    where: { vault_id: vault.id },
    order: [['created_at', 'ASC']]
  }) || [];

  let totalVested = 0;
  let totalAllocated = parseFloat(beneficiary.total_allocated);
  let nextVestTime = null;
  let isFullyVested = true;

  for (const schedule of subSchedules) {
    const topUpTime = new Date(schedule.top_up_timestamp).getTime();
    const start = new Date(schedule.start_timestamp).getTime();
    const end = new Date(schedule.end_timestamp).getTime();
    const now = timestamp.getTime();
    
    if (now < start) {
      isFullyVested = false;
      if (!nextVestTime || start < nextVestTime.getTime()) {
        nextVestTime = new Date(start);
      }
    } else if (now >= end) {
      totalVested += parseFloat(schedule.top_up_amount);
    } else {
      isFullyVested = false;
      const elapsed = now - topUpTime;
      const duration = end - topUpTime;
      const vestedRatio = elapsed / duration;
      totalVested += parseFloat(schedule.top_up_amount) * vestedRatio;
      
      if (!nextVestTime || end < nextVestTime.getTime()) {
        nextVestTime = new Date(end);
      }
    }
  }

  const totalWithdrawn = parseFloat(beneficiary.total_withdrawn);
  const totalWithdrawable = Math.min(totalVested, totalAllocated) - totalWithdrawn;
  const remainingAmount = totalAllocated - totalWithdrawn;

  return {
    totalWithdrawable: Math.max(0, totalWithdrawable).toString(),
    vestedAmount: totalVested.toString(),
    remainingAmount: Math.max(0, remainingAmount).toString(),
    isFullyVested,
    nextVestTime
  };
};

const userResolver = {
  Query: {
    beneficiary: async (_, { vaultAddress, beneficiaryAddress }) => {
      try {
        const vault = await models.Vault.findOne({
          where: { address: vaultAddress }
        });

        if (!vault) {
          throw new Error('Vault not found');
        }

        const beneficiary = await models.Beneficiary.findOne({
          where: { 
            vault_id: vault.id,
            address: beneficiaryAddress
          },
          include: [
            {
              model: models.Vault,
              as: 'vault'
            }
          ]
        });

        return beneficiary;
      } catch (error) {
        logger.error('Error fetching beneficiary:', error);
        throw new Error(`Failed to fetch beneficiary: ${error.message}`);
      }
    },

    beneficiaries: async (_, { vaultAddress, first = 50, after }) => {
      try {
        const vault = await models.Vault.findOne({
          where: { address: vaultAddress }
        });

        if (!vault) {
          throw new Error('Vault not found');
        }

        const offset = after ? parseInt(after) : 0;

        const beneficiaries = await models.Beneficiary.findAll({
          where: { vault_id: vault.id },
          include: [
            {
              model: models.Vault,
              as: 'vault'
            }
          ],
          limit: first,
          offset,
          order: [['created_at', 'DESC']]
        });

        return beneficiaries;
      } catch (error) {
        logger.error('Error fetching beneficiaries:', error);
        throw new Error(`Failed to fetch beneficiaries: ${error.message}`);
      }
    },

    claims: async (_, { userAddress, tokenAddress, first = 50, after }) => {
      try {
        const whereClause = {};
        if (userAddress) whereClause.user_address = userAddress;
        if (tokenAddress) whereClause.token_address = tokenAddress;

        const offset = after ? parseInt(after) : 0;

        const claims = await models.ClaimsHistory.findAll({
          where: whereClause,
          limit: first,
          offset,
          order: [['claim_timestamp', 'DESC']]
        });

        return claims;
      } catch (error) {
        logger.error('Error fetching claims:', error);
        throw new Error(`Failed to fetch claims: ${error.message}`);
      }
    },

    claim: async (_, { transactionHash }) => {
      try {
        const claim = await models.ClaimsHistory.findOne({
          where: { transaction_hash: transactionHash }
        });
        return claim;
      } catch (error) {
        logger.error('Error fetching claim:', error);
        throw new Error(`Failed to fetch claim: ${error.message}`);
      }
    },

    realizedGains: async (_, { userAddress, startDate, endDate }) => {
      try {
        const whereClause = { user_address: userAddress };
        
        if (startDate || endDate) {
          whereClause.claim_timestamp = {};
          if (startDate) whereClause.claim_timestamp[models.Sequelize.Op.gte] = startDate;
          if (endDate) whereClause.claim_timestamp[models.Sequelize.Op.lte] = endDate;
        }

        const claims = await models.ClaimsHistory.findAll({
          where: whereClause,
          order: [['claim_timestamp', 'DESC']]
        });

        const totalGains = claims.reduce((sum, claim) => {
          const price = parseFloat(claim.price_at_claim_usd || '0');
          const amount = parseFloat(claim.amount_claimed);
          return sum + (price * amount);
        }, 0);

        return {
          totalGains: totalGains.toString(),
          claims,
          periodStart: startDate,
          periodEnd: endDate
        };
      } catch (error) {
        logger.error('Error calculating realized gains:', error);
        throw new Error(`Failed to calculate realized gains: ${error.message}`);
      }
    }
  },

  Mutation: {
    withdraw: async (_, { input }) => {
      try {
        const vault = await models.Vault.findOne({
          where: { address: input.vaultAddress }
        });

        if (!vault) {
          throw new Error('Vault not found');
        }

        const beneficiary = await models.Beneficiary.findOne({
          where: { 
            vault_id: vault.id,
            address: input.beneficiaryAddress
          }
        });

        if (!beneficiary) {
          throw new Error('Beneficiary not found');
        }

        // Calculate withdrawable amount
        const withdrawableInfo = await calculateWithdrawableAmount(vault, beneficiary);

        if (parseFloat(input.amount) > parseFloat(withdrawableInfo.totalWithdrawable)) {
          throw new Error('Insufficient withdrawable amount');
        }

        // Update beneficiary withdrawn amount
        await beneficiary.update({
          total_withdrawn: (parseFloat(beneficiary.total_withdrawn) + parseFloat(input.amount)).toString()
        });

        return {
          totalWithdrawable: (parseFloat(withdrawableInfo.totalWithdrawable) - parseFloat(input.amount)).toString(),
          vestedAmount: withdrawableInfo.vestedAmount,
          remainingAmount: (parseFloat(withdrawableInfo.remainingAmount) - parseFloat(input.amount)).toString(),
          isFullyVested: withdrawableInfo.isFullyVested,
          nextVestTime: withdrawableInfo.nextVestTime
        };
      } catch (error) {
        logger.error('Error processing withdrawal:', error);
        throw new Error(`Failed to process withdrawal: ${error.message}`);
      }
    },

    processClaim: async (_, { input }) => {
      try {
        const claim = await models.ClaimsHistory.create({
          user_address: input.userAddress,
          token_address: input.tokenAddress,
          amount_claimed: input.amountClaimed,
          claim_timestamp: input.claimTimestamp,
          transaction_hash: input.transactionHash,
          block_number: input.blockNumber
        });

        return claim;
      } catch (error) {
        logger.error('Error processing claim:', error);
        throw new Error(`Failed to process claim: ${error.message}`);
      }
    },

    processBatchClaims: async (_, { claims }) => {
      try {
        const processedClaims = await models.ClaimsHistory.bulkCreate(
          claims.map(claim => ({
            user_address: claim.userAddress,
            token_address: claim.tokenAddress,
            amount_claimed: claim.amountClaimed,
            claim_timestamp: claim.claimTimestamp,
            transaction_hash: claim.transactionHash,
            block_number: claim.blockNumber
          })),
          { returning: true }
        );

        return processedClaims;
      } catch (error) {
        logger.error('Error processing batch claims:', error);
        throw new Error(`Failed to process batch claims: ${error.message}`);
      }
    },

    backfillMissingPrices: async () => {
      try {
        // This would integrate with a price service to backfill missing prices
        // For now, return a placeholder implementation
        const claimsWithoutPrice = await models.ClaimsHistory.findAll({
          where: {
            price_at_claim_usd: null
          }
        });

        // In a real implementation, you would fetch prices from an API
        // and update each claim with the price at the time of claim
        
        return claimsWithoutPrice.length;
      } catch (error) {
        logger.error('Error backfilling prices:', error);
        throw new Error(`Failed to backfill prices: ${error.message}`);
      }
    }
  },

  Beneficiary: {
    vault: async (beneficiary) => {
      try {
        return await models.Vault.findByPk(beneficiary.vault_id);
      } catch (error) {
        logger.error('Error fetching vault for beneficiary:', error);
        return null;
      }
    },

    withdrawableAmount: async (beneficiary, { withdrawableAt }) => {
      try {
        const vault = await models.Vault.findByPk(beneficiary.vault_id);
        if (!vault) {
          throw new Error('Vault not found');
        }

        return await calculateWithdrawableAmount(vault, beneficiary, withdrawableAt);
      } catch (error) {
        logger.error('Error calculating withdrawable amount:', error);
        throw new Error(`Failed to calculate withdrawable amount: ${error.message}`);
      }
    }
  }
};

module.exports = { userResolver };
