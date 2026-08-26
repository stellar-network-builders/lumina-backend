const logger = require('../utils/logger');
const models = require('../../models');
const cacheService = require('../../services/cacheService');
const tvlService = require('../../services/tvlService');

const vaultResolver = {
  Query: {
    vault: async (_, { address, orgId, adminAddress }) => {
      try {
        const whereClause = { address };
        if (orgId && adminAddress) {
          const { isAdminOfOrg } = require('../middleware/auth');
          const isAdmin = await isAdminOfOrg(adminAddress, orgId);
          if (!isAdmin) {
            throw new Error('Access denied: admin does not belong to organization.');
          }
          whereClause.org_id = orgId;
        }

        const vault = await models.Vault.findOne({
          where: whereClause,
          include: [
            {
              model: models.Beneficiary,
              as: 'beneficiaries'
            },
            {
              model: models.SubSchedule,
              as: 'subSchedules'
            }
          ]
        });
        return vault;
      } catch (error) {
        logger.error('Error fetching vault:', error);
        throw new Error(`Failed to fetch vault: ${error.message}`);
      }
    },

    vaults: async (_, { orgId, adminAddress, first = 50, after }) => {
      try {
        if (!orgId || !adminAddress) {
          throw new Error('orgId and adminAddress are required to list vaults.');
        }
        const { isAdminOfOrg } = require('../middleware/auth');
        const isAdmin = await isAdminOfOrg(adminAddress, orgId);
        if (!isAdmin) {
          throw new Error('Access denied: admin does not belong to organization.');
        }
        const offset = after ? parseInt(after, 10) : 0;
        const vaults = await models.Vault.findAll({
          where: { 
            org_id: orgId,
            is_blacklisted: false 
          },
          include: [
            {
              model: models.Beneficiary,
              as: 'beneficiaries'
            },
            {
              model: models.SubSchedule,
              as: 'subSchedules'
            }
          ],
          limit: first,
          offset,
          order: [['created_at', 'DESC']]
        });
        return vaults;
      } catch (error) {
        logger.error('Error fetching vaults:', error);
        throw new Error(`Failed to fetch vaults: ${error.message}`);
      }
    },

    vaultSummary: async (_, { vaultAddress }) => {
      try {
        const vault = await models.Vault.findOne({
          where: { address: vaultAddress },
          include: [
            {
              model: models.Beneficiary,
              as: 'beneficiaries'
            },
            {
              model: models.SubSchedule,
              as: 'subSchedules'
            }
          ]
        });

        if (!vault) {
          throw new Error('Vault not found');
        }

        const totalAllocated = vault.beneficiaries.reduce((sum, beneficiary) => 
          sum + parseFloat(beneficiary.total_allocated), 0);
        const totalWithdrawn = vault.beneficiaries.reduce((sum, beneficiary) => 
          sum + parseFloat(beneficiary.total_withdrawn), 0);
        const remainingAmount = totalAllocated - totalWithdrawn;
        const activeBeneficiaries = vault.beneficiaries.filter((beneficiary) => 
          parseFloat(beneficiary.total_allocated) > parseFloat(beneficiary.total_withdrawn)).length;

        return {
          totalAllocated: totalAllocated.toString(),
          totalWithdrawn: totalWithdrawn.toString(),
          remainingAmount: remainingAmount.toString(),
          activeBeneficiaries,
          totalBeneficiaries: vault.beneficiaries.length
        };
      } catch (error) {
        logger.error('Error fetching vault summary:', error);
        throw new Error(`Failed to fetch vault summary: ${error.message}`);
      }
    }
  },

  Mutation: {
    createVault: async (_, { input }) => {
      try {
        const vault = await models.Vault.create({
          address: input.address,
          name: input.name,
          token_address: input.tokenAddress,
          owner_address: input.ownerAddress,
          total_amount: input.totalAmount
        });

        // Invalidate cache for the owner
        if (input.ownerAddress) {
          await cacheService.invalidateUserVaults(input.ownerAddress);
          logger.info(`Invalidated cache for user vaults: ${input.ownerAddress}`);
        }

        // Update TVL for new vault
        try {
          await tvlService.handleVaultCreated(vault.toJSON());
        } catch (tvlError) {
          logger.error('Error updating TVL for new vault:', tvlError);
          // Don't throw - TVL update failure shouldn't fail vault creation
        }

        return vault;
      } catch (error) {
        logger.error('Error creating vault:', error);
        throw new Error(`Failed to create vault: ${error.message}`);
      }
    },

    topUpVault: async (_, { input }) => {
      try {
        const vault = await models.Vault.findOne({
          where: { address: input.vaultAddress }
        });

        if (!vault) {
          throw new Error('Vault not found');
        }

        const startTimestamp = new Date();
        const endTimestamp = new Date(startTimestamp.getTime() + (input.vestingDuration * 1000));

        const subSchedule = await models.SubSchedule.create({
          vault_id: vault.id,
          top_up_amount: input.amount,
          cliff_duration: input.cliffDuration,
          vesting_duration: input.vestingDuration,
          start_timestamp: startTimestamp,
          end_timestamp: endTimestamp,
          transaction_hash: input.transactionHash,
          block_number: input.blockNumber
        });

        // Update vault total amount
        await vault.update({
          total_amount: (parseFloat(vault.total_amount) + parseFloat(input.amount)).toString()
        });

        // Update TVL for vault top-up
        try {
          await tvlService.handleVaultCreated(vault.toJSON());
        } catch (tvlError) {
          logger.error('Error updating TVL for vault top-up:', tvlError);
          // Don't throw - TVL update failure shouldn't fail top-up
        }

        return subSchedule;
      } catch (error) {
        logger.error('Error processing top-up:', error);
        throw new Error(`Failed to process top-up: ${error.message}`);
      }
    }
  },

  Vault: {
    orgId: (vault) => vault?.org_id ?? null,
    organization: async (vault) => {
      if (!vault?.org_id) return null;
      try {
        return await models.Organization.findByPk(vault.org_id);
      } catch (error) {
        logger.error('Error fetching organization for vault:', error);
        return null;
      }
    },
    beneficiaries: async (vault) => {
      try {
        return await models.Beneficiary.findAll({
          where: { vault_id: vault.id }
        });
      } catch (error) {
        logger.error('Error fetching beneficiaries:', error);
        return [];
      }
    },

    subSchedules: async (vault) => {
      try {
        return await models.SubSchedule.findAll({
          where: { vault_id: vault.id },
          order: [['created_at', 'DESC']]
        });
      } catch (error) {
        logger.error('Error fetching sub-schedules:', error);
        return [];
      }
    },

    summary: async (vault) => {
      try {
        const beneficiaries = await models.Beneficiary.findAll({
          where: { vault_id: vault.id }
        });

        const totalAllocated = beneficiaries.reduce((sum, beneficiary) => 
          sum + parseFloat(beneficiary.total_allocated), 0);
        const totalWithdrawn = beneficiaries.reduce((sum, beneficiary) => 
          sum + parseFloat(beneficiary.total_withdrawn), 0);
        const remainingAmount = totalAllocated - totalWithdrawn;
        const activeBeneficiaries = beneficiaries.filter((beneficiary) => 
          parseFloat(beneficiary.total_allocated) > parseFloat(beneficiary.total_withdrawn)).length;

        return {
          totalAllocated: totalAllocated.toString(),
          totalWithdrawn: totalWithdrawn.toString(),
          remainingAmount: remainingAmount.toString(),
          activeBeneficiaries,
          totalBeneficiaries: beneficiaries.length
        };
      } catch (error) {
        logger.error('Error calculating vault summary:', error);
        return null;
      }
    }
  }
};

module.exports = { vaultResolver };
