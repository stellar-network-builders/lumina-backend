'use strict';

// stellar-sdk v11 replaced the old top-level `Server` with `Horizon.Server`.
const { Horizon, TransactionBuilder, Networks, Operation, Asset, Keypair } = require('stellar-sdk');
const auditLogger = require('./auditLogger');

class FutureLienContractService {
  constructor() {
    // Initialize Stellar server based on environment
    this.server = new Horizon.Server(
      process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
    );
    
    // Contract addresses (these should be loaded from environment or config)
    this.vestingVaultContractAddress = process.env.VESTING_VAULT_CONTRACT_ADDRESS;
    this.grantStreamContractAddress = process.env.GRANT_STREAM_CONTRACT_ADDRESS;
    this.futureLienContractAddress = process.env.FUTURE_LIEN_CONTRACT_ADDRESS;
  }

  /**
   * Create a future lien on-chain by calling the smart contract
   * 
   * @param {Object} params - Lien parameters
   * @param {string} params.vaultAddress - Vesting vault contract address
   * @param {string} params.beneficiaryAddress - Beneficiary address
   * @param {string} params.grantStreamAddress - Grant stream contract address
   * @param {number} params.committedAmount - Amount to commit (in stroops)
   * @param {number} params.releaseStartTime - Release start timestamp
   * @param {number} params.releaseEndTime - Release end timestamp
   * @param {string} params.releaseRateType - 'linear', 'milestone', or 'immediate'
   * @param {string} params.signerPrivateKey - Private key of the beneficiary
   * @returns {Promise<Object>} Transaction result
   */
  async createFutureLienOnChain(params) {
    try {
      const {
        vaultAddress,
        beneficiaryAddress,
        grantStreamAddress,
        committedAmount,
        releaseStartTime,
        releaseEndTime,
        releaseRateType,
        signerPrivateKey
      } = params;

      // Validate inputs
      if (!this.futureLienContractAddress) {
        throw new Error('Future lien contract address not configured');
      }

      // Load the signer keypair
      const keypair = Keypair.fromSecret(signerPrivateKey);
      const publicKey = keypair.publicKey();

      // Verify the signer matches the beneficiary
      if (publicKey !== beneficiaryAddress) {
        throw new Error('Signer address does not match beneficiary address');
      }

      // Get the account details
      const account = await this.server.loadAccount(publicKey);

      // Build the contract invocation transaction
      const transaction = new TransactionBuilder(account, {
        fee: await this.server.fetchBaseFee(),
        networkPassphrase: Networks.TESTNET // Use appropriate network
      })
      .addOperation(Operation.invokeContractFunction({
        contract: this.futureLienContractAddress,
        functionName: 'create_future_lien',
        args: [
          // Convert parameters to contract format
          this._addressToScAddress(vaultAddress),
          this._addressToScAddress(grantStreamAddress),
          this._numberToScVal(committedAmount),
          this._numberToScVal(releaseStartTime),
          this._numberToScVal(releaseEndTime),
          this._stringToScVal(releaseRateType)
        ]
      }))
      .setTimeout(30)
      .build();

      // Sign the transaction
      transaction.sign(keypair);

      // Submit the transaction
      const result = await this.server.submitTransaction(transaction);

      if (!result.successful) {
        throw new Error(`Contract invocation failed: ${result.resultXdr}`);
      }

      // Log the successful contract interaction
      auditLogger.logAction(beneficiaryAddress, 'CONTRACT_CREATE_FUTURE_LIEN', result.hash, {
        vaultAddress,
        grantStreamAddress,
        committedAmount,
        releaseRateType,
        transactionHash: result.hash
      });

      return {
        success: true,
        transactionHash: result.hash,
        ledger: result.ledger,
        contractResult: result.resultXdr,
        message: 'Future lien created successfully on-chain'
      };

    } catch (error) {
      console.error('Error creating future lien on-chain:', error);
      
      // Log the error
      auditLogger.logAction(params.beneficiaryAddress, 'CONTRACT_CREATE_FUTURE_LIEN_ERROR', null, {
        error: error.message,
        vaultAddress: params.vaultAddress,
        grantStreamAddress: params.grantStreamAddress
      });

      throw error;
    }
  }

