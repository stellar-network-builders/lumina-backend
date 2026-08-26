const logger = require('../utils/logger');
const models = require('../../models');

export const organizationResolver = {
  Query: {
    organization: async (_: any, { id }: { id: string }) => {
      try {
        const org = await models.Organization.findByPk(id, {
          include: [{ model: models.Vault, as: 'vaults' }],
        });
        return org;
      } catch (error) {
        logger.error('Error fetching organization:', error);
        throw new Error(`Failed to fetch organization: ${error.message}`);
      }
    },

    organizationByAdmin: async (_: any, { adminAddress }: { adminAddress: string }) => {
      try {
        const org = await models.Organization.findOne({
          where: { admin_address: adminAddress },
          include: [{ model: models.Vault, as: 'vaults' }],
        });
        return org;
      } catch (error) {
        logger.error('Error fetching organization by admin:', error);
        throw new Error(`Failed to fetch organization: ${error.message}`);
      }
    },

    organizations: async (
      _: any,
      {
        adminAddress,
        first = 50,
        after,
      }: { adminAddress?: string; first?: number; after?: string }
    ) => {
      try {
        const whereClause: Record<string, unknown> = {};
        if (adminAddress) whereClause.admin_address = adminAddress;

        const offset = after ? parseInt(after, 10) : 0;

        const orgs = await models.Organization.findAll({
          where: whereClause,
          include: [{ model: models.Vault, as: 'vaults' }],
          limit: first,
          offset,
          order: [['created_at', 'DESC']],
        });
        return orgs;
      } catch (error) {
        logger.error('Error fetching organizations:', error);
        throw new Error(`Failed to fetch organizations: ${error.message}`);
      }
    },
  },

  Organization: {
    logoUrl: (org: any) => org?.logo_url ?? null,
    websiteUrl: (org: any) => org?.website_url ?? null,
    discordUrl: (org: any) => org?.discord_url ?? null,
    adminAddress: (org: any) => org?.admin_address,
    createdAt: (org: any) => org?.created_at,
    updatedAt: (org: any) => org?.updated_at,
    vaults: async (org: any) => {
      try {
        if (org.vaults) return org.vaults;
        return await models.Vault.findAll({
          where: { org_id: org.id },
          order: [['created_at', 'DESC']],
        });
      } catch (error) {
        logger.error('Error fetching vaults for organization:', error);
        return [];
      }
    },
  },
};
