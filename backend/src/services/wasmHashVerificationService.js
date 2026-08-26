const logger = require('../utils/logger');
const crypto = require('crypto');
const { CertifiedBuild, ContractUpgradeProposal } = require('../models');
const Sentry = require('@sentry/node');
const auditLogger = require('./auditLogger');

class WasmHashVerificationService {
  constructor() {
    this.verificationTimeout = 30000; // 30 seconds
    this.maxRetries = 3;
    this.supportedHashAlgorithms = ['sha256', 'sha384', 'sha512'];
  }

  /**
   * Verify a WASM hash against certified builds
   * @param {string} wasmHash - The WASM hash to verify
   * @param {string} vaultAddress - The vault contract address
   * @param {string} adminAddress - The admin requesting verification
   * @returns {Promise<Object>} Verification result
   */
  async verifyWasmHash(wasmHash, vaultAddress, adminAddress) {
    try {
      // Validate input parameters
      this.validateWasmHash(wasmHash);
      this.validateAddress(vaultAddress);
      this.validateAddress(adminAddress);

      // Check if WASM hash exists in certified builds
      const certifiedBuild = await CertifiedBuild.findOne({
        where: {
          wasm_hash: wasmHash,
          is_active: true,
          security_audit_passed: true
        }
      });

      if (!certifiedBuild) {
        return {
          valid: false,
          error: 'WASM hash not found in certified builds or security audit not passed',
          certified_build_id: null,
          verification_details: {
            hash_checked: wasmHash,
            timestamp: new Date().toISOString(),
            checked_by: adminAddress
          }
        };
      }

      // Verify build compatibility
      const compatibilityCheck = await this.verifyBuildCompatibility(certifiedBuild, vaultAddress);
      
      if (!compatibilityCheck.compatible) {
        return {
          valid: false,
          error: `Build compatibility check failed: ${compatibilityCheck.reason}`,
          certified_build_id: certifiedBuild.build_id,
          verification_details: {
            hash_checked: wasmHash,
            certified_build_id: certifiedBuild.build_id,
            compatibility_check: compatibilityCheck,
            timestamp: new Date().toISOString(),
            checked_by: adminAddress
          }
        };
      }

      // Verify immutable terms preservation
      const immutableTermsCheck = await this.verifyImmutableTerms(certifiedBuild, vaultAddress);
      
      if (!immutableTermsCheck.preserved) {
        return {
          valid: false,
          error: `Immutable terms check failed: ${immutableTermsCheck.reason}`,
          certified_build_id: certifiedBuild.build_id,
          verification_details: {
            hash_checked: wasmHash,
            certified_build_id: certifiedBuild.build_id,
            immutable_terms_check: immutableTermsCheck,
            timestamp: new Date().toISOString(),
            checked_by: adminAddress
          }
        };
      }

      // Log successful verification
      await auditLogger.log({
        action: 'wasm_hash_verified',
        performed_by: adminAddress,
        target_address: vaultAddress,
        details: {
          wasm_hash: wasmHash,
          certified_build_id: certifiedBuild.build_id,
          verification_result: {
            valid: true,
            certified_build_id: certifiedBuild.build_id,
            verification_details: {
              hash_checked: wasmHash,
              certified_build_id: certifiedBuild.build_id,
              compatibility_check: compatibilityCheck,
              immutable_terms_check: immutableTermsCheck,
              timestamp: new Date().toISOString(),
              checked_by: adminAddress
            }
          }
        }
      });

      return {
        valid: true,
        certified_build_id: certifiedBuild.build_id,
        verification_details: {
          hash_checked: wasmHash,
          certified_build_id: certifiedBuild.build_id,
          compatibility_check: compatibilityCheck,
          immutable_terms_check: immutableTermsCheck,
          timestamp: new Date().toISOString(),
          checked_by: adminAddress
        }
      };

    } catch (error) {
      Sentry.captureException(error);
      logger.error('WASM hash verification failed:', error);
      
      return {
        valid: false,
        error: `Verification failed: ${error.message}`,
        certified_build_id: null,
        verification_details: {
          hash_checked: wasmHash,
          timestamp: new Date().toISOString(),
          checked_by: adminAddress,
          error: error.message
        }
      };
    }
  }

