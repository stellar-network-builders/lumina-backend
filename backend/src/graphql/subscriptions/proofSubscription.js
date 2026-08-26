const logger = require('../utils/logger');
const { PubSub } = require('graphql-subscriptions');
const { models } = require('../../models');

const pubsub = new PubSub();

// Subscription event constants
const SUBSCRIPTION_EVENTS = {
  VAULT_UPDATED: 'VAULT_UPDATED',
  BENEFICIARY_UPDATED: 'BENEFICIARY_UPDATED',
  NEW_CLAIM: 'NEW_CLAIM',
  WITHDRAWAL_PROCESSED: 'WITHDRAWAL_PROCESSED',
  AUDIT_LOG_CREATED: 'AUDIT_LOG_CREATED',
  ADMIN_TRANSFER_UPDATED: 'ADMIN_TRANSFER_UPDATED',
  TVL_UPDATED: 'TVL_UPDATED'
};

const subscriptionResolver = {
  Subscription: {
    vaultUpdated: {
      subscribe: (_, { vaultAddress }) => {
        const subscription = vaultAddress 
          ? pubsub.asyncIterator([`${SUBSCRIPTION_EVENTS.VAULT_UPDATED}_${vaultAddress}`])
          : pubsub.asyncIterator([SUBSCRIPTION_EVENTS.VAULT_UPDATED]);
        
        return subscription;
      },
      resolve: (payload) => payload
    },

    beneficiaryUpdated: {
      subscribe: (_, { vaultAddress, beneficiaryAddress }) => {
        let eventName = SUBSCRIPTION_EVENTS.BENEFICIARY_UPDATED;
        
        if (vaultAddress && beneficiaryAddress) {
          eventName = `${SUBSCRIPTION_EVENTS.BENEFICIARY_UPDATED}_${vaultAddress}_${beneficiaryAddress}`;
        } else if (vaultAddress) {
          eventName = `${SUBSCRIPTION_EVENTS.BENEFICIARY_UPDATED}_${vaultAddress}`;
        }
        
        return pubsub.asyncIterator([eventName]);
      },
      resolve: (payload) => payload
    },

    newClaim: {
      subscribe: (_, { userAddress }) => {
        const subscription = userAddress 
          ? pubsub.asyncIterator([`${SUBSCRIPTION_EVENTS.NEW_CLAIM}_${userAddress}`])
          : pubsub.asyncIterator([SUBSCRIPTION_EVENTS.NEW_CLAIM]);
        
        return subscription;
      },
      resolve: (payload) => payload
    },

    withdrawalProcessed: {
      subscribe: (_, { vaultAddress, beneficiaryAddress }) => {
        let eventName = SUBSCRIPTION_EVENTS.WITHDRAWAL_PROCESSED;
        
        if (vaultAddress && beneficiaryAddress) {
          eventName = `${SUBSCRIPTION_EVENTS.WITHDRAWAL_PROCESSED}_${vaultAddress}_${beneficiaryAddress}`;
        } else if (vaultAddress) {
          eventName = `${SUBSCRIPTION_EVENTS.WITHDRAWAL_PROCESSED}_${vaultAddress}`;
        }
        
        return pubsub.asyncIterator([eventName]);
      },
      resolve: (payload) => payload
    },

    auditLogCreated: {
      subscribe: () => {
        return pubsub.asyncIterator([SUBSCRIPTION_EVENTS.AUDIT_LOG_CREATED]);
      },
      resolve: (payload) => payload
    },

    adminTransferUpdated: {
      subscribe: (_, { contractAddress }) => {
        const subscription = contractAddress 
          ? pubsub.asyncIterator([`${SUBSCRIPTION_EVENTS.ADMIN_TRANSFER_UPDATED}_${contractAddress}`])
          : pubsub.asyncIterator([SUBSCRIPTION_EVENTS.ADMIN_TRANSFER_UPDATED]);
        
        return subscription;
      },
      resolve: (payload) => payload
    },

    tvlUpdated: {
      subscribe: () => {
        return pubsub.asyncIterator([SUBSCRIPTION_EVENTS.TVL_UPDATED]);
      },
      resolve: (payload) => payload
    }
  }
};

// Helper functions to publish events
const publishVaultUpdate = async (vaultAddress, vaultData) => {
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

    if (vault) {
      // Publish to general vault updates
      pubsub.publish(SUBSCRIPTION_EVENTS.VAULT_UPDATED, { vaultUpdated: vault });
      
      // Publish to specific vault updates
      pubsub.publish(`${SUBSCRIPTION_EVENTS.VAULT_UPDATED}_${vaultAddress}`, { vaultUpdated: vault });
    } else {
      throw new Error(`Vault not found: ${vaultAddress}`);
    }
  } catch (error) {
    logger.error('Error publishing vault update:', error);
  }
};