  /**
   * Process a release from a future lien on-chain
   * 
   * @param {Object} params - Release parameters
   * @param {string} params.lienId - Lien identifier
   * @param {number} params.amount - Amount to release (in stroops)
   * @param {string} params.signerPrivateKey - Private key of authorized releaser
   * @returns {Promise<Object>} Transaction result
   */
  async processLienReleaseOnChain(params) {
    try {
      const {
        lienId,
        amount,
        signerPrivateKey
      } = params;

      // Load the signer keypair
      const keypair = Keypair.fromSecret(signerPrivateKey);
      const publicKey = keypair.publicKey();

      // Get the account details
      const account = await this.server.loadAccount(publicKey);

      // Build the contract invocation transaction
      const transaction = new TransactionBuilder(account, {
        fee: await this.server.fetchBaseFee(),
        networkPassphrase: Networks.TESTNET
      })
      .addOperation(Operation.invokeContractFunction({
        contract: this.futureLienContractAddress,
        functionName: 'release_lien_tokens',
        args: [
          this._stringToScVal(lienId),
          this._numberToScVal(amount)
        ]
      }))
      .setTimeout(30)
      .build();

      // Sign the transaction
      transaction.sign(keypair);

      // Submit the transaction
      const result = await this.server.submitTransaction(transaction);

      if (!result.successful) {
        throw new Error(`Contract invocation failed: ${result.resultXdr}`);
      }

      // Log the successful contract interaction
      auditLogger.logAction(publicKey, 'CONTRACT_RELEASE_LIEN_TOKENS', result.hash, {
        lienId,
        amount,
        transactionHash: result.hash
      });

      return {
        success: true,
        transactionHash: result.hash,
        ledger: result.ledger,
        contractResult: result.resultXdr,
        message: 'Lien tokens released successfully on-chain'
      };

    } catch (error) {
      console.error('Error processing lien release on-chain:', error);
      
      // Log the error
      auditLogger.logAction(params.signerPublicKey, 'CONTRACT_RELEASE_LIEN_TOKENS_ERROR', null, {
        error: error.message,
        lienId: params.lienId
      });

      throw error;
    }
  }

  /**
   * Cancel a future lien on-chain
   * 
   * @param {Object} params - Cancellation parameters
   * @param {string} params.lienId - Lien identifier
   * @param {string} params.signerPrivateKey - Private key of beneficiary or authorized party
   * @returns {Promise<Object>} Transaction result
   */
  async cancelFutureLienOnChain(params) {
    try {
      const {
        lienId,
        signerPrivateKey
      } = params;

      // Load the signer keypair
      const keypair = Keypair.fromSecret(signerPrivateKey);
      const publicKey = keypair.publicKey();

      // Get the account details
      const account = await this.server.loadAccount(publicKey);

      // Build the contract invocation transaction
      const transaction = new TransactionBuilder(account, {
        fee: await this.server.fetchBaseFee(),
        networkPassphrase: Networks.TESTNET
      })
      .addOperation(Operation.invokeContractFunction({
        contract: this.futureLienContractAddress,
        functionName: 'cancel_future_lien',
        args: [
          this._stringToScVal(lienId)
        ]
      }))
      .setTimeout(30)
      .build();

      // Sign the transaction
      transaction.sign(keypair);

      // Submit the transaction
      const result = await this.server.submitTransaction(transaction);

      if (!result.successful) {
        throw new Error(`Contract invocation failed: ${result.resultXdr}`);
      }

      // Log the successful contract interaction
      auditLogger.logAction(publicKey, 'CONTRACT_CANCEL_FUTURE_LIEN', result.hash, {
        lienId,
        transactionHash: result.hash
      });

      return {
        success: true,
        transactionHash: result.hash,
        ledger: result.ledger,
        contractResult: result.resultXdr,
        message: 'Future lien cancelled successfully on-chain'
      };

    } catch (error) {
      console.error('Error cancelling future lien on-chain:', error);
      
      // Log the error
      auditLogger.logAction(params.signerPublicKey, 'CONTRACT_CANCEL_FUTURE_LIEN_ERROR', null, {
        error: error.message,
        lienId: params.lienId
      });

      throw error;
    }
  }

