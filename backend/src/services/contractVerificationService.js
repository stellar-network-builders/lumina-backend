const logger = require('../utils/logger');
const crypto = require('crypto');
const ApprovedContractRegistry = require('../models/approvedContractRegistry');
const { sequelize } = require('../database/connection');

/**
 * ContractVerificationService
 * Handles verification of Soroban contract WASM hashes against approved registry
 * Protects users from impersonation scams and malicious contracts
 */
class ContractVerificationService {
  constructor() {
    this.verificationCache = new Map();
    this.cacheTimeoutMs = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Calculate SHA256 hash of a WASM file
   * @param {Buffer} wasmBuffer - WASM file buffer
   * @returns {string} SHA256 hash
   */
  calculateWasmHash(wasmBuffer) {
    return crypto.createHash('sha256').update(wasmBuffer).digest('hex');
  }

  /**
   * Verify if a contract is approved and safe to link
   * @param {Object} params - Verification parameters
   * @param {string} params.contractAddress - Contract address to verify
   * @param {string} params.wasmHash - WASM hash of the contract
   * @param {string} params.requesterAddress - Address requesting verification
   * @returns {Promise<Object>} Verification result
   */
  async verifyContract({ contractAddress, wasmHash, requesterAddress }) {
    try {
      // Check cache first
      const cacheKey = `${contractAddress}:${wasmHash}`;
      const cached = this.verificationCache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.cacheTimeoutMs) {
        return cached.result;
      }

      // Verify contract in registry
      const result = await ApprovedContractRegistry.verifyWasmHash(contractAddress, wasmHash);

      // Cache the result
      this.verificationCache.set(cacheKey, {
        result,
        timestamp: Date.now()
      });

      // Log verification attempt
      await this.logVerificationAttempt({
        contractAddress,
        wasmHash,
        requesterAddress,
        result
      });

      return result;
    } catch (error) {
      logger.error('Error verifying contract:', error);
      return {
        valid: false,
        error: 'Verification service error',
        details: error.message
      };
    }
  }

  /**
   * Add a new contract to the approved registry
   * @param {Object} params - Contract registration parameters
   * @param {string} params.contractAddress - Contract address
   * @param {string} params.wasmHash - WASM hash
   * @param {string} params.projectName - Project name
   * @param {string} params.version - Contract version
   * @param {string} params.auditorAddress - Auditor address
   * @param {string} params.auditReportUrl - URL to audit report
   * @param {Object} params.metadata - Additional metadata
   * @returns {Promise<Object>} Created registry entry
   */
  async registerContract({ 
    contractAddress, 
    wasmHash, 
    projectName, 
    version,
    auditorAddress,
    auditReportUrl,
    metadata 
  }) {
    const transaction = await sequelize.transaction();
    
    try {
      // Check if contract already exists
      const existing = await ApprovedContractRegistry.findOne({
        where: { contract_address: contractAddress },
        transaction
      });

      if (existing) {
        throw new Error('Contract already registered');
      }

      // Create registry entry
      const registry = await ApprovedContractRegistry.create({
        contract_address: contractAddress,
        wasm_hash: wasmHash,
        project_name: projectName,
        version: version,
        audit_status: 'approved',
        auditor_address: auditorAddress,
        audit_timestamp: new Date(),
        security_audit_report_url: auditReportUrl,
        metadata: metadata,
        is_active: true,
        is_blacklisted: false
      }, { transaction });

      await transaction.commit();

      // Clear cache for this contract
      this.clearCache(contractAddress);

      return registry;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  /**
   * Blacklist a malicious contract
   * @param {Object} params - Blacklist parameters
   * @param {string} params.contractAddress - Contract to blacklist
   * @param {string} params.reason - Reason for blacklisting
   * @param {string} params.blacklistedBy - Admin address
   */
  async blacklistContract({ contractAddress, reason, blacklistedBy }) {
    const success = await ApprovedContractRegistry.blacklistContract(
      contractAddress,
      reason,
      blacklistedBy
    );

    if (success) {
      // Clear cache
      this.clearCache(contractAddress);
      
      logger.info(`Contract ${contractAddress} has been blacklisted: ${reason}`);
    }

    return success;
  }

  /**
   * Get all approved contracts
   * @param {Object} filters - Query filters
   * @returns {Promise<Array>} List of approved contracts
   */
  async getApprovedContracts(filters = {}) {
    const where = {
      is_active: true,
      is_blacklisted: false,
      audit_status: 'approved'
    };

    if (filters.projectName) {
      where.project_name = { [require('sequelize').Op.iLike]: `%${filters.projectName}%` };
    }

    if (filters.version) {
      where.version = filters.version;
    }

    const contracts = await ApprovedContractRegistry.findAll({
      where,
      order: [['audit_timestamp', 'DESC']],
      attributes: {
        exclude: ['blacklist_reason', 'blacklisted_by']
      }
    });

    return contracts;
  }

  /**
   * Get contract details by address
   * @param {string} contractAddress - Contract address
   * @returns {Promise<Object|null>} Contract details
   */
  async getContractDetails(contractAddress) {
    const contract = await ApprovedContractRegistry.findOne({
      where: { contract_address: contractAddress },
      attributes: {
        exclude: ['blacklist_reason', 'blacklisted_by']
      }
    });

    return contract;
  }

  /**
   * Clear verification cache for a contract
   * @param {string} contractAddress - Contract address
   */
  clearCache(contractAddress) {
    for (const [key] of this.verificationCache.entries()) {
      if (key.startsWith(`${contractAddress}:`)) {
        this.verificationCache.delete(key);
      }
    }
  }

  /**
   * Log verification attempt for audit purposes
   * @param {Object} data - Verification data
   */
  async logVerificationAttempt({ contractAddress, wasmHash, requesterAddress, result }) {
    // This could be integrated with an audit logging service
    logger.info(`Contract verification: ${contractAddress} by ${requesterAddress} - ${result.valid ? 'APPROVED' : 'REJECTED'}`);
  }
}

module.exports = new ContractVerificationService();