const publishBeneficiaryUpdate = async (
  vaultAddress, 
  beneficiaryAddress, 
  beneficiaryData
) => {
  try {
    const vault = await models.Vault.findOne({
      where: { address: vaultAddress }
    });

    if (vault) {
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

      if (beneficiary) {
        // Publish to general beneficiary updates
        pubsub.publish(SUBSCRIPTION_EVENTS.BENEFICIARY_UPDATED, { beneficiaryUpdated: beneficiary });
        
        // Publish to vault-specific beneficiary updates
        pubsub.publish(`${SUBSCRIPTION_EVENTS.BENEFICIARY_UPDATED}_${vaultAddress}`, { 
          beneficiaryUpdated: beneficiary 
        });
        
        // Publish to specific beneficiary updates
        pubsub.publish(`${SUBSCRIPTION_EVENTS.BENEFICIARY_UPDATED}_${vaultAddress}_${beneficiaryAddress}`, { 
          beneficiaryUpdated: beneficiary 
        });
      } else {
        throw new Error(`Beneficiary not found: ${beneficiaryAddress} in vault ${vaultAddress}`);
      }
    } else {
      throw new Error(`Vault not found: ${vaultAddress}`);
    }
  } catch (error) {
    logger.error('Error publishing beneficiary update:', error);
  }
};

const publishNewClaim = async (userAddress, claimData) => {
  try {
    const claim = await models.ClaimsHistory.findOne({
      where: { transaction_hash: claimData.transactionHash }
    });

    if (claim) {
      // Publish to general claim updates
      pubsub.publish(SUBSCRIPTION_EVENTS.NEW_CLAIM, { newClaim: claim });
      
      // Publish to user-specific claim updates
      pubsub.publish(`${SUBSCRIPTION_EVENTS.NEW_CLAIM}_${userAddress}`, { newClaim: claim });
    }
  } catch (error) {
    logger.error('Error publishing new claim:', error);
  }
};

const publishWithdrawalProcessed = async (
  vaultAddress, 
  beneficiaryAddress, 
  withdrawableInfo
) => {
  try {
    // Publish to general withdrawal updates
    pubsub.publish(SUBSCRIPTION_EVENTS.WITHDRAWAL_PROCESSED, { withdrawalProcessed: withdrawableInfo });
    
    // Publish to vault-specific withdrawal updates
    pubsub.publish(`${SUBSCRIPTION_EVENTS.WITHDRAWAL_PROCESSED}_${vaultAddress}`, { 
      withdrawalProcessed: withdrawableInfo 
    });
    
    // Publish to specific beneficiary withdrawal updates
    pubsub.publish(`${SUBSCRIPTION_EVENTS.WITHDRAWAL_PROCESSED}_${vaultAddress}_${beneficiaryAddress}`, { 
      withdrawalProcessed: withdrawableInfo 
    });
  } catch (error) {
    logger.error('Error publishing withdrawal processed:', error);
  }
};

const publishAuditLogCreated = async (auditLog) => {
  try {
    pubsub.publish(SUBSCRIPTION_EVENTS.AUDIT_LOG_CREATED, { auditLogCreated: auditLog });
  } catch (error) {
    logger.error('Error publishing audit log created:', error);
  }
};

const publishAdminTransferUpdated = async (contractAddress, transferData) => {
  try {
    // Publish to general admin transfer updates
    pubsub.publish(SUBSCRIPTION_EVENTS.ADMIN_TRANSFER_UPDATED, { adminTransferUpdated: transferData });
    
    // Publish to contract-specific admin transfer updates
    pubsub.publish(`${SUBSCRIPTION_EVENTS.ADMIN_TRANSFER_UPDATED}_${contractAddress}`, { 
      adminTransferUpdated: transferData 
    });
  } catch (error) {
    logger.error('Error publishing admin transfer updated:', error);
  }
};

const publishTVLUpdate = async (tvlStats) => {
  try {
    pubsub.publish(SUBSCRIPTION_EVENTS.TVL_UPDATED, { tvlUpdated: tvlStats });
    logger.info('TVL update published via WebSocket:', tvlStats);
  } catch (error) {
    logger.error('Error publishing TVL update:', error);
  }
};

// Export pubsub instance for use in other resolvers
module.exports = {
  SUBSCRIPTION_EVENTS,
  subscriptionResolver,
  publishVaultUpdate,
  publishBeneficiaryUpdate,
  publishNewClaim,
  publishWithdrawalProcessed,
  publishAuditLogCreated,
  publishAdminTransferUpdated,
  publishTVLUpdate,
  pubsub 
};