  /**
   * Verify build compatibility with existing vault
   * @param {CertifiedBuild} certifiedBuild - The certified build
   * @param {string} vaultAddress - The vault address
   * @returns {Promise<Object>} Compatibility check result
   */
  async verifyBuildCompatibility(certifiedBuild, vaultAddress) {
    try {
      // Get vault information
      const vault = await require('../models').Vault.findOne({
        where: { address: vaultAddress }
      });

      if (!vault) {
        return {
          compatible: false,
          reason: 'Vault not found'
        };
      }

      // Check version compatibility
      const currentVersion = await this.getCurrentVaultVersion(vaultAddress);
      if (!this.isVersionCompatible(currentVersion, certifiedBuild.version)) {
        return {
          compatible: false,
          reason: `Version incompatibility: current ${currentVersion}, proposed ${certifiedBuild.version}`
        };
      }

      // Check if build is for the correct contract type
      if (!certifiedBuild.build_metadata || certifiedBuild.build_metadata.contract_type !== 'vesting_vault') {
        return {
          compatible: false,
          reason: 'Build is not for vesting vault contract type'
        };
      }

      return {
        compatible: true,
        reason: 'All compatibility checks passed',
        current_version: currentVersion,
        proposed_version: certifiedBuild.version
      };

    } catch (error) {
      return {
        compatible: false,
        reason: `Compatibility check error: ${error.message}`
      };
    }
  }

  /**
   * Verify that immutable terms are preserved
   * @param {CertifiedBuild} certifiedBuild - The certified build
   * @param {string} vaultAddress - The vault address
   * @returns {Promise<Object>} Immutable terms check result
   */
  async verifyImmutableTerms(certifiedBuild, vaultAddress) {
    try {
      // Get vault's immutable terms
      const immutableTerms = await this.getVaultImmutableTerms(vaultAddress);
      
      if (!immutableTerms) {
        return {
          preserved: false,
          reason: 'Could not retrieve vault immutable terms'
        };
      }

      // Calculate hash of current immutable terms
      const currentTermsHash = this.calculateImmutableTermsHash(immutableTerms);
      
      // Check if certified build preserves immutable terms
      if (!certifiedBuild.immutable_terms_compatible) {
        return {
          preserved: false,
          reason: 'Certified build does not preserve immutable terms'
        };
      }

      // Verify that the build metadata contains the same immutable terms hash
      if (certifiedBuild.build_metadata && certifiedBuild.build_metadata.immutable_terms_hash) {
        if (certifiedBuild.build_metadata.immutable_terms_hash !== currentTermsHash) {
          return {
            preserved: false,
            reason: 'Immutable terms hash mismatch between vault and build'
          };
        }
      }

      return {
        preserved: true,
        reason: 'Immutable terms are preserved',
        current_terms_hash: currentTermsHash,
        build_terms_hash: certifiedBuild.build_metadata?.immutable_terms_hash
      };

    } catch (error) {
      return {
        preserved: false,
        reason: `Immutable terms check error: ${error.message}`
      };
    }
  }

  /**
   * Get current vault version from blockchain
   * @param {string} vaultAddress - The vault address
   * @returns {Promise<string>} Current version
   */
  async getCurrentVaultVersion(vaultAddress) {
    try {
      // This would integrate with Stellar/Soroban to get current contract version
      // For now, return a placeholder
      const { Vault } = require('../models');
      const vault = await Vault.findOne({ where: { address: vaultAddress } });
      
      // In a real implementation, this would query the blockchain
      return vault?.metadata?.version || '1.0.0';
    } catch (error) {
      logger.error('Error getting vault version:', error);
      return '1.0.0'; // Default fallback
    }
  }

  /**
   * Check if versions are compatible for upgrade
   * @param {string} currentVersion - Current version
   * @param {string} proposedVersion - Proposed version
   * @returns {boolean} Whether versions are compatible
   */
  isVersionCompatible(currentVersion, proposedVersion) {
    // Simple version comparison - can be enhanced with semantic versioning
    const current = currentVersion.split('.').map(Number);
    const proposed = proposedVersion.split('.').map(Number);
    
    // Major version must be the same, minor and patch can be higher
    if (current[0] !== proposed[0]) {
      return false;
    }
    
    if (proposed[1] < current[1]) {
      return false;
    }
    
    if (proposed[1] === current[1] && proposed[2] < current[2]) {
      return false;
    }
    
    return true;
  }

