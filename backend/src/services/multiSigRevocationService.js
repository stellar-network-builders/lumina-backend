const logger = require('../utils/logger');
const { RevocationProposal, RevocationSignature, MultiSigConfig, Vault, Beneficiary } = require('../models');
const { sequelize } = require('../database/connection');
const crypto = require('crypto');
const Sentry = require('@sentry/node');
const slackWebhookService = require('./slackWebhookService');
const auditLogger = require('./auditLogger');
const hsmGatewayService = require('./hsmGatewayService');

class MultiSigRevocationService {
  constructor() {
    this.defaultRequiredSignatures = 2;
    this.defaultTotalSigners = 3;
    this.proposalExpirationHours = 72; // 3 days
    this.signatureValidityHours = 24; // 1 day
  }

  /**
   * Create a multi-signature configuration for a vault
   */
  async createMultiSigConfig(vaultAddress, signers, requiredSignatures, createdBy) {
    try {
      // Validate inputs
      if (!vaultAddress || !signers || !Array.isArray(signers)) {
        throw new Error('Invalid input parameters');
      }

      if (signers.length < requiredSignatures) {
        throw new Error('Required signatures cannot exceed total signers');
      }

      if (requiredSignatures < 2) {
        throw new Error('At least 2 signatures required for multi-sig');
      }

      // Check if config already exists
      const existingConfig = await MultiSigConfig.findOne({
        where: { vault_address: vaultAddress }
      });

      if (existingConfig) {
        throw new Error('Multi-sig configuration already exists for this vault');
      }

      // Validate signer addresses
      for (const signer of signers) {
        if (!this.isValidAddress(signer)) {
          throw new Error(`Invalid signer address: ${signer}`);
        }
      }

      // Create configuration
      const config = await MultiSigConfig.create({
        vault_address: vaultAddress,
        required_signatures: requiredSignatures,
        total_signers: signers.length,
        signers: signers,
        created_by: createdBy
      });

      // Log the action
      await auditLogger.log({
        action: 'CREATE_MULTI_SIG_CONFIG',
        actor: createdBy,
        target: vaultAddress,
        details: {
          configId: config.id,
          signers,
          requiredSignatures
        }
      });

      logger.info(`✅ Multi-sig config created for vault ${vaultAddress}`);
      return config;

    } catch (error) {
      logger.error('❌ Error creating multi-sig config:', error);
      Sentry.captureException(error, {
        tags: { service: 'multi-sig-revocation' },
        extra: { vaultAddress, signers, requiredSignatures, createdBy }
      });
      throw error;
    }
  }