  /**
   * Query the current state of a future lien from the contract
   * 
   * @param {string} lienId - Lien identifier
   * @returns {Promise<Object>} Lien state from contract
   */
  async getLienStateFromContract(lienId) {
    try {
      if (!this.futureLienContractAddress) {
        throw new Error('Future lien contract address not configured');
      }

      // Build the contract read transaction
      const transaction = new TransactionBuilder(new Account('G...', '1'), {
        fee: 100,
        networkPassphrase: Networks.TESTNET
      })
      .addOperation(Operation.invokeContractFunction({
        contract: this.futureLienContractAddress,
        functionName: 'get_lien_state',
        args: [
          this._stringToScVal(lienId)
        ]
      }))
      .setTimeout(30)
      .build();

      // Simulate the transaction to get the result
      const result = await this.server.simulateTransaction(transaction);

      if (!result.results || result.results.length === 0) {
        throw new Error('No results returned from contract simulation');
      }

      // Parse the contract result
      const lienState = this._parseLienState(result.results[0]);

      return {
        success: true,
        lienState,
        message: 'Lien state retrieved successfully'
      };

    } catch (error) {
      console.error('Error getting lien state from contract:', error);
      throw error;
    }
  }

  /**
   * Get the available release amount for a lien from the contract
   * 
   * @param {string} lienId - Lien identifier
   * @returns {Promise<number>} Available amount for release
   */
  async getAvailableReleaseAmount(lienId) {
    try {
      const transaction = new TransactionBuilder(new Account('G...', '1'), {
        fee: 100,
        networkPassphrase: Networks.TESTNET
      })
      .addOperation(Operation.invokeContractFunction({
        contract: this.futureLienContractAddress,
        functionName: 'get_available_release_amount',
        args: [
          this._stringToScVal(lienId)
        ]
      }))
      .setTimeout(30)
      .build();

      const result = await this.server.simulateTransaction(transaction);

      if (!result.results || result.results.length === 0) {
        throw new Error('No results returned from contract simulation');
      }

      const availableAmount = this._parseNumberFromScVal(result.results[0]);

      return {
        success: true,
        availableAmount,
        message: 'Available release amount retrieved successfully'
      };

    } catch (error) {
      console.error('Error getting available release amount:', error);
      throw error;
    }
  }