  /**
   * Get immutable terms from vault
   * @param {string} vaultAddress - The vault address
   * @returns {Promise<Object>} Immutable terms
   */
  async getVaultImmutableTerms(vaultAddress) {
    try {
      const { Vault, SubSchedule, Beneficiary } = require('../models');
      
      const vault = await Vault.findOne({
        where: { address: vaultAddress },
        include: [
          {
            model: SubSchedule,
            as: 'subSchedules',
            include: [{
              model: Beneficiary,
              as: 'beneficiaries'
            }]
          }
        ]
      });

      if (!vault) {
        return null;
      }

      // Extract immutable terms
      return {
        total_amount: vault.total_amount.toString(),
        token_address: vault.token_address,
        cliff_dates: vault.subSchedules.map(schedule => schedule.cliff_date),
        beneficiary_allocations: vault.subSchedules.map(schedule => ({
          beneficiary_address: schedule.beneficiary_address,
          allocation_amount: schedule.allocation_amount.toString()
        }))
      };
    } catch (error) {
      logger.error('Error getting vault immutable terms:', error);
      return null;
    }
  }

  /**
   * Calculate hash of immutable terms
   * @param {Object} immutableTerms - Immutable terms object
   * @returns {string} Hash of immutable terms
   */
  calculateImmutableTermsHash(immutableTerms) {
    const termsString = JSON.stringify(immutableTerms, Object.keys(immutableTerms).sort());
    return crypto.createHash('sha256').update(termsString).digest('hex');
  }

  /**
   * Validate WASM hash format
   * @param {string} wasmHash - The WASM hash to validate
   */
  validateWasmHash(wasmHash) {
    if (!wasmHash || typeof wasmHash !== 'string') {
      throw new Error('WASM hash is required and must be a string');
    }
    
    // Check if it's a valid hex string (64 characters for SHA-256)
    const hexRegex = /^[a-fA-F0-9]{64}$/;
    if (!hexRegex.test(wasmHash)) {
      throw new Error('WASM hash must be a valid 64-character hexadecimal string');
    }
  }

  /**
   * Validate Stellar address format
   * @param {string} address - The address to validate
   */
  validateAddress(address) {
    if (!address || typeof address !== 'string') {
      throw new Error('Address is required and must be a string');
    }
    
    // Basic Stellar address validation (starts with 'G' and 56 characters)
    const stellarAddressRegex = /^G[A-Z0-9]{55}$/;
    if (!stellarAddressRegex.test(address)) {
      throw new Error('Invalid Stellar address format');
    }
  }

  /**
   * Register a new certified build
   * @param {Object} buildData - Build data to register
   * @param {string} adminAddress - Admin registering the build
   * @returns {Promise<CertifiedBuild>} Created certified build
   */
  async registerCertifiedBuild(buildData, adminAddress) {
    try {
      const {
        build_id,
        wasm_hash,
        version,
        commit_hash,
        build_timestamp,
        verification_signature,
        build_metadata,
        audit_report_url
      } = buildData;

      // Validate required fields
      this.validateWasmHash(wasm_hash);
      
      if (!build_id || !version || !commit_hash || !verification_signature) {
        throw new Error('Missing required build fields');
      }

      // Check if build already exists
      const existingBuild = await CertifiedBuild.findOne({
        where: {
          $or: [
            { build_id },
            { wasm_hash }
          ]
        }
      });

      if (existingBuild) {
        throw new Error('Build with this ID or WASM hash already exists');
      }

      // Create certified build
      const certifiedBuild = await CertifiedBuild.create({
        build_id,
        wasm_hash,
        version,
        commit_hash,
        build_timestamp: new Date(build_timestamp),
        builder_address: adminAddress,
        verification_signature,
        build_metadata,
        audit_report_url,
        security_audit_passed: !!audit_report_url,
        immutable_terms_compatible: build_metadata?.immutable_terms_compatible || false,
        compatibility_version: build_metadata?.compatibility_version || version
      });

      // Log registration
      await auditLogger.log({
        action: 'certified_build_registered',
        performed_by: adminAddress,
        details: {
          build_id,
          wasm_hash,
          version
        }
      });

      return certifiedBuild;

    } catch (error) {
      Sentry.captureException(error);
      throw new Error(`Failed to register certified build: ${error.message}`);
    }
  }
}

module.exports = new WasmHashVerificationService();