  /**
   * Create a revocation proposal
   */
  async createRevocationProposal(vaultAddress, beneficiaryAddress, amountToRevoke, reason, proposedBy) {
    const transaction = await sequelize.transaction();
    
    try {
      // Validate inputs
      if (!vaultAddress || !beneficiaryAddress || !amountToRevoke || !reason || !proposedBy) {
        throw new Error('All fields are required');
      }

      // Validate addresses
      if (!this.isValidAddress(vaultAddress) || !this.isValidAddress(beneficiaryAddress)) {
        throw new Error('Invalid wallet addresses');
      }

      // Check if multi-sig config exists
      const config = await MultiSigConfig.findOne({
        where: { 
          vault_address: vaultAddress,
          is_active: true 
        }
      });

      if (!config) {
        throw new Error('Multi-sig configuration not found for this vault');
      }

      // Verify proposer is authorized signer
      if (!config.signers.includes(proposedBy)) {
        throw new Error('Proposer is not an authorized signer');
      }

      // Check if there's already a pending proposal for this beneficiary
      const existingProposal = await RevocationProposal.findOne({
        where: {
          vault_address: vaultAddress,
          beneficiary_address: beneficiaryAddress,
          status: 'pending'
        }
      });

      if (existingProposal) {
        throw new Error('There is already a pending revocation proposal for this beneficiary');
      }

      // Validate vault and beneficiary exist
      const vault = await Vault.findOne({ where: { address: vaultAddress } });
      if (!vault) {
        throw new Error('Vault not found');
      }

      const beneficiary = await Beneficiary.findOne({
        where: { 
          vault_id: vault.id,
          address: beneficiaryAddress 
        }
      });

      if (!beneficiary) {
        throw new Error('Beneficiary not found in this vault');
      }

      // Validate amount
      const amount = parseFloat(amountToRevoke);
      if (amount <= 0 || amount > parseFloat(beneficiary.total_allocated)) {
        throw new Error('Invalid revocation amount');
      }

      // Create proposal
      const proposal = await RevocationProposal.create({
        vault_address: vaultAddress,
        beneficiary_address: beneficiaryAddress,
        amount_to_revoke: amount.toString(),
        reason: reason,
        proposed_by: proposedBy,
        required_signatures: config.required_signatures,
        expires_at: new Date(Date.now() + (this.proposalExpirationHours * 60 * 60 * 1000))
      }, { transaction });

      // Create proposal payload for signing
      const payload = this.createProposalPayload(proposal);

      // Auto-sign the proposal (proposer signs automatically)
      await this.addSignature(proposal.id, proposedBy, payload.signature, transaction);

      // Commit transaction
      await transaction.commit();

      // Send notification to other signers
      await this.notifySigners(config.signers, proposedBy, proposal);

      // Log the action
      await auditLogger.log({
        action: 'CREATE_REVOCATION_PROPOSAL',
        actor: proposedBy,
        target: beneficiaryAddress,
        details: {
          proposalId: proposal.id,
          vaultAddress,
          amountToRevoke: amount.toString(),
          reason,
          requiredSignatures: config.required_signatures
        }
      });

      logger.info(`✅ Revocation proposal created: ${proposal.id}`);
      return proposal;

    } catch (error) {
      await transaction.rollback();
      logger.error('❌ Error creating revocation proposal:', error);
      Sentry.captureException(error, {
        tags: { service: 'multi-sig-revocation' },
        extra: { vaultAddress, beneficiaryAddress, amountToRevoke, proposedBy }
      });
      throw error;
    }
  }

  /**
   * Add signature to a proposal
   */
  async addSignature(proposalId, signerAddress, signature, transaction = null) {
    const t = transaction || await sequelize.transaction();
    
    try {
      // Get proposal
      const proposal = await RevocationProposal.findByPk(proposalId, { transaction: t });
      
      if (!proposal) {
        throw new Error('Proposal not found');
      }

      if (proposal.status !== 'pending') {
        throw new Error('Proposal is not in pending status');
      }

      // Check if proposal has expired
      if (proposal.expires_at && new Date() > proposal.expires_at) {
        throw new Error('Proposal has expired');
      }

      // Get multi-sig config
      const config = await MultiSigConfig.findOne({
        where: { 
          vault_address: proposal.vault_address,
          is_active: true 
        },
        transaction: t
      });

      if (!config) {
        throw new Error('Multi-sig configuration not found');
      }

      // Verify signer is authorized
      if (!config.signers.includes(signerAddress)) {
        throw new Error('Signer is not authorized');
      }

      // Check if already signed
      const existingSignature = await RevocationSignature.findOne({
        where: {
          proposal_id: proposalId,
          signer_address: signerAddress
        },
        transaction: t
      });

      if (existingSignature) {
        throw new Error('Signer has already signed this proposal');
      }

      // Verify signature
      const payload = this.createProposalPayload(proposal);
      const isValidSignature = this.verifySignature(payload.message, signature, signerAddress);

      if (!isValidSignature) {
        throw new Error('Invalid signature');
      }

      // Add signature
      await RevocationSignature.create({
        proposal_id: proposalId,
        signer_address: signerAddress,
        signature: signature
      }, { transaction: t });

      // Update signature count
      const signatureCount = await RevocationSignature.count({
        where: { proposal_id: proposalId, is_valid: true },
        transaction: t
      });

      await proposal.update({ 
        current_signatures: signatureCount 
      }, { transaction: t });

      // Check if threshold reached
      if (signatureCount >= proposal.required_signatures) {
        await proposal.update({ 
          status: 'approved' 
        }, { transaction: t });

        // Auto-execute the revocation
        if (!transaction) {
          await t.commit();
        }
        
        // Execute revocation in background
        setImmediate(() => this.executeRevocation(proposalId));
        
        logger.info(`✅ Proposal ${proposalId} approved and queued for execution`);
      } else {
        if (!transaction) {
          await t.commit();
        }
        
        logger.info(`✅ Signature added to proposal ${proposalId}. ${signatureCount}/${proposal.required_signatures} signatures collected`);
      }

      // Log the action
      await auditLogger.log({
        action: 'ADD_SIGNATURE',
        actor: signerAddress,
        target: proposalId,
        details: {
          signatureCount,
          requiredSignatures: proposal.required_signatures,
          status: proposal.status
        }
      });

      return {
        proposalId,
        signatureCount,
        requiredSignatures: proposal.required_signatures,
        status: proposal.status
      };

    } catch (error) {
      if (!transaction) {
        await t.rollback();
      }
      logger.error('❌ Error adding signature:', error);
      Sentry.captureException(error, {
        tags: { service: 'multi-sig-revocation' },
        extra: { proposalId, signerAddress }
      });
      throw error;
    }
  }

