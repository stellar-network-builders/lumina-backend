const logger = require('../utils/logger');
const { AdminAuditLog } = require('../models');

class AuditService {
  /**
   * Log an administrative action
   * @param {Object} params - Audit log parameters
   * @param {string} params.adminPubkey - Admin public key
   * @param {string} params.action - Action type (e.g., 'CREATE_VESTING_SCHEDULE')
   * @param {string} params.ipAddress - Requesting IP address
   * @param {Object} params.payload - Data submitted
   * @param {string} [params.resourceId] - ID of affected resource
   */
  static async logAction({ adminPubkey, action, ipAddress, payload, resourceId }) {
    try {
      await AdminAuditLog.create({
        admin_pubkey: adminPubkey,
        action,
        ip_address: ipAddress,
        payload,
        resource_id: resourceId,
        timestamp: new Date()
      });
      logger.info(`[AuditLog] ${action} by ${adminPubkey} logged successfully.`);
    } catch (error) {
      logger.error(`[AuditLog] Failed to log action ${action}:`, error);
      // We don't want to fail the main action if audit logging fails, 
      // but in a production security context, we might want to throw or alert.
    }
  }

  // Pre-defined action constants
  static ACTIONS = {
    CREATE_VESTING_SCHEDULE: 'CREATE_VESTING_SCHEDULE',
    REVOKE_GRANT: 'REVOKE_GRANT',
    APPROVE_KYC: 'APPROVE_KYC',
    REJECT_KYC: 'REJECT_KYC',
    UPDATE_VAULT_CONFIG: 'UPDATE_VAULT_CONFIG',
    MANUAL_VESTING_TRIGGER: 'MANUAL_VESTING_TRIGGER'
  };
}

module.exports = AuditService;
