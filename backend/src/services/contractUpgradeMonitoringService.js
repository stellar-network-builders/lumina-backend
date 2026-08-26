const logger = require('../utils/logger');
const { 
  ContractUpgradeProposal, 
  ContractUpgradeAuditLog,
  ContractUpgradeSignature,
  CertifiedBuild
} = require('../models');
const { sequelize } = require('../database/connection');
const Sentry = require('@sentry/node');
const slackWebhookService = require('./slackWebhookService');
const auditLogger = require('./auditLogger');

class ContractUpgradeMonitoringService {
  constructor() {
    this.monitoringInterval = 5 * 60 * 1000; // 5 minutes
    this.alertThresholds = {
      proposalExpiration: 24 * 60 * 60 * 1000, // 24 hours before expiration
      signatureExpiration: 6 * 60 * 60 * 1000, // 6 hours before signature expiration
      failedUpgrades: 3, // Alert after 3 failed upgrades
      pendingProposals: 5 // Alert if more than 5 proposals pending
    };
  }

  /**
   * Start monitoring contract upgrade operations
   */
  startMonitoring() {
    logger.info('Starting contract upgrade monitoring service...');
    
    // Run monitoring immediately
    this.runMonitoring().catch(error => {
      logger.error('Error in initial monitoring run:', error);
      Sentry.captureException(error);
    });

    // Set up recurring monitoring
    this.monitoringTimer = setInterval(async () => {
      try {
        await this.runMonitoring();
      } catch (error) {
        logger.error('Error in monitoring cycle:', error);
        Sentry.captureException(error);
      }
    }, this.monitoringInterval);

    logger.info(`Contract upgrade monitoring started with ${this.monitoringInterval/1000}s interval`);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = null;
      logger.info('Contract upgrade monitoring stopped');
    }
  }

  /**
   * Run monitoring checks
   */
  async runMonitoring() {
    try {
      const timestamp = new Date();
      logger.info(`Running contract upgrade monitoring at ${timestamp.toISOString()}`);

      // Check for expiring proposals
      await this.checkExpiringProposals();

      // Check for expiring signatures
      await this.checkExpiringSignatures();

      // Check for failed upgrades
      await this.checkFailedUpgrades();

      // Check for stuck proposals
      await this.checkStuckProposals();

      // Check certified build health
      await this.checkCertifiedBuildHealth();

      // Generate monitoring report
      await this.generateMonitoringReport(timestamp);

    } catch (error) {
      logger.error('Error in monitoring run:', error);
      Sentry.captureException(error);
    }
  }

  /**
   * Check for proposals nearing expiration
   */
  async checkExpiringProposals() {
    try {
      const expirationThreshold = new Date(Date.now() + this.alertThresholds.proposalExpiration);
      
      const expiringProposals = await ContractUpgradeProposal.findAll({
        where: {
          status: ['proposed', 'pending_verification', 'verified', 'pending_approval'],
          expires_at: {
            $lte: expirationThreshold,
            $gt: new Date()
          }
        },
        include: [
          { model: ContractUpgradeSignature, as: 'signatures' }
        ]
      });

      for (const proposal of expiringProposals) {
        const hoursUntilExpiration = (proposal.expires_at - new Date()) / (1000 * 60 * 60);
        
        // Create audit log for monitoring alert
        await ContractUpgradeAuditLog.create({
          proposal_id: proposal.id,
          action: 'proposal_expiring_soon',
          performed_by: 'system_monitor',
          action_details: {
            hours_until_expiration: Math.round(hoursUntilExpiration * 10) / 10,
            current_status: proposal.status,
            approvals: proposal.signatures.filter(s => s.decision === 'approve').length,
            required_signatures: proposal.required_signatures
          }
        });

        // Send alert if proposal expires within 24 hours
        if (hoursUntilExpiration <= 24) {
          await this.sendExpirationAlert(proposal, hoursUntilExpiration);
        }
      }

      if (expiringProposals.length > 0) {
        logger.info(`Found ${expiringProposals.length} proposals expiring soon`);
      }

    } catch (error) {
      logger.error('Error checking expiring proposals:', error);
      Sentry.captureException(error);
    }
  }

  /**
   * Check for signatures nearing expiration
   */
  async checkExpiringSignatures() {
    try {
      const expirationThreshold = new Date(Date.now() + this.alertThresholds.signatureExpiration);
      
      const expiringSignatures = await ContractUpgradeSignature.findAll({
        where: {
          is_valid: true,
          expires_at: {
            $lte: expirationThreshold,
            $gt: new Date()
          }
        },
        include: [
          { 
            model: ContractUpgradeProposal, 
            as: 'proposal',
            where: {
              status: ['verified', 'pending_approval']
            }
          }
        ]
      });

      for (const signature of expiringSignatures) {
        const hoursUntilExpiration = (signature.expires_at - new Date()) / (1000 * 60 * 60);
        
        // Create audit log
        await ContractUpgradeAuditLog.create({
          proposal_id: signature.proposal_id,
          action: 'signature_expiring_soon',
          performed_by: 'system_monitor',
          action_details: {
            signer_address: signature.signer_address,
            decision: signature.decision,
            hours_until_expiration: Math.round(hoursUntilExpiration * 10) / 10
          }
        });

        // Send alert if signature expires within 6 hours
        if (hoursUntilExpiration <= 6) {
          await this.sendSignatureExpirationAlert(signature, hoursUntilExpiration);
        }
      }

      if (expiringSignatures.length > 0) {
        logger.info(`Found ${expiringSignatures.length} signatures expiring soon`);
      }

    } catch (error) {
      logger.error('Error checking expiring signatures:', error);
      Sentry.captureException(error);
    }
  }

  /**
   * Check for failed upgrade attempts
   */
  async checkFailedUpgrades() {
    try {
      const recentFailedUpgrades = await ContractUpgradeProposal.findAll({
        where: {
          status: 'failed',
          updated_at: {
            $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
          }
        },
        order: [['updated_at', 'DESC']]
      });

      if (recentFailedUpgrades.length >= this.alertThresholds.failedUpgrades) {
        await this.sendFailedUpgradeAlert(recentFailedUpgrades);
        
        // Create audit log
        await ContractUpgradeAuditLog.create({
          proposal_id: recentFailedUpgrades[0].id, // Use the most recent
          action: 'multiple_failed_upgrades_detected',
          performed_by: 'system_monitor',
          action_details: {
            failed_count: recentFailedUpgrades.length,
            time_period: '24 hours',
            failed_proposals: recentFailedUpgrades.map(p => ({
              id: p.id,
              vault_address: p.vault_address,
              failure_reason: p.verification_result?.error || 'Unknown'
            }))
          }
        });
      }

    } catch (error) {
      logger.error('Error checking failed upgrades:', error);
      Sentry.captureException(error);
    }
  }

  /**
   * Check for proposals stuck in pending state
   */
  async checkStuckProposals() {
    try {
      const stuckThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
      
      const stuckProposals = await ContractUpgradeProposal.findAll({
        where: {
          status: ['pending_verification', 'pending_approval'],
          created_at: {
            $lte: stuckThreshold
          }
        },
        include: [
          { model: ContractUpgradeSignature, as: 'signatures' }
        ]
      });

      for (const proposal of stuckProposals) {
        const daysStuck = (new Date() - proposal.created_at) / (1000 * 60 * 60 * 24);
        
        // Create audit log
        await ContractUpgradeAuditLog.create({
          proposal_id: proposal.id,
          action: 'proposal_stuck_detected',
          performed_by: 'system_monitor',
          action_details: {
            days_stuck: Math.round(daysStuck * 10) / 10,
            current_status: proposal.status,
            approvals: proposal.signatures.filter(s => s.decision === 'approve').length,
            required_signatures: proposal.required_signatures
          }
        });

        await this.sendStuckProposalAlert(proposal, daysStuck);
      }

      if (stuckProposals.length > 0) {
        logger.info(`Found ${stuckProposals.length} proposals stuck in pending state`);
      }

    } catch (error) {
      logger.error('Error checking stuck proposals:', error);
      Sentry.captureException(error);
    }
  }

  /**
   * Check certified build health
   */
  async checkCertifiedBuildHealth() {
    try {
      const inactiveBuilds = await CertifiedBuild.findAll({
        where: {
          is_active: false,
          updated_at: {
            $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Recently deactivated
          }
        }
      });

      const buildsWithoutAudit = await CertifiedBuild.findAll({
        where: {
          is_active: true,
          security_audit_passed: false
        }
      });

      if (inactiveBuilds.length > 0 || buildsWithoutAudit.length > 0) {
        await this.sendCertifiedBuildAlert(inactiveBuilds, buildsWithoutAudit);
        
        // Create audit log
        await ContractUpgradeAuditLog.create({
          proposal_id: null, // System-level alert
          action: 'certified_build_health_issue',
          performed_by: 'system_monitor',
          action_details: {
            inactive_builds_count: inactiveBuilds.length,
            builds_without_audit_count: buildsWithoutAudit.length,
            inactive_builds: inactiveBuilds.map(b => b.build_id),
            builds_without_audit: buildsWithoutAudit.map(b => b.build_id)
          }
        });
      }

    } catch (error) {
      logger.error('Error checking certified build health:', error);
      Sentry.captureException(error);
    }
  }

  /**
   * Generate monitoring report
   */
  async generateMonitoringReport(timestamp) {
    try {
      const stats = await this.getMonitoringStats();
      
      // Create audit log for monitoring report
      await ContractUpgradeAuditLog.create({
        proposal_id: null, // System-level report
        action: 'monitoring_report_generated',
        performed_by: 'system_monitor',
        action_details: {
          report_timestamp: timestamp.toISOString(),
          stats
        }
      });

      // Log to console
      logger.info('Contract Upgrade Monitoring Report:', {
        timestamp: timestamp.toISOString(),
        ...stats
      });

    } catch (error) {
      logger.error('Error generating monitoring report:', error);
      Sentry.captureException(error);
    }
  }

  /**
   * Get monitoring statistics
   */
  async getMonitoringStats() {
    try {
      const [
        totalProposals,
        activeProposals,
        pendingProposals,
        approvedProposals,
        executedProposals,
        failedProposals,
        recentExecutions
      ] = await Promise.all([
        ContractUpgradeProposal.count(),
        ContractUpgradeProposal.count({ where: { status: ['proposed', 'pending_verification', 'verified', 'pending_approval'] } }),
        ContractUpgradeProposal.count({ where: { status: 'pending_approval' } }),
        ContractUpgradeProposal.count({ where: { status: 'approved' } }),
        ContractUpgradeProposal.count({ where: { status: 'executed' } }),
        ContractUpgradeProposal.count({ where: { status: 'failed' } }),
        ContractUpgradeProposal.count({ 
          where: { 
            status: 'executed',
            executed_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          }
        })
      ]);

      const activeCertifiedBuilds = await CertifiedBuild.count({
        where: { is_active: true, security_audit_passed: true }
      });

      return {
        proposals: {
          total: totalProposals,
          active: activeProposals,
          pending: pendingProposals,
          approved: approvedProposals,
          executed: executedProposals,
          failed: failedProposals,
          recent_executions_24h: recentExecutions
        },
        certified_builds: {
          active_secure: activeCertifiedBuilds
        },
        health_metrics: {
          success_rate: totalProposals > 0 ? executedProposals / totalProposals : 0,
          failure_rate: totalProposals > 0 ? failedProposals / totalProposals : 0,
          pending_rate: activeProposals > 0 ? pendingProposals / activeProposals : 0
        }
      };

    } catch (error) {
      logger.error('Error getting monitoring stats:', error);
      return {};
    }
  }

  /**
   * Send expiration alert for proposal
   */
  async sendExpirationAlert(proposal, hoursUntilExpiration) {
    try {
      const message = `🚨 Contract Upgrade Proposal Expiring Soon\n\n` +
        `Proposal ID: ${proposal.id}\n` +
        `Vault: ${proposal.vault_address}\n` +
        `Status: ${proposal.status}\n` +
        `Expires in: ${hoursUntilExpiration.toFixed(1)} hours\n` +
        `Approvals: ${proposal.signatures.filter(s => s.decision === 'approve').length}/${proposal.required_signatures}`;

      await slackWebhookService.sendMessage(message, { 
        channel: '#contract-upgrades', 
        username: 'Upgrade Monitor' 
      });

    } catch (error) {
      logger.error('Error sending expiration alert:', error);
    }
  }

  /**
   * Send expiration alert for signature
   */
  async sendSignatureExpirationAlert(signature, hoursUntilExpiration) {
    try {
      const message = `⚠️ Signature Expiring Soon\n\n` +
        `Proposal ID: ${signature.proposal_id}\n` +
        `Signer: ${signature.signer_address}\n` +
        `Decision: ${signature.decision}\n` +
        `Expires in: ${hoursUntilExpiration.toFixed(1)} hours`;

      await slackWebhookService.sendMessage(message, { 
        channel: '#contract-upgrades', 
        username: 'Upgrade Monitor' 
      });

    } catch (error) {
      logger.error('Error sending signature expiration alert:', error);
    }
  }

  /**
   * Send failed upgrade alert
   */
  async sendFailedUpgradeAlert(failedUpgrades) {
    try {
      const message = `🚨 Multiple Failed Upgrades Detected\n\n` +
        `Failed upgrades in last 24 hours: ${failedUpgrades.length}\n` +
        `Latest failures:\n` +
        failedUpgrades.slice(0, 3).map(p => 
          `- ${p.vault_address}: ${p.verification_result?.error || 'Unknown error'}`
        ).join('\n');

      await slackWebhookService.sendMessage(message, { 
        channel: '#contract-upgrades-alerts', 
        username: 'Upgrade Monitor' 
      });

    } catch (error) {
      logger.error('Error sending failed upgrade alert:', error);
    }
  }

  /**
   * Send stuck proposal alert
   */
  async sendStuckProposalAlert(proposal, daysStuck) {
    try {
      const message = `⚠️ Stuck Proposal Detected\n\n` +
        `Proposal ID: ${proposal.id}\n` +
        `Vault: ${proposal.vault_address}\n` +
        `Status: ${proposal.status}\n` +
        `Stuck for: ${daysStuck.toFixed(1)} days\n` +
        `Approvals: ${proposal.signatures.filter(s => s.decision === 'approve').length}/${proposal.required_signatures}`;

      await slackWebhookService.sendMessage(message, { 
        channel: '#contract-upgrades', 
        username: 'Upgrade Monitor' 
      });

    } catch (error) {
      logger.error('Error sending stuck proposal alert:', error);
    }
  }

  /**
   * Send certified build health alert
   */
  async sendCertifiedBuildAlert(inactiveBuilds, buildsWithoutAudit) {
    try {
      const message = `⚠️ Certified Build Health Issues\n\n` +
        `Recently deactivated builds: ${inactiveBuilds.length}\n` +
        `Active builds without security audit: ${buildsWithoutAudit.length}\n` +
        `Inactive builds: ${inactiveBuilds.map(b => b.build_id).join(', ')}\n` +
        `Builds without audit: ${buildsWithoutAudit.map(b => b.build_id).join(', ')}`;

      await slackWebhookService.sendMessage(message, { 
        channel: '#contract-upgrades-alerts', 
        username: 'Upgrade Monitor' 
      });

    } catch (error) {
      logger.error('Error sending certified build alert:', error);
    }
  }

  /**
   * Get monitoring dashboard data
   */
  async getMonitoringDashboard() {
    try {
      const stats = await this.getMonitoringStats();
      
      const recentActivity = await ContractUpgradeAuditLog.findAll({
        where: {
          created_at: {
            $gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
          }
        },
        order: [['created_at', 'DESC']],
        limit: 50
      });

      const upcomingExpirations = await ContractUpgradeProposal.findAll({
        where: {
          status: ['verified', 'pending_approval'],
          expires_at: {
            $gt: new Date(),
            $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // Next 7 days
          }
        },
        order: [['expires_at', 'ASC']],
        limit: 10
      });

      return {
        stats,
        recent_activity: recentActivity,
        upcoming_expirations: upcomingExpirations,
        last_updated: new Date().toISOString()
      };

    } catch (error) {
      logger.error('Error getting monitoring dashboard:', error);
      Sentry.captureException(error);
      throw new Error('Failed to get monitoring dashboard data');
    }
  }

  /**
   * Force run monitoring (manual trigger)
   */
  async forceRunMonitoring() {
    try {
      logger.info('Force running contract upgrade monitoring...');
      await this.runMonitoring();
      return { success: true, message: 'Monitoring completed successfully' };
    } catch (error) {
      logger.error('Error in force monitoring run:', error);
      Sentry.captureException(error);
      throw new Error('Force monitoring failed');
    }
  }
}

module.exports = new ContractUpgradeMonitoringService();