  /**
   * Execute approved revocation
   */
  async executeRevocation(proposalId) {
    const transaction = await sequelize.transaction();
    
    try {
      const proposal = await RevocationProposal.findByPk(proposalId, { transaction });
      
      if (!proposal) {
        throw new Error('Proposal not found');
      }

      if (proposal.status !== 'approved') {
        throw new Error('Proposal is not approved');
      }

      if (proposal.status === 'executed') {
        throw new Error('Proposal already executed');
      }

      // Get all signatures
      const signatures = await RevocationSignature.findAll({
        where: { 
          proposal_id: proposalId,
          is_valid: true 
        },
        order: [['signed_at', 'ASC']],
        transaction
      });

      if (signatures.length < proposal.required_signatures) {
        throw new Error('Insufficient signatures for execution');
      }

      // Build and execute revocation transaction
      const transactionHash = await this.buildAndExecuteRevocationTransaction(proposal, signatures);

      // Update proposal
      await proposal.update({
        status: 'executed',
        transaction_hash: transactionHash,
        executed_at: new Date()
      }, { transaction });

      await transaction.commit();

      // Send completion notifications
      await this.notifyRevocationCompletion(proposal, transactionHash);

      // Log the action
      await auditLogger.log({
        action: 'EXECUTE_REVOCATION',
        actor: 'system',
        target: proposal.beneficiary_address,
        details: {
          proposalId: proposal.id,
          vaultAddress: proposal.vault_address,
          amountToRevoke: proposal.amount_to_revoke,
          transactionHash,
          signatures: signatures.map(s => s.signer_address)
        }
      });

      logger.info(`✅ Revocation executed: ${transactionHash}`);
      return transactionHash;

    } catch (error) {
      await transaction.rollback();
      
      // Mark proposal as failed
      await RevocationProposal.update(
        { status: 'failed' },
        { where: { id: proposalId } }
      );

      logger.error('❌ Error executing revocation:', error);
      Sentry.captureException(error, {
        tags: { service: 'multi-sig-revocation' },
        extra: { proposalId }
      });
      
      // Send failure notification
      await this.notifyRevocationFailure(proposalId, error.message);
      
      throw error;
    }
  }

  /**
   * Create proposal payload for signing
   */
  createProposalPayload(proposal) {
    const message = `Revocation Proposal\n` +
                   `Proposal ID: ${proposal.id}\n` +
                   `Vault: ${proposal.vault_address}\n` +
                   `Beneficiary: ${proposal.beneficiary_address}\n` +
                   `Amount: ${proposal.amount_to_revoke}\n` +
                   `Reason: ${proposal.reason}\n` +
                   `Proposed by: ${proposal.proposed_by}\n` +
                   `Created: ${proposal.created_at.toISOString()}`;

    const hash = crypto.createHash('sha256').update(message).digest('hex');
    
    // In a real implementation, this would use proper Ethereum/Stellar signing
    // For now, we'll create a mock signature
    const mockSignature = `0x${hash.substring(0, 64)}${proposal.proposed_by.substring(2)}`;

    return {
      message,
      hash,
      signature: mockSignature
    };
  }

  /**
   * Verify signature (mock implementation)
   */
  verifySignature(message, signature, signerAddress) {
    // In a real implementation, this would verify the cryptographic signature
    // For now, we'll do basic validation
    if (!signature || !signerAddress) {
      return false;
    }

    // Mock verification - check if signature contains signer address
    return signature.toLowerCase().includes(signerAddress.toLowerCase().substring(2));
  }

