const logger = require('../utils/logger');
const { 
  ContractUpgradeProposal, 
  ContractUpgradeSignature, 
  ContractUpgradeAuditLog, 
  Vault, 
  MultiSigConfig,
  CertifiedBuild 
} = require('../models');
const { sequelize } = require('../database/connection');
const wasmHashVerificationService = require('./wasmHashVerificationService');
const auditLogger = require('./auditLogger');
const Sentry = require('@sentry/node');
const crypto = require('crypto');

class ContractUpgradeService {
  constructor() {
    this.proposalExpirationHours = 72; // 3 days
    this.signatureValidityHours = 24; // 1 day
    this.maxActiveProposals = 3; // Max active proposals per vault
  }

  /**
   * Create a new contract upgrade proposal
   * @param {Object} proposalData - Proposal data
   * @param {string} adminAddress - Admin creating the proposal
   * @returns {Promise<ContractUpgradeProposal>} Created proposal
   */
  async createUpgradeProposal(proposalData, adminAddress) {
    const transaction = await sequelize.transaction();
    
    try {
      const {
        vault_address,
        proposed_wasm_hash,
        upgrade_reason,
        signers,
        required_signatures = 2
      } = proposalData;

      // Validate inputs
      this.validateProposalData(proposalData);
      
      // Check if vault exists and is active
      const vault = await Vault.findOne({
        where: { address: vault_address, is_active: true },
        transaction
      });

      if (!vault) {
        throw new Error('Vault not found or inactive');
      }

      // Check admin permissions
      const hasPermission = await this.checkAdminPermission(adminAddress, vault_address);
      if (!hasPermission) {
        throw new Error('Admin does not have permission for this vault');
      }

      // Get current WASM hash from blockchain
      const currentWasmHash = await this.getCurrentWasmHash(vault_address);
      
      // Get immutable terms hash
      const immutableTermsHash = await this.calculateImmutableTermsHash(vault_address);

      // Check for existing active proposals
      const activeProposals = await ContractUpgradeProposal.count({
        where: {
          vault_address,
          status: ['proposed', 'pending_verification', 'verified', 'pending_approval']
        },
        transaction
      });

      if (activeProposals >= this.maxActiveProposals) {
        throw new Error(`Maximum active proposals (${this.maxActiveProposals}) reached for this vault`);
      }

      // Verify WASM hash
      const verificationResult = await wasmHashVerificationService.verifyWasmHash(
        proposed_wasm_hash,
        vault_address,
        adminAddress
      );

      if (!verificationResult.valid) {
        throw new Error(`WASM hash verification failed: ${verificationResult.error}`);
      }

      // Create proposal
      const proposal = await ContractUpgradeProposal.create({
        vault_address,
        current_wasm_hash: currentWasmHash,
        proposed_wasm_hash,
        upgrade_reason,
        certified_build_id: verificationResult.certified_build_id,
        proposed_by: adminAddress,
        status: 'verified', // Skip pending_verification since we already verified
        required_signatures,
        total_signers: signers.length,
        signers,
        immutable_terms_hash: immutableTermsHash,
        verification_result: verificationResult,
        expires_at: new Date(Date.now() + this.proposalExpirationHours * 60 * 60 * 1000)
      }, { transaction });

      // Create audit log entry
      await ContractUpgradeAuditLog.create({
        proposal_id: proposal.id,
        action: 'proposal_created',
        performed_by: adminAddress,
        action_details: {
          vault_address,
          proposed_wasm_hash,
          upgrade_reason,
          verification_result: verificationResult
        },
        new_state: { status: 'verified' }
      }, { transaction });

      await transaction.commit();

      // Log to audit system
      await auditLogger.log({
        action: 'contract_upgrade_proposal_created',
        performed_by: adminAddress,
        target_address: vault_address,
        details: {
          proposal_id: proposal.id,
          proposed_wasm_hash,
          upgrade_reason
        }
      });

      return proposal;

    } catch (error) {
      await transaction.rollback();
      Sentry.captureException(error);
      throw new Error(`Failed to create upgrade proposal: ${error.message}`);
    }
  }

