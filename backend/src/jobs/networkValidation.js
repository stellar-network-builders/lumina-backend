const logger = require('../utils/logger');
const { sequelize } = require('../database/connection');
const axios = require('axios');
const crypto = require('crypto');
const { executeRpcWithRetry } = require('../../../rpc-retry');

/**
 * Validates the network configuration on startup to ensure that
 * the backend is strictly using environment variables and prevents
 * cross-network contamination (e.g., Mainnet DB on Testnet RPC).
 */
async function validateNetworkOnStartup() {
  const rpcUrl = process.env.STELLAR_RPC_URL;
  const envPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE;

  if (!rpcUrl) {
    throw new Error('Startup Error: STELLAR_RPC_URL must be defined in environment variables.');
  }
  if (!envPassphrase) {
    throw new Error('Startup Error: STELLAR_NETWORK_PASSPHRASE must be defined in environment variables.');
  }

  // 1. Fetch network details from the RPC to ensure it matches the ENV passphrase
  let rpcPassphrase;
  try {
    // Try Soroban RPC first (since STELLAR_RPC_URL is usually a Soroban endpoint)
    const sorobanCall = () =>
      axios.post(rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getNetwork',
      });
    const rpcResponse = await executeRpcWithRetry(sorobanCall, 'getNetwork (Soroban)');

    if (rpcResponse.data && rpcResponse.data.result) {
      rpcPassphrase = rpcResponse.data.result.passphrase;
    }
  } catch (error) {
    // Fallback: Try Horizon endpoint if Soroban POST fails (e.g., 405 Method Not Allowed)
    try {
      const horizonCall = () => axios.get(rpcUrl);
      const response = await executeRpcWithRetry(horizonCall, 'getNetwork (Horizon)');
      if (response.data && response.data.network_passphrase) {
        rpcPassphrase = response.data.network_passphrase;
      }
    } catch (horizonError) {
      // After retries, this is a more serious warning.
      logger.warn(`Warning: Could not fetch network details from RPC URL (${rpcUrl}) after multiple attempts: ${horizonError.message}`);
    }
  }

  if (rpcPassphrase && rpcPassphrase !== envPassphrase) {
    throw new Error(`Configuration Mismatch: Environment STELLAR_NETWORK_PASSPHRASE is '${envPassphrase}' but RPC is configured for '${rpcPassphrase}'`);
  }

  // 2. Generate the network ID / genesis hash equivalent from the passphrase
  // In Stellar, the network ID is the SHA-256 hash of the network passphrase
  const genesisHash = crypto.createHash('sha256').update(envPassphrase).digest('hex');

  // 3. Database validation to prevent Mainnet DB from connecting to Testnet RPC
  try {
    // Ensure the network configuration table exists
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS network_configuration (
        id INT PRIMARY KEY DEFAULT 1,
        network_passphrase VARCHAR(255) NOT NULL,
        genesis_hash VARCHAR(64) NOT NULL
      );
    `);

    const [results] = await sequelize.query(`SELECT network_passphrase, genesis_hash FROM network_configuration WHERE id = 1;`);
    
    if (results && results.length > 0) {
      const dbGenesisHash = results[0].genesis_hash;
      if (dbGenesisHash !== genesisHash) {
        throw new Error(`FATAL: DB Network Mismatch! The database was initialized for genesis hash ${dbGenesisHash}, but the current environment is configured for ${genesisHash} (${envPassphrase}). Connecting a DB to an incorrect Network RPC is prevented.`);
      }
    } else {
      // First time startup on this DB, save the network hash state
      await sequelize.query(`
        INSERT INTO network_configuration (id, network_passphrase, genesis_hash) 
        VALUES (1, :passphrase, :genesisHash)
      `, {
        replacements: { passphrase: envPassphrase, genesisHash }
      });
      logger.info(`[Network Validation] Initialized database with network: ${envPassphrase}`);
    }
  } catch (error) {
    if (error.message && error.message.includes('DB Network Mismatch')) {
      throw error; // Rethrow fatal mismatch errors immediately
    }
    logger.warn('[Network Validation] Could not validate database network configuration:', error.message || error);
  }
}

module.exports = { validateNetworkOnStartup };