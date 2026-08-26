const logger = require('../utils/logger');
const { Token } = require('../models/token');
const Vault = require('../models/vault');
const axios = require('axios');
const { executeRpcWithRetry } = require('../../../rpc-retry');

/**
 * Worker to detect new token addresses and fetch/store their metadata.
 */
class TokenMetadataWorker {
  constructor(sequelize) {
    this.sequelize = sequelize;
  }

  async detectAndFetchNewTokens() {
    // 1. Get all unique token addresses from Vaults
    const vaults = await Vault.findAll({ attributes: ['token_address'] });
    const addresses = vaults.map(function(v) { return v.token_address; });
    const uniqueAddresses = Array.from(new Set(addresses));

    // 2. For each address, check if it exists in tokens table
    for (let i = 0; i < uniqueAddresses.length; i++) {
      const address = uniqueAddresses[i];
      const exists = await Token.findOne({ where: { address } });
      if (!exists) {
        // 3. Fetch metadata from Stellar
        try {
          const meta = await this.fetchTokenMetadata(address);
          if (meta) {
            await Token.create({
              address: address,
              symbol: meta.symbol,
              name: meta.name,
              decimals: meta.decimals,
            });
            logger.info(`Token metadata stored for ${address}`);
          }
        } catch (err) {
          logger.error(`Failed to fetch/store metadata for ${address}:`, err);
        }
      }
    }
  }

  async fetchTokenMetadata(address) {
    // Example: Replace with actual Soroban RPC call
    const rpcUrl = process.env.STELLAR_RPC_URL;
    if (!rpcUrl) {
      throw new Error('STELLAR_RPC_URL environment variable is required');
    }

    const rpcCall = () => axios.post(`${rpcUrl}/getTokenMetadata`, { address: address });
    const response = await executeRpcWithRetry(rpcCall, `fetchTokenMetadata for ${address}`);

    const symbol = response.data?.symbol;
    const name = response.data?.name;
    const decimals = response.data?.decimals;
    if (symbol && name && typeof decimals === 'number') {
      return { symbol, name, decimals };
    }
    return null;
  }
}

module.exports = { TokenMetadataWorker };