  /**
   * Approve a contract upgrade proposal
   * @param {string} proposalId - Proposal ID
   * @param {string} signerAddress - Signer address
   * @param {string} signature - Signature
   * @param {string} decision - Decision (approve/reject)
   * @param {string} reason - Optional reason for decision
   * @returns {Promise<Object>} Approval result
   */
  async approveProposal(proposalId, signerAddress, signature, decision, reason = null) {
    const transaction = await sequelize.transaction();
    
    try {
      // Get proposal
      const proposal = await ContractUpgradeProposal.findByPk(proposalId, {
        include: [{ model: ContractUpgradeSignature, as: 'signatures' }],
        transaction
      });

      if (!proposal) {
        throw new Error('Proposal not found');
      }

      // Check if proposal is still active
      if (proposal.status !== 'verified' && proposal.status !== 'pending_approval') {
        throw new Error(`Proposal is not in approvable state: ${proposal.status}`);
      }

      // Check if proposal has expired
      if (proposal.expires_at && new Date() > proposal.expires_at) {
        throw new Error('Proposal has expired');
      }

      // Check if signer is authorized
      if (!proposal.signers.includes(signerAddress)) {
        throw new Error('Signer is not authorized for this proposal');
      }

      // Check if signer has already voted
      const existingSignature = proposal.signatures.find(
        sig => sig.signer_address === signerAddress
      );

      if (existingSignature) {
        throw new Error('Signer has already voted on this proposal');
      }

      // Validate signature
      const signatureValid = await this.validateSignature(
        proposalId,
        signerAddress,
        signature,
        decision
      );

      if (!signatureValid) {
        throw new Error('Invalid signature');
      }

      // Create signature record
      await ContractUpgradeSignature.create({
        proposal_id: proposalId,
        signer_address: signerAddress,
        signature,
        decision,
        signing_reason: reason,
        is_valid: true,
        expires_at: new Date(Date.now() + this.signatureValidityHours * 60 * 60 * 1000)
      }, { transaction });

      // Count approvals and rejections
      const approvals = proposal.signatures.filter(sig => sig.decision === 'approve' && sig.is_valid).length + (decision === 'approve' ? 1 : 0);
      const rejections = proposal.signatures.filter(sig => sig.decision === 'reject' && sig.is_valid).length + (decision === 'reject' ? 1 : 0);

      // Update proposal status based on votes
      let newStatus = proposal.status;
      let statusChangeReason = null;

      if (approvals >= proposal.required_signatures) {
        newStatus = 'approved';
        statusChangeReason = 'Required approvals reached';
      } else if (rejections >= proposal.required_signatures) {
        newStatus = 'rejected';
        statusChangeReason = 'Required rejections reached';
      } else if (approvals + rejections >= proposal.total_signers) {
        // All signers have voted but threshold not met
        newStatus = approvals > rejections ? 'approved' : 'rejected';
        statusChangeReason = 'All signers voted';
      } else {
        newStatus = 'pending_approval';
      }

      // Update proposal status
      await proposal.update({ status: newStatus }, { transaction });

      // Create audit log entry
      await ContractUpgradeAuditLog.create({
        proposal_id: proposalId,
        action: 'signature_added',
        performed_by: signerAddress,
        action_details: {
          decision,
          signing_reason: reason,
          approvals,
          rejections,
          required_signatures: proposal.required_signatures
        },
        new_state: { status: newStatus }
      }, { transaction });

      await transaction.commit();

      // Log to audit system
      await auditLogger.log({
        action: 'contract_upgrade_proposal_signed',
        performed_by: signerAddress,
        target_address: proposal.vault_address,
        details: {
          proposal_id: proposalId,
          decision,
          approvals,
          rejections,
          new_status: newStatus
        }
      });

      return {
        success: true,
        proposal_status: newStatus,
        approvals,
        rejections,
        required_signatures: proposal.required_signatures,
        message: statusChangeReason || 'Signature recorded successfully'
      };

    } catch (error) {
      await transaction.rollback();
      Sentry.captureException(error);
      throw new Error(`Failed to approve proposal: ${error.message}`);
    }
  }

