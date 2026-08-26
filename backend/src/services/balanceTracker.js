/**
 * BalanceTracker - Service for querying and verifying token balances
 * 
 * This service handles balance queries for both static and dynamic tokens,
 * including verification of actual received amounts after deposits.
 */

const logger = require('../utils/logger');
const axios = require('axios');
const { BalanceQueryFailedError } = require('../errors/VaultErrors');
const { executeRpcWithRetry } = require('../../../rpc-retry');

class BalanceTracker {
  /**
   * Create a BalanceTracker instance
   * @param {string} rpcUrl - Stellar RPC URL for querying balances
   */
  constructor(rpcUrl = null) {
    this.rpcUrl = rpcUrl || process.env.STELLAR_RPC_URL;
    const configuredTimeout = Number(process.env.BALANCE_TRACKER_RPC_TIMEOUT_MS || 10000);
    this.rpcTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 10000;
    if (!this.rpcUrl) {
      throw new Error('STELLAR_RPC_URL environment variable is required');
    }
  }

  /**
   * Query the actual SAC token balance for a vault
   * @param {string} tokenAddress - The token contract address
   * @param {string} vaultAddress - The vault address to query balance for
   * @returns {Promise<string>} The actual balance as a string
   * @throws {BalanceQueryFailedError} If the balance query fails
   */
  async getActualBalance(tokenAddress, vaultAddress) {
    try {
      const rpcCall = () =>
        axios.post(this.rpcUrl, {
          jsonrpc: '2.0',
          id: 1,
          method: 'simulateTransaction',
          params: {
            transaction: this._buildBalanceQueryTransaction(tokenAddress, vaultAddress),
          },
        }, {
          timeout: this.rpcTimeoutMs,
        });

      const response = await executeRpcWithRetry(rpcCall, `getActualBalance for ${vaultAddress}`);
      
      if (response.data.error) {
        throw new Error(response.data.error.message || 'RPC error');
      }

      if (!response.data.result) {
        throw new Error('No result returned from RPC');
      }

      // Extract balance from the response
      const balance = this._extractBalanceFromResult(response.data.result);
      
      return balance;
    } catch (error) {
      logger.error(`Balance query failed for token ${tokenAddress} in vault ${vaultAddress}:`, error);
      throw new BalanceQueryFailedError(tokenAddress, vaultAddress, error);
    }
  }

  /**
   * Build a transaction for querying token balance
   * @private
   * @param {string} tokenAddress - The token contract address
   * @param {string} vaultAddress - The vault address
   * @returns {string} The transaction XDR
   */
  _buildBalanceQueryTransaction(tokenAddress, vaultAddress) {
    // This is a simplified placeholder
    // In a real implementation, you would need to construct a proper Stellar transaction
    // that calls the balance() function on the SAC token contract
    // For now, we'll return a placeholder that indicates this needs proper implementation
    return {
      contractAddress: tokenAddress,
      function: 'balance',
      args: [vaultAddress]
    };
  }

  /**
   * Verify deposit by calculating the actual received amount
   * @param {string} tokenAddress - The token contract address
   * @param {string} vaultAddress - The vault address
   * @param {string} balanceBefore - The balance before the deposit
   * @returns {Promise<string>} The actual amount received (balance_after - balance_before)
   * @throws {BalanceQueryFailedError} If the balance query fails
   */
  async verifyDeposit(tokenAddress, vaultAddress, balanceBefore) {
    try {
      const balanceAfter = await this.getActualBalance(tokenAddress, vaultAddress);
      
      // Calculate the actual received amount
      const balanceBeforeNum = typeof balanceBefore === 'string' 
        ? parseFloat(balanceBefore) 
        : balanceBefore;
      const balanceAfterNum = typeof balanceAfter === 'string' 
        ? parseFloat(balanceAfter) 
        : balanceAfter;
      
      const actualReceived = balanceAfterNum - balanceBeforeNum;
      
      // Return as string to maintain precision
      return String(actualReceived);
    } catch (error) {
      // If it's already a BalanceQueryFailedError, rethrow it
      if (error instanceof BalanceQueryFailedError) {
        throw error;
      }
      
      logger.error(`Deposit verification failed for token ${tokenAddress} in vault ${vaultAddress}:`, error);
      throw new BalanceQueryFailedError(tokenAddress, vaultAddress, error);
    }
  }

  /**
   * Extract balance value from Stellar RPC result
   * @private
   * @param {Object} result - The simulation result from Stellar RPC
   * @returns {string} The balance as a string
   */
  _extractBalanceFromResult(result) {
    // Handle different result formats from Stellar SDK
    // The exact format may vary based on SDK version and contract implementation
    
    if (result.result && result.result.retval) {
      // Extract from retval (common format)
      const retval = result.result.retval;
      
      // Handle ScVal types
      if (retval._switch && retval._switch.name === 'scvI128') {
        // i128 type - extract the value
        return this._extractI128Value(retval);
      }
      
      if (retval._value !== undefined) {
        return String(retval._value);
      }
      
      // Try direct value extraction
      if (typeof retval === 'number' || typeof retval === 'bigint') {
        return String(retval);
      }
    }
    
    // Fallback: try to extract any numeric value from the result
    if (typeof result === 'number' || typeof result === 'bigint') {
      return String(result);
    }
    
    throw new Error('Unable to extract balance from result: ' + JSON.stringify(result));
  }

  /**
   * Extract i128 value from ScVal
   * @private
   * @param {Object} scval - The ScVal object containing i128 value
   * @returns {string} The extracted value as a string
   */
  _extractI128Value(scval) {
    // i128 in Stellar is represented as high and low 64-bit parts
    if (scval.i128) {
      const { hi, lo } = scval.i128;
      // Combine high and low parts to get the full i128 value
      // For simplicity, if hi is 0, just return lo
      if (hi === 0 || hi === 0n) {
        return String(lo);
      }
      // For full i128 support, we'd need to properly combine hi and lo
      // This is a simplified version
      const value = (BigInt(hi) << 64n) | BigInt(lo);
      return String(value);
    }
    
    throw new Error('Invalid i128 ScVal structure');
  }
}

module.exports = BalanceTracker;