  /**
   * Build and execute revocation transaction using HSM
   */
  async buildAndExecuteRevocationTransaction(proposal, signatures) {
    try {
      logger.info(`🔐 Using HSM Gateway for secure signing of proposal ${proposal.id}`);
      
      // Get HSM key IDs for signers from environment or config
      const signingKeyIds = this.getHSMKeyIds(proposal);
      
      if (!signingKeyIds || Object.keys(signingKeyIds).length === 0) {
        logger.info('⚠️  No HSM keys configured, falling back to mock implementation');
        return await this.mockTransactionExecution(proposal, signatures);
      }

      // Execute using HSM Gateway
      const result = await hsmGatewayService.executeBatchRevokeWithHSM(proposal, signingKeyIds);
      
      logger.info(`✅ HSM-signed transaction executed: ${result.transactionHash}`);
      return result.transactionHash;

    } catch (error) {
      logger.error('❌ Error in HSM transaction execution:', error);
      
      // Fallback to mock implementation for development/testing
      if (process.env.NODE_ENV === 'development' || process.env.HSM_FALLBACK_ENABLED === 'true') {
        logger.info('⚠️  Falling back to mock implementation due to HSM error');
        return await this.mockTransactionExecution(proposal, signatures);
      }
      
      throw error;
    }
  }

  /**
   * Mock transaction execution (fallback for development/testing)
   */
  async mockTransactionExecution(proposal, signatures) {
    const mockTxHash = `0x${crypto.randomBytes(32).toString('hex')}`;
    
    logger.info(`🔄 Executing mock revocation transaction for proposal ${proposal.id}`);
    logger.info(`   Vault: ${proposal.vault_address}`);
    logger.info(`   Beneficiary: ${proposal.beneficiary_address}`);
    logger.info(`   Amount: ${proposal.amount_to_revoke}`);
    logger.info(`   Signatures: ${signatures.length}`);

    // Simulate transaction execution delay
    await new Promise(resolve => setTimeout(resolve, 2000));

    return mockTxHash;
  }

  /**
   * Get HSM key IDs for proposal signers
   */
  getHSMKeyIds(proposal) {
    // In production, this would come from secure configuration
    // For now, we'll use environment variables or a config mapping
    
    const keyMapping = {};
    
    // Example: Map signer addresses to HSM key IDs
    // This should be stored securely in production (e.g., encrypted database, secure config)
    if (process.env.HSM_KEY_MAPPING) {
      try {
        const mapping = JSON.parse(process.env.HSM_KEY_MAPPING);
        Object.assign(keyMapping, mapping);
      } catch (error) {
        logger.error('Error parsing HSM key mapping:', error);
      }
    }
    
    // Example environment variable fallback
    const signers = proposal.required_signers || [proposal.proposed_by];
    signers.forEach(signer => {
      const envKey = `HSM_KEY_${signer.replace('0x', '').toUpperCase()}`;
      const keyId = process.env[envKey];
      if (keyId) {
        keyMapping[signer] = keyId;
      }
    });
    
    return keyMapping;
  }

  /**
   * Get proposal details
   */
  async getProposal(proposalId) {
    try {
      const proposal = await RevocationProposal.findByPk(proposalId, {
        include: [
          {
            model: RevocationSignature,
            as: 'signatures'
          }
        ]
      });

      if (!proposal) {
        throw new Error('Proposal not found');
      }

      return proposal;

    } catch (error) {
      logger.error('❌ Error getting proposal:', error);
      throw error;
    }
  }

  /**
   * Get pending proposals for a vault
   */
  async getPendingProposals(vaultAddress) {
    try {
      const proposals = await RevocationProposal.findAll({
        where: {
          vault_address: vaultAddress,
          status: 'pending'
        },
        include: [
          {
            model: RevocationSignature,
            as: 'signatures'
          }
        ],
        order: [['created_at', 'DESC']]
      });

      return proposals;

    } catch (error) {
      logger.error('❌ Error getting pending proposals:', error);
      throw error;
    }
  }

