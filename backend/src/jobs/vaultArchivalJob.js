const logger = require('../utils/logger');
const cron = require('node-cron');
const { sequelize } = require('../database/connection');
const { Vault, SubSchedule } = require('../models');

// Implements Cold Storage for Completed Vaults (Issue #37)
class VaultArchivalJob {
  constructor() {
    // Run every Sunday at 02:00 AM
    this.cronSchedule = '0 2 * * 0'; 
  }

  start() {
    logger.info('Initializing Vault Archival Job...');
    
    // Ensure the archived_vaults table exists before scheduling
    this.initializeTable().then(() => {
      cron.schedule(this.cronSchedule, async () => {
        logger.info('Running Vault Archival Job...');
        try {
          await this.archiveCompletedVaults();
        } catch (error) {
          logger.error('Error running Vault Archival Job:', error);
        }
      });
      logger.info('Vault Archival Job scheduled successfully.');
    }).catch(err => {
      logger.error('Failed to initialize archived_vaults table:', err);
    });
  }

  async initializeTable() {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS archived_vaults (
        id SERIAL PRIMARY KEY,
        original_vault_id INTEGER NOT NULL,
        vault_address VARCHAR(255) NOT NULL,
        vault_data JSONB NOT NULL,
        archived_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async archiveCompletedVaults() {
    logger.info('Starting vault archival process...');
    
    try {
      const vaults = await Vault.findAll();
      let archivedCount = 0;

      for (const vault of vaults) {
        const subSchedule = await SubSchedule.findOne({ where: { vault_id: vault.id } });
        
        // Need a subschedule to determine end_time and amounts accurately
        if (!subSchedule) continue;

        const totalAmount = parseFloat(vault.total_amount || 0);
        const amountReleased = parseFloat(subSchedule.amount_released || 0);
        const claimableBalance = totalAmount - amountReleased;

        let isEndTimePassed = false;
        
        // Check end_date directly on vault if it exists
        if (vault.end_date) {
           isEndTimePassed = new Date() > new Date(vault.end_date);
        } else if (subSchedule.vesting_start_date && subSchedule.vesting_duration) {
          const startDate = new Date(subSchedule.vesting_start_date);
          const endDate = new Date(startDate.getTime() + (subSchedule.vesting_duration * 1000));
          isEndTimePassed = new Date() > endDate;
        }

        // Allow for tiny floating point inaccuracies
        if (claimableBalance <= 0.000001 && isEndTimePassed) {
          const transaction = await sequelize.transaction();
          try {
            let fullVault;
            try {
              // Attempt to fetch all associated records for a complete archive payload
              fullVault = await Vault.findOne({
                where: { id: vault.id },
                include: { all: true }
              });
            } catch (incErr) {
              fullVault = vault;
            }

            const vaultData = JSON.stringify(fullVault ? fullVault.get({ plain: true }) : vault.get({ plain: true }));

            await sequelize.query(`
              INSERT INTO archived_vaults (original_vault_id, vault_address, vault_data)
              VALUES (:id, :address, :data)
            `, {
              replacements: {
                id: vault.id,
                address: vault.address || 'unknown',
                data: vaultData
              },
              transaction
            });

            // Clear known dependencies manually to prevent foreign key constraint errors
            if (sequelize.models.Notification) {
              await sequelize.models.Notification.destroy({ where: { vault_id: vault.id }, transaction });
            }
            if (sequelize.models.SubSchedule) {
              await sequelize.models.SubSchedule.destroy({ where: { vault_id: vault.id }, transaction });
            }
            
            await Vault.destroy({ where: { id: vault.id }, transaction });

            await transaction.commit();
            archivedCount++;
            logger.info(`Archived vault: ${vault.address}`);
          } catch (err) {
            await transaction.rollback();
            logger.error(`Error archiving vault ${vault.address}:`, err);
          }
        }
      }
      
      logger.info(`Vault archival process completed. Archived ${archivedCount} vaults.`);
    } catch (error) {
      logger.error('Error during vault archival:', error);
    }
  }
}

module.exports = new VaultArchivalJob();