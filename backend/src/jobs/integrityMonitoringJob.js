const logger = require('../utils/logger');
const cron = require('node-cron');
const { Vault, Beneficiary } = require('../models');
// stellar-sdk v11 exposes the Soroban RPC client as `SorobanRpc.Server`
// (the `rpc` namespace only exists in @stellar/stellar-sdk v12+).
const { SorobanRpc, xdr, Address } = require('stellar-sdk');
const notificationService = require('../services/notificationService');

/**
 * Integrity Monitoring Job
 * 
 * To protect against "Admin-Level Malware," the backend continuously verifies 
 * the code of the contracts it is managing. This job queries the wasm_hash 
 * of every active vault on the Stellar network every hour and compares it 
 * against the "Approved Master Hash".
 */
class IntegrityMonitoringJob {
  constructor() {
    this.cronSchedule = '0 * * * *'; // Run every hour
    this.rpcUrl = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org:443';
    this.approvedHash = process.env.APPROVED_VAULT_WASM_HASH;
    this.server = new SorobanRpc.Server(this.rpcUrl);

    if (!this.approvedHash) {
      logger.warn('WARNING: APPROVED_VAULT_WASM_HASH is not defined. Integrity monitoring will log mismatches but cannot verify.');
    }
  }

  /**
   * Start the integrity monitoring job
   */
  start() {
    logger.info('Initializing Integrity Monitoring Job...');
    cron.schedule(this.cronSchedule, async () => {
      logger.info('Running Continuous Integrity Monitoring...');
      try {
        await this.monitorIntegrity();
      } catch (error) {
        logger.error('Error in Integrity Monitoring Job:', error);
      }
    });
    logger.info('Integrity Monitoring Job started.');
  }

  /**
   * Monitor integrity of all active vaults
   */
  async monitorIntegrity() {
    try {
      // Fetch all active vaults from database
      const activeVaults = await Vault.findAll({
        where: {
          is_active: true,
          is_blacklisted: false
        }
      });

      logger.info(`Verifying integrity for ${activeVaults.length} active vaults...`);

      for (const vault of activeVaults) {
        try {
          const onChainHash = await this.getContractWasmHash(vault.address);
          
          if (!onChainHash) {
            logger.error(`Could not fetch wasm_hash for vault ${vault.address}. Skipping...`);
            continue;
          }

          if (this.approvedHash && onChainHash !== this.approvedHash) {
            logger.error(`CRITICAL: Integrity failure detected for vault ${vault.address}!`);
            logger.error(`Expected: ${this.approvedHash}`);
            logger.error(`Found:    ${onChainHash}`);
            
            await this.blacklistVault(vault);
          } else {
            logger.info(`Vault ${vault.address} integrity verified.`);
          }
        } catch (vaultError) {
          logger.error(`Error verifying vault ${vault.address}:`, vaultError.message);
        }
      }
    } catch (error) {
      logger.error('Error during integrity monitoring process:', error);
      throw error;
    }
  }

  /**
   * Fetch the WASM hash for a given contract ID
   * @param {string} contractId - The contract ID to check
   * @returns {Promise<string|null>} - The hex-encoded WASM hash or null
   */
  async getContractWasmHash(contractId) {
    try {
      // Build ledger key for contract instance
      // The contract instance is stored in a CONTRACT_DATA entry with key ScVal.scvLedgerKeyContractInstance()
      const ledgerKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
        contract: Address.fromString(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }));

      const response = await this.server.getLedgerEntries(ledgerKey);

      if (!response || !response.entries || response.entries.length === 0) {
        return null;
      }

      const entry = response.entries[0];
      const ledgerEntryData = xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64');
      const contractData = ledgerEntryData.contractData();
      const instance = contractData.val().instance();
      const executable = instance.executable();

      if (executable.switch() === xdr.ContractExecutableType.contractExecutableWasm()) {
        return executable.wasmHash().toString('hex');
      }

      return null;
    } catch (error) {
      logger.error(`Error fetching WASM hash for ${contractId}:`, error);
      return null;
    }
  }

  /**
   * Blacklist a vault and notify beneficiaries
   * @param {Object} vault - Vault model instance
   */
  async blacklistVault(vault) {
    try {
      logger.info(`Blacklisting vault ${vault.address}...`);
      
      // Update vault status in database
      await vault.update({
        is_active: false,
        is_blacklisted: true,
        updated_at: new Date()
      });

      // Notify beneficiaries
      await notificationService.notifyIntegrityFailure(vault);
      
      logger.info(`Vault ${vault.address} blacklisted and beneficiaries notified.`);
    } catch (error) {
      logger.error(`Error blacklisting vault ${vault.address}:`, error);
    }
  }
}

module.exports = new IntegrityMonitoringJob();