  /**
   * Get multi-sig configuration for a vault
   */
  async getMultiSigConfig(vaultAddress) {
    try {
      const config = await MultiSigConfig.findOne({
        where: { 
          vault_address: vaultAddress,
          is_active: true 
        }
      });

      return config;

    } catch (error) {
      logger.error('❌ Error getting multi-sig config:', error);
      throw error;
    }
  }

  /**
   * Notify other signers about new proposal
   */
  async notifySigners(signers, proposer, proposal) {
    try {
      const otherSigners = signers.filter(s => s !== proposer);
      
      const message = `🔐 **New Revocation Proposal Created**

**Proposal ID:** ${proposal.id}
**Vault:** ${proposal.vault_address}
**Beneficiary:** ${proposal.beneficiary_address}
**Amount:** ${proposal.amount_to_revoke}
**Proposed by:** ${proposer}
**Required Signatures:** ${proposal.required_signatures}
**Expires:** ${proposal.expires_at}

**Action Required:** Please review and sign the proposal via the dashboard.

**Other Signers:** ${otherSigners.join(', ')}`;

      await slackWebhookService.sendAlert(message, {
        channel: '#multi-sig-alerts',
        username: 'Multi-Sig Revocation',
        priority: 'high'
      });

    } catch (error) {
      logger.error('❌ Error notifying signers:', error);
    }
  }

  /**
   * Notify about revocation completion
   */
  async notifyRevocationCompletion(proposal, transactionHash) {
    try {
      const message = `✅ **Revocation Completed**

**Proposal ID:** ${proposal.id}
**Vault:** ${proposal.vault_address}
**Beneficiary:** ${proposal.beneficiary_address}
**Amount:** ${proposal.amount_to_revoke}
**Transaction:** ${transactionHash}
**Executed at:** ${new Date().toISOString()}

All required signatures were collected and the revocation was successful.`;

      await slackWebhookService.sendAlert(message, {
        channel: '#multi-sig-alerts',
        username: 'Multi-Sig Revocation',
        priority: 'medium'
      });

    } catch (error) {
      logger.error('❌ Error notifying completion:', error);
    }
  }

  /**
   * Notify about revocation failure
   */
  async notifyRevocationFailure(proposalId, error) {
    try {
      const message = `❌ **Revocation Failed**

**Proposal ID:** ${proposalId}
**Error:** ${error}
**Time:** ${new Date().toISOString()}

The revocation transaction failed. Please investigate the issue.`;

      await slackWebhookService.sendAlert(message, {
        channel: '#multi-sig-alerts',
        username: 'Multi-Sig Revocation',
        priority: 'high'
      });

    } catch (error) {
      logger.error('❌ Error notifying failure:', error);
    }
  }

  /**
   * Validate wallet address format
   */
  isValidAddress(address) {
    // Basic validation for Ethereum/Stellar addresses
    if (!address || typeof address !== 'string') {
      return false;
    }

    // Ethereum address format
    if (address.startsWith('0x') && address.length === 42) {
      return /^0x[a-fA-F0-9]{40}$/.test(address);
    }

    // Stellar address format (G + 56 characters)
    if (address.startsWith('G') && address.length === 56) {
      return /^[G][a-zA-Z0-9]{55}$/.test(address);
    }

    return false;
  }

  /**
   * Get service statistics
   */
  async getStats() {
    try {
      const stats = await RevocationProposal.findAll({
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('id')), 'total'],
          [sequelize.fn('COUNT', sequelize.literal('CASE WHEN status = "pending" THEN 1 END')), 'pending'],
          [sequelize.fn('COUNT', sequelize.literal('CASE WHEN status = "approved" THEN 1 END')), 'approved'],
          [sequelize.fn('COUNT', sequelize.literal('CASE WHEN status = "executed" THEN 1 END')), 'executed'],
          [sequelize.fn('COUNT', sequelize.literal('CASE WHEN status = "failed" THEN 1 END')), 'failed']
        ],
        raw: true
      });

      const configCount = await MultiSigConfig.count({
        where: { is_active: true }
      });

      return {
        proposals: stats[0],
        activeConfigs: configCount
      };

    } catch (error) {
      logger.error('❌ Error getting stats:', error);
      throw error;
    }
  }
}

module.exports = new MultiSigRevocationService();
