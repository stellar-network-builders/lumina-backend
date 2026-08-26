const logger = require('../utils/logger');
const auditLogger = require('./auditLogger');
const vestingService = require('./vestingService');

class AdminService {
  constructor() {
    // In-memory storage for pending admin transfers
    // In production, this should be stored in a database
    this.pendingTransfers = new Map();
  }
  async revokeAccess(adminAddress, targetVault, reason = '') {
    try {
      // Validate admin address (in real implementation, this would check against admin list)
      if (!this.isValidAddress(adminAddress)) {
        throw new Error('Invalid admin address');
      }

      // Validate target vault
      if (!this.isValidAddress(targetVault)) {
        throw new Error('Invalid target vault address');
      }

      // Perform revoke action (placeholder for actual implementation)
      logger.info(`Revoking access to vault ${targetVault} by admin ${adminAddress}. Reason: ${reason}`);

      // Log the action for audit
      auditLogger.logAction(adminAddress, 'REVOKE', targetVault);

      return {
        success: true,
        message: 'Access revoked successfully',
        adminAddress,
        targetVault,
        action: 'REVOKE',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Error in revokeAccess:', error);
      throw error;
    }
  }

  async createVault(adminAddress, targetVault, vaultConfig = {}) {
    try {
      const {
        ownerAddress,
        tokenAddress,
        totalAmount,
        startDate,
        endDate,
        cliffDate = null,
        tokenType = 'static' // Default to 'static' for backward compatibility
      } = vaultConfig;

      return await vestingService.createVault(
        adminAddress,
        targetVault,
        ownerAddress,
        tokenAddress,
        totalAmount,
        startDate,
        endDate,
        cliffDate,
        tokenType // Pass tokenType to vestingService
      );
    } catch (error) {
      logger.error('Error in createVault:', error);
      throw error;
    }
  }

  async transferVault(adminAddress, targetVault, newOwner) {
    try {
      // Validate admin address
      if (!this.isValidAddress(adminAddress)) {
        throw new Error('Invalid admin address');
      }

      // Validate target vault and new owner
      if (!this.isValidAddress(targetVault) || !this.isValidAddress(newOwner)) {
        throw new Error('Invalid target vault or new owner address');
      }

      // Perform transfer action (placeholder for actual implementation)
      logger.info(`Transferring vault ${targetVault} to ${newOwner} by admin ${adminAddress}`);

      // Log the action for audit
      auditLogger.logAction(adminAddress, 'TRANSFER', targetVault);

      return {
        success: true,
        message: 'Vault transferred successfully',
        adminAddress,
        targetVault,
        action: 'TRANSFER',
        newOwner,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Error in transferVault:', error);
      throw error;
    }
  }

  async topUpVault(adminAddress, vaultAddress, topUpConfig) {
    try {
      const {
        topUpAmount,
        transactionHash,
        cliffDuration = null,
        vestingDuration
      } = topUpConfig;

      return await vestingService.topUpVault(
        adminAddress,
        vaultAddress,
        topUpAmount,
        transactionHash,
        cliffDuration,
        vestingDuration
      );
    } catch (error) {
      logger.error('Error in topUpVault:', error);
      throw error;
    }
  }

  async getVaultDetails(vaultAddress) {
    try {
      return await vestingService.getVaultWithSubSchedules(vaultAddress);
    } catch (error) {
      logger.error('Error in getVaultDetails:', error);
      throw error;
    }
  }

  async calculateReleasableAmount(vaultAddress, asOfDate) {
    try {
      return await vestingService.calculateReleasableAmount(vaultAddress, asOfDate);
    } catch (error) {
      logger.error('Error in calculateReleasableAmount:', error);
      throw error;
    }
  }

  async releaseTokens(adminAddress, vaultAddress, releaseAmount, userAddress) {
    try {
      return await vestingService.releaseTokens(adminAddress, vaultAddress, releaseAmount, userAddress);
    } catch (error) {
      logger.error('Error in releaseTokens:', error);
      throw error;
    }
  }

  async proposeNewAdmin(currentAdminAddress, newAdminAddress, contractAddress = null) {
    try {
      // Validate current admin address
      if (!this.isValidAddress(currentAdminAddress)) {
        throw new Error('Invalid current admin address');
      }

      // Validate new admin address
      if (!this.isValidAddress(newAdminAddress)) {
        throw new Error('Invalid new admin address');
      }

      // Check if new admin is different from current
      if (currentAdminAddress.toLowerCase() === newAdminAddress.toLowerCase()) {
        throw new Error('New admin address must be different from current admin');
      }

      // Create pending transfer record
      const transferId = `${contractAddress || 'global'}_${Date.now()}`;
      const pendingTransfer = {
        id: transferId,
        contractAddress,
        currentAdmin: currentAdminAddress,
        proposedAdmin: newAdminAddress,
        proposedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
        status: 'pending'
      };

      // Store pending transfer
      this.pendingTransfers.set(transferId, pendingTransfer);

      // Log the proposal for audit
      auditLogger.logAction(currentAdminAddress, 'PROPOSE_ADMIN', contractAddress || 'system', {
        proposedAdmin: newAdminAddress,
        transferId
      });

      logger.info(`Admin transfer proposed: ${currentAdminAddress} -> ${newAdminAddress} for contract ${contractAddress || 'global'}`);

      return {
        success: true,
        message: 'Admin transfer proposed successfully',
        transferId,
        contractAddress,
        currentAdmin: currentAdminAddress,
        proposedAdmin: newAdminAddress,
        proposedAt: pendingTransfer.proposedAt,
        expiresAt: pendingTransfer.expiresAt
      };
    } catch (error) {
      logger.error('Error in proposeNewAdmin:', error);
      throw error;
    }
  }

  async acceptOwnership(newAdminAddress, transferId) {
    try {
      // Validate new admin address
      if (!this.isValidAddress(newAdminAddress)) {
        throw new Error('Invalid new admin address');
      }

      // Check if pending transfer exists
      const pendingTransfer = this.pendingTransfers.get(transferId);
      if (!pendingTransfer) {
        throw new Error('Pending transfer not found or expired');
      }

      // Verify the new admin address matches the proposed admin
      if (pendingTransfer.proposedAdmin.toLowerCase() !== newAdminAddress.toLowerCase()) {
        throw new Error('New admin address does not match the proposed admin');
      }

      // Check if transfer has expired
      if (new Date() > new Date(pendingTransfer.expiresAt)) {
        this.pendingTransfers.delete(transferId);
        throw new Error('Transfer proposal has expired');
      }

      // Update transfer status
      pendingTransfer.status = 'completed';
      pendingTransfer.acceptedAt = new Date().toISOString();
      pendingTransfer.acceptedBy = newAdminAddress;

      // Remove from pending transfers
      this.pendingTransfers.delete(transferId);

      // Log the acceptance for audit
      auditLogger.logAction(newAdminAddress, 'ACCEPT_ADMIN', pendingTransfer.contractAddress || 'system', {
        previousAdmin: pendingTransfer.currentAdmin,
        transferId
      });

      logger.info(`Admin transfer accepted: ${pendingTransfer.currentAdmin} -> ${newAdminAddress} for contract ${pendingTransfer.contractAddress || 'global'}`);

      return {
        success: true,
        message: 'Admin ownership transferred successfully',
        transferId,
        contractAddress: pendingTransfer.contractAddress,
        previousAdmin: pendingTransfer.currentAdmin,
        newAdmin: newAdminAddress,
        proposedAt: pendingTransfer.proposedAt,
        acceptedAt: pendingTransfer.acceptedAt
      };
    } catch (error) {
      logger.error('Error in acceptOwnership:', error);
      throw error;
    }
  }

  async transferOwnership(currentAdminAddress, newAdminAddress, contractAddress = null) {
    try {
      // Validate current admin address
      if (!this.isValidAddress(currentAdminAddress)) {
        throw new Error('Invalid current admin address');
      }

      // Validate new admin address
      if (!this.isValidAddress(newAdminAddress)) {
        throw new Error('Invalid new admin address');
      }

      // Check if new admin is different from current
      if (currentAdminAddress.toLowerCase() === newAdminAddress.toLowerCase()) {
        throw new Error('New admin address must be different from current admin');
      }

      // Perform immediate transfer (backward compatibility)
      const transferId = `${contractAddress || 'global'}_${Date.now()}`;

      // Log the transfer for audit
      auditLogger.logAction(currentAdminAddress, 'TRANSFER_OWNERSHIP', contractAddress || 'system', {
        newAdmin: newAdminAddress,
        transferId
      });

      logger.info(`Admin ownership transferred immediately: ${currentAdminAddress} -> ${newAdminAddress} for contract ${contractAddress || 'global'}`);

      return {
        success: true,
        message: 'Admin ownership transferred successfully',
        transferId,
        contractAddress,
        previousAdmin: currentAdminAddress,
        newAdmin: newAdminAddress,
        timestamp: new Date().toISOString(),
        method: 'immediate'
      };
    } catch (error) {
      logger.error('Error in transferOwnership:', error);
      throw error;
    }
  }

  getPendingTransfers(contractAddress = null) {
    try {
      const transfers = Array.from(this.pendingTransfers.values());
      
      const filteredTransfers = contractAddress 
        ? transfers.filter(t => t.contractAddress === contractAddress)
        : transfers;

      return {
        success: true,
        pendingTransfers: filteredTransfers,
        total: filteredTransfers.length
      };
    } catch (error) {
      logger.error('Error getting pending transfers:', error);
      throw error;
    }
  }

  getAuditLogs(limit = 100) {
    try {
      const logs = auditLogger.getLogEntries();
      return {
        success: true,
        logs: logs.slice(0, limit),
        total: logs.length
      };
    } catch (error) {
      logger.error('Error getting audit logs:', error);
      throw error;
    }
  }

  // Helper function to validate Ethereum addresses
  isValidAddress(address) {
    return typeof address === 'string' && 
           address.startsWith('0x') && 
           address.length === 42 &&
           /^[0-9a-fA-F]+$/.test(address.slice(2));
  }
}

module.exports = new AdminService();