  /**
   * Execute an approved contract upgrade
   * @param {string} proposalId - Proposal ID
   * @param {string} executorAddress - Executor address
   * @returns {Promise<Object>} Execution result
   */
  async executeUpgrade(proposalId, executorAddress) {
    const transaction = await sequelize.transaction();
    
    try {
      // Get proposal
      const proposal = await ContractUpgradeProposal.findByPk(proposalId, {
        include: [
          { model: ContractUpgradeSignature, as: 'signatures' },
          { model: Vault, as: 'vault' }
        ],
        transaction
      });

      if (!proposal) {
        throw new Error('Proposal not found');
      }

      // Check if proposal is approved
      if (proposal.status !== 'approved') {
        throw new Error(`Proposal is not approved: ${proposal.status}`);
      }

      // Check if proposal has expired
      if (proposal.expires_at && new Date() > proposal.expires_at) {
        throw new Error('Proposal has expired');
      }

      // Check executor permissions
      const hasPermission = await this.checkAdminPermission(executorAddress, proposal.vault_address);
      if (!hasPermission) {
        throw new Error('Executor does not have permission for this vault');
      }

      // Verify immutable terms one more time before execution
      const currentImmutableTermsHash = await this.calculateImmutableTermsHash(proposal.vault_address);
      if (currentImmutableTermsHash !== proposal.immutable_terms_hash) {
        throw new Error('Immutable terms have changed since proposal creation');
      }

      // Start execution
      await ContractUpgradeAuditLog.create({
        proposal_id: proposalId,
        action: 'execution_started',
        performed_by: executorAddress,
        action_details: {
          proposed_wasm_hash: proposal.proposed_wasm_hash,
          current_wasm_hash: proposal.current_wasm_hash
        }
      }, { transaction });

      // Execute the upgrade on blockchain
      const executionResult = await this.executeBlockchainUpgrade(
        proposal.vault_address,
        proposal.proposed_wasm_hash,
        executorAddress
      );

      if (!executionResult.success) {
        // Log execution failure
        await ContractUpgradeAuditLog.create({
          proposal_id: proposalId,
          action: 'execution_failed',
          performed_by: executorAddress,
          action_details: executionResult,
          error_message: executionResult.error
        }, { transaction });

        await proposal.update({ 
          status: 'failed',
          execution_tx_hash: executionResult.tx_hash
        }, { transaction });

        await transaction.commit();
        throw new Error(`Upgrade execution failed: ${executionResult.error}`);
      }

      // Update proposal status
      await proposal.update({
        status: 'executed',
        execution_tx_hash: executionResult.tx_hash,
        executed_at: new Date()
      }, { transaction });

      // Log successful execution
      await ContractUpgradeAuditLog.create({
        proposal_id: proposalId,
        action: 'execution_completed',
        performed_by: executorAddress,
        action_details: executionResult,
        transaction_hash: executionResult.tx_hash
      }, { transaction });

      await transaction.commit();

      // Log to audit system
      await auditLogger.log({
        action: 'contract_upgrade_executed',
        performed_by: executorAddress,
        target_address: proposal.vault_address,
        details: {
          proposal_id: proposalId,
          transaction_hash: executionResult.tx_hash,
          previous_wasm_hash: proposal.current_wasm_hash,
          new_wasm_hash: proposal.proposed_wasm_hash
        }
      });

      return {
        success: true,
        transaction_hash: executionResult.tx_hash,
        message: 'Contract upgrade executed successfully'
      };

    } catch (error) {
      await transaction.rollback();
      Sentry.captureException(error);
      throw new Error(`Failed to execute upgrade: ${error.message}`);
    }
  }

  /**
   * Get proposal details with signatures
   * @param {string} proposalId - Proposal ID
   * @returns {Promise<Object>} Proposal details
   */
  async getProposalDetails(proposalId) {
    try {
      const proposal = await ContractUpgradeProposal.findByPk(proposalId, {
        include: [
          { model: ContractUpgradeSignature, as: 'signatures' },
          { model: Vault, as: 'vault' },
          { model: ContractUpgradeAuditLog, as: 'auditLogs', order: [['created_at', 'DESC']] }
        ]
      });

      if (!proposal) {
        throw new Error('Proposal not found');
      }

      return proposal;
    } catch (error) {
      Sentry.captureException(error);
      throw new Error(`Failed to get proposal details: ${error.message}`);
    }
  }

  /**
   * Get all proposals for a vault
   * @param {string} vaultAddress - Vault address
   * @param {Object} filters - Optional filters
   * @returns {Promise<Array>} Array of proposals
   */
  async getVaultProposals(vaultAddress, filters = {}) {
    try {
      const whereClause = { vault_address: vaultAddress };
      
      if (filters.status) {
        whereClause.status = filters.status;
      }

      if (filters.date_from) {
        whereClause.created_at = { $gte: new Date(filters.date_from) };
      }

      if (filters.date_to) {
        whereClause.created_at = { ...whereClause.created_at, $lte: new Date(filters.date_to) };
      }

      const proposals = await ContractUpgradeProposal.findAll({
        where: whereClause,
        include: [
          { model: ContractUpgradeSignature, as: 'signatures' }
        ],
        order: [['created_at', 'DESC']]
      });

      return proposals;
    } catch (error) {
      Sentry.captureException(error);
      throw new Error(`Failed to get vault proposals: ${error.message}`);
    }
  }

