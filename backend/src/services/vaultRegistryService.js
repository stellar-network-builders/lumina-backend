const logger = require('../utils/logger');
const { VaultRegistry, Vault, IndexerState } = require('../models');
const { Op } = require('sequelize');
const Sentry = require('@sentry/node');
// stellar-sdk v11 replaced the old top-level `Server` with `Horizon.Server`.
const { Horizon } = require('stellar-sdk');

class VaultRegistryService {
  constructor() {
    this.serviceName = 'vault-registry-indexer';
    this.stellarServer = new Horizon.Server(process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org');
  }

  /**
   * Get the last processed ledger for vault registry indexing
   */
  async getLastProcessedLedger() {
    try {
      const state = await IndexerState.findByPk(this.serviceName);
      return state ? state.last_ingested_ledger : 0;
    } catch (error) {
      logger.error('Error fetching last processed ledger:', error);
      throw error;
    }
  }

  /**
   * Update the last processed ledger
   */
  async updateLastProcessedLedger(sequence, transaction = null) {
    try {
      const options = transaction ? { transaction } : {};
      
      const [state, created] = await IndexerState.findOrCreate({
        where: { service_name: this.serviceName },
        defaults: { last_ingested_ledger: sequence },
        ...options
      });

      if (!created) {
        state.last_ingested_ledger = sequence;
        await state.save(options);
      }
      
      return sequence;
    } catch (error) {
      logger.error('Error updating last processed ledger:', error);
      throw error;
    }
  }

  /**
   * Register a new vault in the registry
   */
  async registerVault(vaultData) {
    try {
      const {
        contract_id,
        project_name,
        creator_address,
        deployment_ledger,
        deployment_transaction_hash,
        token_address,
        vault_type = 'standard',
        metadata = {}
      } = vaultData;

      // Check if vault already exists
      const existingVault = await VaultRegistry.findOne({
        where: { contract_id }
      });

      if (existingVault) {
        logger.info(`Vault ${contract_id} already registered, updating...`);
        await existingVault.update({
          project_name,
          metadata: { ...existingVault.metadata, ...metadata },
          updated_at: new Date()
        });
        return existingVault;
      }

      // Create new registry entry
      const registryEntry = await VaultRegistry.create({
        contract_id,
        project_name,
        creator_address,
        deployment_ledger,
        deployment_transaction_hash,
        token_address,
        vault_type,
        metadata,
        discovered_at: new Date()
      });

      logger.info(`Registered new vault: ${contract_id} (${project_name})`);
      return registryEntry;
    } catch (error) {
      logger.error('Error registering vault:', error);
      Sentry.captureException(error, {
        tags: { operation: 'registerVault' },
        extra: { vaultData }
      });
      throw error;
    }
  }

  /**
   * List vaults by creator address
   */
  async listVaultsByCreator(creatorAddress, options = {}) {
    try {
      const {
        limit = 50,
        offset = 0,
        includeInactive = false,
        sortBy = 'discovered_at',
        sortOrder = 'DESC'
      } = options;

      const whereClause = { creator_address };
      if (!includeInactive) {
        whereClause.is_active = true;
      }

      const vaults = await VaultRegistry.findAndCountAll({
        where: whereClause,
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: [[sortBy, sortOrder.toUpperCase()]],
        include: [{
          model: Vault,
          as: 'vaultDetails',
          required: false
        }]
      });

      return {
        vaults: vaults.rows.map(vault => ({
          contract_id: vault.contract_id,
          project_name: vault.project_name,
          creator_address: vault.creator_address,
          deployment_ledger: vault.deployment_ledger,
          deployment_transaction_hash: vault.deployment_transaction_hash,
          token_address: vault.token_address,
          vault_type: vault.vault_type,
          is_active: vault.is_active,
          discovered_at: vault.discovered_at,
          metadata: vault.metadata,
          vault_details: vault.vaultDetails
        })),
        pagination: {
          total: vaults.count,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: offset + limit < vaults.count
        }
      };
    } catch (error) {
      logger.error('Error listing vaults by creator:', error);
      Sentry.captureException(error, {
        tags: { operation: 'listVaultsByCreator' },
        extra: { creatorAddress, options }
      });
      throw error;
    }
  }

  /**
   * Search vaults by project name
   */
  async searchVaultsByProjectName(projectName, options = {}) {
    try {
      const {
        limit = 50,
        offset = 0,
        includeInactive = false
      } = options;

      const whereClause = {
        project_name: {
          [Op.iLike]: `%${projectName}%`
        }
      };
      
      if (!includeInactive) {
        whereClause.is_active = true;
      }

      const vaults = await VaultRegistry.findAndCountAll({
        where: whereClause,
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: [['discovered_at', 'DESC']]
      });

      return {
        vaults: vaults.rows,
        pagination: {
          total: vaults.count,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: offset + limit < vaults.count
        }
      };
    } catch (error) {
      logger.error('Error searching vaults by project name:', error);
      throw error;
    }
  }

  /**
   * Get all vaults in the registry (for ecosystem-wide analytics)
   */
  async getAllVaults(options = {}) {
    try {
      const {
        limit = 100,
        offset = 0,
        includeInactive = false,
        vaultType = null
      } = options;

      const whereClause = {};
      if (!includeInactive) {
        whereClause.is_active = true;
      }
      if (vaultType) {
        whereClause.vault_type = vaultType;
      }

      const vaults = await VaultRegistry.findAndCountAll({
        where: whereClause,
        limit: parseInt(limit),
        offset: parseInt(offset),
        order: [['discovered_at', 'DESC']]
      });

      return {
        vaults: vaults.rows,
        pagination: {
          total: vaults.count,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: offset + limit < vaults.count
        }
      };
    } catch (error) {
      logger.error('Error getting all vaults:', error);
      throw error;
    }
  }

  /**
   * Monitor Stellar ledger for new vault deployments
   */
  async monitorForNewVaults(startLedger = null) {
    try {
      const lastProcessed = startLedger || await this.getLastProcessedLedger();
      const latestLedger = await this.stellarServer.loadLedger();

      if (latestLedger.sequence <= lastProcessed) {
        logger.info('No new ledgers to process');
        return { processed: 0, newVaults: [] };
      }

      logger.info(`Processing ledgers ${lastProcessed + 1} to ${latestLedger.sequence}`);
      
      const newVaults = [];
      let processedLedgers = 0;

      // Process transactions in each ledger
      for (let ledgerSeq = lastProcessed + 1; ledgerSeq <= latestLedger.sequence; ledgerSeq++) {
        try {
          const ledger = await this.stellarServer.loadLedger({ sequence: ledgerSeq });
          
          // Look for contract deployment transactions
          for (const transaction of ledger.transactions) {
            const vaultDeployments = await this.extractVaultDeployments(transaction, ledgerSeq);
            newVaults.push(...vaultDeployments);
          }
          
          processedLedgers++;
        } catch (ledgerError) {
          logger.error(`Error processing ledger ${ledgerSeq}:`, ledgerError);
          continue;
        }
      }

      // Update the last processed ledger
      await this.updateLastProcessedLedger(latestLedger.sequence);

      logger.info(`Processed ${processedLedgers} ledgers, found ${newVaults.length} new vaults`);
      return { processed: processedLedgers, newVaults };
    } catch (error) {
      logger.error('Error monitoring for new vaults:', error);
      Sentry.captureException(error, {
        tags: { operation: 'monitorForNewVaults' }
      });
      throw error;
    }
  }

  /**
   * Extract vault deployment information from a Stellar transaction
   */
  async extractVaultDeployments(transaction, ledgerSeq) {
    const deployments = [];

    try {
      // Look for contract creation operations
      for (const operation of transaction.operations) {
        if (operation.type === 'invokeHostFunction' || operation.type === 'createContract') {
          // Check if this is a vault contract deployment
          const vaultInfo = await this.analyzeContractDeployment(operation, transaction);
          
          if (vaultInfo) {
            const registryEntry = await this.registerVault({
              contract_id: vaultInfo.contractId,
              project_name: vaultInfo.projectName || `Vault ${vaultInfo.contractId.slice(0, 8)}...`,
              creator_address: transaction.source_account,
              deployment_ledger: ledgerSeq,
              deployment_transaction_hash: transaction.hash,
              token_address: vaultInfo.tokenAddress,
              vault_type: vaultInfo.vaultType || 'standard',
              metadata: vaultInfo.metadata || {}
            });
            
            deployments.push(registryEntry);
          }
        }
      }
    } catch (error) {
      logger.error('Error extracting vault deployments:', error);
    }

    return deployments;
  }

  /**
   * Analyze a contract deployment to determine if it's a vault
   */
  async analyzeContractDeployment(operation, transaction) {
    try {
      // This is a simplified implementation
      // In a real scenario, you would:
      // 1. Check the contract WASM hash against known vault contract hashes
      // 2. Analyze the constructor parameters for vault-specific data
      // 3. Look for specific function signatures or metadata
      
      // For now, we'll use a heuristic based on operation details
      if (operation.type === 'invokeHostFunction' && operation.hostFunction?.type === 'createContract') {
        const contractId = operation.contractId || operation.contractAddress;
        
        if (contractId) {
          // Try to extract project name from transaction memo or operation details
          const projectName = transaction.memo ? transaction.memo.split(':')[0] : null;
          
          return {
            contractId,
            projectName,
            tokenAddress: operation.tokenAddress,
            vaultType: this.detectVaultType(operation),
            metadata: {
              transactionHash: transaction.hash,
              operationIndex: operation.id,
              network: process.env.STELLAR_NETWORK || 'testnet'
            }
          };
        }
      }
      
      return null;
    } catch (error) {
      logger.error('Error analyzing contract deployment:', error);
      return null;
    }
  }

  /**
   * Detect vault type from operation details
   */
  detectVaultType(operation) {
    // Analyze operation parameters to determine vault type
    if (operation.parameters?.includes('cliff')) {
      return 'cliff';
    }
    if (operation.parameters?.includes('dynamic')) {
      return 'dynamic';
    }
    return 'standard';
  }

  /**
   * Deactivate a vault in the registry
   */
  async deactivateVault(contractId) {
    try {
      const vault = await VaultRegistry.findOne({
        where: { contract_id: contractId }
      });

      if (!vault) {
        throw new Error(`Vault ${contractId} not found in registry`);
      }

      await vault.update({ is_active: false });
      logger.info(`Deactivated vault: ${contractId}`);
      return vault;
    } catch (error) {
      logger.error('Error deactivating vault:', error);
      throw error;
    }
  }
}

module.exports = new VaultRegistryService();