  /**
   * Create a grant stream contract
   * 
   * @param {Object} params - Grant stream parameters
   * @param {string} params.ownerAddress - Owner address
   * @param {string} params.tokenAddress - Token address
   * @param {number} params.targetAmount - Target funding amount
   * @param {string} params.signerPrivateKey - Private key of owner
   * @returns {Promise<Object>} Transaction result
   */
  async createGrantStreamContract(params) {
    try {
      const {
        ownerAddress,
        tokenAddress,
        targetAmount,
        signerPrivateKey
      } = params;

      // Load the signer keypair
      const keypair = Keypair.fromSecret(signerPrivateKey);
      const publicKey = keypair.publicKey();

      // Verify the signer matches the owner
      if (publicKey !== ownerAddress) {
        throw new Error('Signer address does not match owner address');
      }

      // Get the account details
      const account = await this.server.loadAccount(publicKey);

      // Deploy the grant stream contract (this would involve uploading WASM and creating the contract)
      // For now, we'll assume the contract is already deployed and we're just initializing it
      
      const transaction = new TransactionBuilder(account, {
        fee: await this.server.fetchBaseFee(),
        networkPassphrase: Networks.TESTNET
      })
      .addOperation(Operation.invokeContractFunction({
        contract: this.grantStreamContractAddress,
        functionName: 'initialize',
        args: [
          this._addressToScAddress(tokenAddress),
          this._numberToScVal(targetAmount)
        ]
      }))
      .setTimeout(30)
      .build();

      // Sign the transaction
      transaction.sign(keypair);

      // Submit the transaction
      const result = await this.server.submitTransaction(transaction);

      if (!result.successful) {
        throw new Error(`Contract invocation failed: ${result.resultXdr}`);
      }

      // Log the successful contract interaction
      auditLogger.logAction(ownerAddress, 'CONTRACT_CREATE_GRANT_STREAM', result.hash, {
        tokenAddress,
        targetAmount,
        transactionHash: result.hash
      });

      return {
        success: true,
        transactionHash: result.hash,
        ledger: result.ledger,
        contractResult: result.resultXdr,
        message: 'Grant stream contract created successfully'
      };

    } catch (error) {
      console.error('Error creating grant stream contract:', error);
      
      // Log the error
      auditLogger.logAction(params.ownerAddress, 'CONTRACT_CREATE_GRANT_STREAM_ERROR', null, {
        error: error.message,
        tokenAddress: params.tokenAddress
      });

      throw error;
    }
  }

  // Helper methods for converting between JavaScript and Stellar contract types

  _addressToScAddress(address) {
    // Convert Stellar address to contract address format
    return new Address(address);
  }

  _numberToScVal(number) {
    // Convert number to Stellar contract value
    return xdr.ScVal.scvU64(new xdr.Uint64(BigInt(number)));
  }

  _stringToScVal(string) {
    // Convert string to Stellar contract value
    return xdr.ScVal.scvString(string);
  }

  _parseLienState(scVal) {
    // Parse the lien state from Stellar contract value
    // This would depend on the actual contract return structure
    try {
      const parsed = scVal.value();
      return {
        lienId: parsed.lien_id?.toString(),
        vaultAddress: parsed.vault_address?.toString(),
        beneficiaryAddress: parsed.beneficiary_address?.toString(),
        grantStreamAddress: parsed.grant_stream_address?.toString(),
        committedAmount: Number(parsed.committed_amount),
        releasedAmount: Number(parsed.released_amount),
        status: parsed.status?.toString(),
        releaseStartTime: Number(parsed.release_start_time),
        releaseEndTime: Number(parsed.release_end_time),
        isActive: Boolean(parsed.is_active)
      };
    } catch (error) {
      console.error('Error parsing lien state:', error);
      throw new Error('Failed to parse lien state from contract result');
    }
  }

  _parseNumberFromScVal(scVal) {
    // Parse a number from Stellar contract value
    try {
      return Number(scVal.value());
    } catch (error) {
      console.error('Error parsing number from ScVal:', error);
      throw new Error('Failed to parse number from contract result');
    }
  }

  /**
   * Validate that a contract address is valid and exists
   * 
   * @param {string} contractAddress - Contract address to validate
   * @returns {Promise<boolean>} Whether the contract is valid
   */
  async validateContractAddress(contractAddress) {
    try {
      // Try to load the contract account
      const account = await this.server.loadAccount(contractAddress);
      
      // Check if it's a contract account (contracts typically have specific flags)
      return account && account.account_id === contractAddress;
    } catch (error) {
      console.error('Contract address validation failed:', error);
      return false;
    }
  }

  /**
   * Get the contract's current ledger sequence for synchronization
   * 
   * @returns {Promise<number>} Current ledger sequence
   */
  async getCurrentLedgerSequence() {
    try {
      const latestLedger = await this.server.ledgers().limit(1).order('desc').call();
      return latestLedger.records[0].sequence;
    } catch (error) {
      console.error('Error getting current ledger sequence:', error);
      throw error;
    }
  }
}

module.exports = new FutureLienContractService();