  /**
   * Validate proposal data
   * @param {Object} proposalData - Proposal data to validate
   */
  validateProposalData(proposalData) {
    const required = ['vault_address', 'proposed_wasm_hash', 'upgrade_reason', 'signers'];
    
    for (const field of required) {
      if (!proposalData[field]) {
        throw new Error(`${field} is required`);
      }
    }

    if (!Array.isArray(proposalData.signers) || proposalData.signers.length < 2) {
      throw new Error('At least 2 signers are required');
    }

    if (proposalData.required_signatures && 
        proposalData.required_signatures > proposalData.signers.length) {
      throw new Error('Required signatures cannot exceed total signers');
    }
  }

  /**
   * Check admin permission for vault
   * @param {string} adminAddress - Admin address
   * @param {string} vaultAddress - Vault address
   * @returns {Promise<boolean>} Whether admin has permission
   */
  async checkAdminPermission(adminAddress, vaultAddress) {
    try {
      const vault = await Vault.findOne({
        where: { address: vaultAddress },
        include: [{ model: require('../models').Organization, as: 'organization' }]
      });

      if (!vault) {
        return false;
      }

      // Check if admin is vault owner
      if (vault.owner_address === adminAddress) {
        return true;
      }

      // Check if admin is organization admin
      if (vault.organization && vault.organization.admin_address === adminAddress) {
        return true;
      }

      // Check multi-sig configuration
      const multiSigConfig = await MultiSigConfig.findOne({
        where: { vault_address: vaultAddress, is_active: true }
      });

      if (multiSigConfig && multiSigConfig.signers.includes(adminAddress)) {
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Error checking admin permission:', error);
      return false;
    }
  }

  /**
   * Get current WASM hash from blockchain
   * @param {string} vaultAddress - Vault address
   * @returns {Promise<string>} Current WASM hash
   */
  async getCurrentWasmHash(vaultAddress) {
    try {
      // This would integrate with Stellar/Soroban to get current WASM hash
      // For now, return a placeholder
      return 'current_wasm_hash_placeholder';
    } catch (error) {
      logger.error('Error getting current WASM hash:', error);
      throw new Error('Failed to get current WASM hash');
    }
  }

  /**
   * Calculate immutable terms hash for vault
   * @param {string} vaultAddress - Vault address
   * @returns {Promise<string>} Immutable terms hash
   */
  async calculateImmutableTermsHash(vaultAddress) {
    try {
      const immutableTerms = await wasmHashVerificationService.getVaultImmutableTerms(vaultAddress);
      return wasmHashVerificationService.calculateImmutableTermsHash(immutableTerms);
    } catch (error) {
      logger.error('Error calculating immutable terms hash:', error);
      throw new Error('Failed to calculate immutable terms hash');
    }
  }

  /**
   * Validate signature for proposal approval
   * @param {string} proposalId - Proposal ID
   * @param {string} signerAddress - Signer address
   * @param {string} signature - Signature
   * @param {string} decision - Decision
   * @returns {Promise<boolean>} Whether signature is valid
   */
  async validateSignature(proposalId, signerAddress, signature, decision) {
    try {
      // This would implement proper signature verification
      // For now, return true as placeholder
      return true;
    } catch (error) {
      logger.error('Error validating signature:', error);
      return false;
    }
  }

  /**
   * Execute upgrade on blockchain
   * @param {string} vaultAddress - Vault address
   * @param {string} newWasmHash - New WASM hash
   * @param {string} executorAddress - Executor address
   * @returns {Promise<Object>} Execution result
   */
  async executeBlockchainUpgrade(vaultAddress, newWasmHash, executorAddress) {
    try {
      // This would integrate with Stellar/Soroban to execute the upgrade
      // For now, return a placeholder result
      return {
        success: true,
        tx_hash: 'upgrade_transaction_hash_placeholder',
        block_number: 12345,
        gas_used: '1000000'
      };
    } catch (error) {
      logger.error('Error executing blockchain upgrade:', error);
      return {
        success: false,
        error: error.message,
        tx_hash: null
      };
    }
  }
}

module.exports = new ContractUpgradeService();
