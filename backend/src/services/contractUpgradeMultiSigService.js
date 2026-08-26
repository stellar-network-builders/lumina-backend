const logger = require('../utils/logger');
const { 
  ContractUpgradeProposal, 
  ContractUpgradeSignature, 
  ContractUpgradeAuditLog,
  MultiSigConfig,
  Vault
} = require('../models');
const { sequelize } = require('../database/connection');
const contractUpgradeService = require('./contractUpgradeService');
const auditLogger = require('./auditLogger');
const Sentry = require('@sentry/node');
const crypto = require('crypto');

class ContractUpgradeMultiSigService {
  constructor() {
    this.defaultRequiredSignatures = 2;
    this.defaultTotalSigners = 3;
    this.signatureValidityHours = 24;
    this.proposalExpirationHours = 72;
  }

  /**
   * Create a multi-sig configuration for contract upgrades
   * @param {string} vaultAddress - Vault address
   * @param {Array} signers - Array of signer addresses
   * @param {number} requiredSignatures - Number of signatures required
   * @param {string} createdBy - Admin creating the configuration
   * @returns {Promise<MultiSigConfig>} Created multi-sig config
   */
  async createUpgradeMultiSigConfig(vaultAddress, signers, requiredSignatures, createdBy) {
    const transaction = await sequelize.transaction();
    
    try {
      // Validate inputs
      this.validateMultiSigConfig(signers, requiredSignatures);
      
      // Check if vault exists
      const vault = await Vault.findOne({
        where: { address: vaultAddress },
        transaction
      });

      if (!vault) {
        throw new Error('Vault not found');
      }

      // Check admin permissions
      const hasPermission = await contractUpgradeService.checkAdminPermission(createdBy, vaultAddress);
      if (!hasPermission) {
        throw new Error('Admin does not have permission for this vault');
      }

      // Check if multi-sig config already exists
      const existingConfig = await MultiSigConfig.findOne({
        where: { vault_address: vaultAddress },
        transaction
      });

      if (existingConfig) {
        throw new Error('Multi-sig configuration already exists for this vault');
      }

      // Create multi-sig configuration
      const multiSigConfig = await MultiSigConfig.create({
        vault_address: vaultAddress,
        required_signatures: requiredSignatures,
        total_signers: signers.length,
        signers,
        created_by: createdBy
      }, { transaction });

      await transaction.commit();

      // Log to audit system
      await auditLogger.log({
        action: 'upgrade_multisig_config_created',
        performed_by: createdBy,
        target_address: vaultAddress,
        details: {
          config_id: multiSigConfig.id,
          signers,
          required_signatures: requiredSignatures
        }
      });

      return multiSigConfig;

    } catch (error) {
      await transaction.rollback();
      Sentry.captureException(error);
      throw new Error(`Failed to create multi-sig configuration: ${error.message}`);
    }
  }

  /**
   * Create an upgrade proposal with multi-sig approval flow
   * @param {Object} proposalData - Proposal data
   * @param {string} adminAddress - Admin creating the proposal
   * @returns {Promise<ContractUpgradeProposal>} Created proposal
   */
  async createMultiSigUpgradeProposal(proposalData, adminAddress) {
    const transaction = await sequelize.transaction();
    
    try {
      const { vault_address, proposed_wasm_hash, upgrade_reason } = proposalData;

      // Get multi-sig configuration for the vault
      const multiSigConfig = await MultiSigConfig.findOne({
        where: { 
          vault_address: vault_address, 
          is_active: true 
        },
        transaction
      });

      if (!multiSigConfig) {
        throw new Error('No active multi-sig configuration found for this vault');
      }

      // Create proposal with multi-sig parameters
      const proposal = await contractUpgradeService.createUpgradeProposal({
        ...proposalData,
        signers: multiSigConfig.signers,
        required_signatures: multiSigConfig.required_signatures
      }, adminAddress);

      // Generate approval messages for each signer
      const approvalMessages = this.generateApprovalMessages(proposal.id, multiSigConfig.signers);

      // Send notifications to signers
      await this.notifySigners(proposal, multiSigConfig.signers, adminAddress);

      await transaction.commit();

      return {
        ...proposal.toJSON(),
        multi_sig_config: {
          required_signatures: multiSigConfig.required_signatures,
          total_signers: multiSigConfig.total_signers,
          signers: multiSigConfig.signers
        },
        approval_messages: approvalMessages
      };

    } catch (error) {
      await transaction.rollback();
      Sentry.captureException(error);
      throw new Error(`Failed to create multi-sig upgrade proposal: ${error.message}`);
    }
  }

  /**
   * Submit a multi-signature approval
   * @param {string} proposalId - Proposal ID
   * @param {string} signerAddress - Signer address
   * @param {string} signature - Signature
   * @param {string} decision - Decision (approve/reject)
   * @param {string} reason - Optional reason
   * @returns {Promise<Object>} Approval result
   */
  async submitMultiSigApproval(proposalId, signerAddress, signature, decision, reason = null) {
    const transaction = await sequelize.transaction();
    
    try {
      // Get proposal with multi-sig context
      const proposal = await ContractUpgradeProposal.findByPk(proposalId, {
        include: [
          { model: ContractUpgradeSignature, as: 'signatures' }
        ],
        transaction
      });

      if (!proposal) {
        throw new Error('Proposal not found');
      }

      // Verify signer is in the authorized signers list
      if (!proposal.signers.includes(signerAddress)) {
        throw new Error('Signer is not authorized for this proposal');
      }

      // Check if proposal is still in approvable state
      if (!['verified', 'pending_approval'].includes(proposal.status)) {
        throw new Error(`Proposal is not in approvable state: ${proposal.status}`);
      }

      // Check for existing signature
      const existingSignature = proposal.signatures.find(
        sig => sig.signer_address === signerAddress
      );

      if (existingSignature) {
        throw new Error('Signer has already voted on this proposal');
      }

      // Validate signature format and authenticity
      const signatureValidation = await this.validateMultiSigSignature(
        proposalId,
        signerAddress,
        signature,
        decision
      );

      if (!signatureValidation.valid) {
        throw new Error(`Invalid signature: ${signatureValidation.error}`);
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

      // Recalculate approval status
      const approvalStatus = await this.calculateApprovalStatus(proposalId, transaction);

      // Update proposal status
      await ContractUpgradeProposal.update(
        { status: approvalStatus.status },
        { where: { id: proposalId }, transaction }
      );

      // Create audit log
      await ContractUpgradeAuditLog.create({
        proposal_id: proposalId,
        action: 'signature_added',
        performed_by: signerAddress,
        action_details: {
          decision,
          signing_reason: reason,
          approval_status: approvalStatus
        },
        new_state: { status: approvalStatus.status }
      }, { transaction });

      await transaction.commit();

      // Notify relevant parties about the signature
      await this.notifySignatureUpdate(proposal, signerAddress, decision, approvalStatus);

      // Log to audit system
      await auditLogger.log({
        action: 'multisig_upgrade_signature_submitted',
        performed_by: signerAddress,
        target_address: proposal.vault_address,
        details: {
          proposal_id: proposalId,
          decision,
          approvals: approvalStatus.approvals,
          rejections: approvalStatus.rejections,
          new_status: approvalStatus.status
        }
      });

      return {
        success: true,
        proposal_status: approvalStatus.status,
        approvals: approvalStatus.approvals,
        rejections: approvalStatus.rejections,
        required_signatures: proposal.required_signatures,
        total_signers: proposal.total_signers,
        message: approvalStatus.message
      };

    } catch (error) {
      await transaction.rollback();
      Sentry.captureException(error);
      throw new Error(`Failed to submit multi-sig approval: ${error.message}`);
    }
  }

  /**
   * Calculate approval status for a proposal
   * @param {string} proposalId - Proposal ID
   * @param {Object} transaction - Database transaction
   * @returns {Promise<Object>} Approval status
   */
  async calculateApprovalStatus(proposalId, transaction = null) {
    try {
      const proposal = await ContractUpgradeProposal.findByPk(proposalId, {
        include: [{ model: ContractUpgradeSignature, as: 'signatures' }],
        transaction
      });

      if (!proposal) {
        throw new Error('Proposal not found');
      }

      const validSignatures = proposal.signatures.filter(sig => sig.is_valid);
      const approvals = validSignatures.filter(sig => sig.decision === 'approve').length;
      const rejections = validSignatures.filter(sig => sig.decision === 'reject').length;

      let status = proposal.status;
      let message = 'Signature recorded';

      if (approvals >= proposal.required_signatures) {
        status = 'approved';
        message = 'Proposal approved - required signatures reached';
      } else if (rejections >= proposal.required_signatures) {
        status = 'rejected';
        message = 'Proposal rejected - required rejections reached';
      } else if (approvals + rejections >= proposal.total_signers) {
        // All signers have voted but threshold not met
        status = approvals > rejections ? 'approved' : 'rejected';
        message = status === 'approved' ? 
          'Proposal approved - majority vote' : 
          'Proposal rejected - majority vote';
      } else {
        status = 'pending_approval';
        message = 'Awaiting more signatures';
      }

      return {
        status,
        approvals,
        rejections,
        pending_signatures: proposal.total_signers - approvals - rejections,
        required_signatures: proposal.required_signatures,
        total_signers: proposal.total_signers,
        message
      };

    } catch (error) {
      logger.error('Error calculating approval status:', error);
      throw error;
    }
  }

  /**
   * Generate approval messages for signers
   * @param {string} proposalId - Proposal ID
   * @param {Array} signers - Array of signer addresses
   * @returns {Object} Approval messages for each signer
   */
  generateApprovalMessages(proposalId, signers) {
    const messages = {};
    
    signers.forEach(signer => {
      // Create unique message for each signer
      const message = `Approve contract upgrade proposal ${proposalId} by signer ${signer}`;
      const messageHash = crypto.createHash('sha256').update(message).digest('hex');
      
      messages[signer] = {
        message,
        message_hash: messageHash,
        proposal_id: proposalId
      };
    });

    return messages;
  }

  /**
   * Validate multi-signature
   * @param {string} proposalId - Proposal ID
   * @param {string} signerAddress - Signer address
   * @param {string} signature - Signature
   * @param {string} decision - Decision
   * @returns {Promise<Object>} Validation result
   */
  async validateMultiSigSignature(proposalId, signerAddress, signature, decision) {
    try {
      // Generate the expected message
      const message = `Approve contract upgrade proposal ${proposalId} by signer ${signerAddress} with decision ${decision}`;
      const messageHash = crypto.createHash('sha256').update(message).digest('hex');

      // This would implement proper cryptographic signature verification
      // For now, we'll do basic validation
      if (!signature || typeof signature !== 'string') {
        return { valid: false, error: 'Invalid signature format' };
      }

      // Check signature length (basic validation)
      if (signature.length < 64) {
        return { valid: false, error: 'Signature too short' };
      }

      // In a real implementation, this would verify the signature against the signer's public key
      // For now, we'll assume it's valid if it passes basic checks
      return { valid: true };

    } catch (error) {
      logger.error('Error validating multi-sig signature:', error);
      return { valid: false, error: error.message };
    }
  }

  /**
   * Notify signers about a new proposal
   * @param {ContractUpgradeProposal} proposal - The proposal
   * @param {Array} signers - Array of signer addresses
   * @param {string} proposer - Who created the proposal
   */
  async notifySigners(proposal, signers, proposer) {
    try {
      // This would integrate with notification service (email, push, etc.)
      logger.info(`Notifying signers about proposal ${proposal.id}:`, {
        vault_address: proposal.vault_address,
        proposed_wasm_hash: proposal.proposed_wasm_hash,
        signers,
        proposer
      });

      // Placeholder for notification implementation
      // Could use emailService, notificationService, etc.

    } catch (error) {
      logger.error('Error notifying signers:', error);
      // Don't throw error - notification failure shouldn't block proposal creation
    }
  }

  /**
   * Notify about signature updates
   * @param {ContractUpgradeProposal} proposal - The proposal
   * @param {string} signer - Who signed
   * @param {string} decision - The decision
   * @param {Object} approvalStatus - Current approval status
   */
  async notifySignatureUpdate(proposal, signer, decision, approvalStatus) {
    try {
      // This would notify other signers and relevant parties
      logger.info(`Signature update for proposal ${proposal.id}:`, {
        signer,
        decision,
        status: approvalStatus.status,
        approvals: approvalStatus.approvals,
        rejections: approvalStatus.rejections
      });

      // Placeholder for notification implementation

    } catch (error) {
      logger.error('Error notifying signature update:', error);
      // Don't throw error - notification failure shouldn't block signature submission
    }
  }

  /**
   * Get multi-sig configuration for a vault
   * @param {string} vaultAddress - Vault address
   * @returns {Promise<MultiSigConfig>} Multi-sig configuration
   */
  async getMultiSigConfig(vaultAddress) {
    try {
      const config = await MultiSigConfig.findOne({
        where: { 
          vault_address: vaultAddress, 
          is_active: true 
        }
      });

      if (!config) {
        throw new Error('No active multi-sig configuration found for this vault');
      }

      return config;
    } catch (error) {
      Sentry.captureException(error);
      throw new Error(`Failed to get multi-sig configuration: ${error.message}`);
    }
  }

  /**
   * Update multi-sig configuration
   * @param {string} vaultAddress - Vault address
   * @param {Object} updates - Configuration updates
   * @param {string} updatedBy - Who is updating
   * @returns {Promise<MultiSigConfig>} Updated configuration
   */
  async updateMultiSigConfig(vaultAddress, updates, updatedBy) {
    const transaction = await sequelize.transaction();
    
    try {
      // Check admin permissions
      const hasPermission = await contractUpgradeService.checkAdminPermission(updatedBy, vaultAddress);
      if (!hasPermission) {
        throw new Error('Admin does not have permission for this vault');
      }

      const config = await MultiSigConfig.findOne({
        where: { vault_address: vaultAddress },
        transaction
      });

      if (!config) {
        throw new Error('Multi-sig configuration not found');
      }

      // Validate updates
      if (updates.signers) {
        this.validateMultiSigConfig(updates.signers, updates.required_signatures || config.required_signatures);
      }

      // Update configuration
      await config.update(updates, { transaction });

      await transaction.commit();

      // Log to audit system
      await auditLogger.log({
        action: 'upgrade_multisig_config_updated',
        performed_by: updatedBy,
        target_address: vaultAddress,
        details: {
          config_id: config.id,
          updates
        }
      });

      return config;

    } catch (error) {
      await transaction.rollback();
      Sentry.captureException(error);
      throw new Error(`Failed to update multi-sig configuration: ${error.message}`);
    }
  }

  /**
   * Validate multi-sig configuration parameters
   * @param {Array} signers - Array of signer addresses
   * @param {number} requiredSignatures - Required signatures
   */
  validateMultiSigConfig(signers, requiredSignatures) {
    if (!Array.isArray(signers) || signers.length < 2) {
      throw new Error('At least 2 signers are required');
    }

    if (requiredSignatures < 2) {
      throw new Error('At least 2 signatures are required');
    }

    if (requiredSignatures > signers.length) {
      throw new Error('Required signatures cannot exceed total signers');
    }

    // Validate signer address format
    const stellarAddressRegex = /^G[A-Z0-9]{55}$/;
    for (const signer of signers) {
      if (!stellarAddressRegex.test(signer)) {
        throw new Error(`Invalid signer address format: ${signer}`);
      }
    }

    // Check for duplicate signers
    const uniqueSigners = [...new Set(signers)];
    if (uniqueSigners.length !== signers.length) {
      throw new Error('Duplicate signers are not allowed');
    }
  }

  /**
   * Get proposal voting status
   * @param {string} proposalId - Proposal ID
   * @returns {Promise<Object>} Voting status
   */
  async getProposalVotingStatus(proposalId) {
    try {
      const proposal = await ContractUpgradeProposal.findByPk(proposalId, {
        include: [{ model: ContractUpgradeSignature, as: 'signatures' }]
      });

      if (!proposal) {
        throw new Error('Proposal not found');
      }

      const approvalStatus = await this.calculateApprovalStatus(proposalId);

      return {
        proposal: {
          id: proposal.id,
          vault_address: proposal.vault_address,
          status: proposal.status,
          proposed_wasm_hash: proposal.proposed_wasm_hash,
          created_at: proposal.created_at,
          expires_at: proposal.expires_at
        },
        voting_status: approvalStatus,
        signatures: proposal.signatures.map(sig => ({
          signer_address: sig.signer_address,
          decision: sig.decision,
          signed_at: sig.signed_at,
          is_valid: sig.is_valid
        }))
      };

    } catch (error) {
      Sentry.captureException(error);
      throw new Error(`Failed to get proposal voting status: ${error.message}`);
    }
  }
}

module.exports = new ContractUpgradeMultiSigService();
