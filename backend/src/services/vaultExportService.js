const logger = require('../utils/logger');
const { Vault, Beneficiary, Organization } = require('../models');
const { Op } = require('sequelize');

class VaultExportService {
  /**
   * Get vault details with beneficiaries for export
   * @param {string} vaultId - Vault UUID or address
   * @returns {Promise<Object>} Vault data with beneficiaries
   */
  async getVaultDataForExport(vaultId) {
    try {
      // Find vault by ID or address
      const vault = await Vault.findOne({
        where: {
          [Op.or]: [
            { id: vaultId },
            { address: vaultId }
          ]
        },
        include: [
          {
            model: Organization,
            as: 'organization',
            attributes: ['id', 'name']
          },
          {
            model: Beneficiary,
            as: 'beneficiaries',
            attributes: ['id', 'address', 'total_allocated', 'total_withdrawn', 'created_at', 'updated_at']
          }
        ]
      });

      if (!vault) {
        throw new Error('Vault not found');
      }

      return vault;
    } catch (error) {
      logger.error('Error fetching vault data for export:', error);
      throw error;
    }
  }

  /**
   * Generate CSV headers for vault export
   * @returns {string} CSV header row
   */
  generateCSVHeaders() {
    return 'Vault ID,Vault Address,Vault Name,Token Address,Owner Address,Total Amount,Organization ID,Organization Name,Created At,Updated At,Beneficiary ID,Beneficiary Address,Total Allocated,Total Withdrawn,Beneficiary Created At,Beneficiary Updated At\n';
  }

  /**
   * Convert vault data to CSV format
   * @param {Object} vault - Vault data with beneficiaries
   * @returns {string} CSV formatted data
   */
  vaultToCSV(vault) {
    const csvRows = [];
    
    // If no beneficiaries, still export vault info
    if (!vault.beneficiaries || vault.beneficiaries.length === 0) {
      const row = [
        vault.id || '',
        vault.address || '',
        `"${(vault.name || '').replace(/"/g, '""')}"`, // Escape quotes in CSV
        vault.token_address || '',
        vault.owner_address || '',
        vault.total_amount?.toString() || '0',
        vault.org_id || '',
        `"${(vault.organization?.name || '').replace(/"/g, '""')}"`,
        vault.created_at?.toISOString() || '',
        vault.updated_at?.toISOString() || '',
        '', '', '', '', '', '' // Empty beneficiary fields
      ];
      csvRows.push(row.join(','));
    } else {
      // Create a row for each beneficiary
      vault.beneficiaries.forEach(beneficiary => {
        const row = [
          vault.id || '',
          vault.address || '',
          `"${(vault.name || '').replace(/"/g, '""')}"`,
          vault.token_address || '',
          vault.owner_address || '',
          vault.total_amount?.toString() || '0',
          vault.org_id || '',
          `"${(vault.organization?.name || '').replace(/"/g, '""')}"`,
          vault.created_at?.toISOString() || '',
          vault.updated_at?.toISOString() || '',
          beneficiary.id || '',
          beneficiary.address || '',
          beneficiary.total_allocated?.toString() || '0',
          beneficiary.total_withdrawn?.toString() || '0',
          beneficiary.created_at?.toISOString() || '',
          beneficiary.updated_at?.toISOString() || ''
        ];
        csvRows.push(row.join(','));
      });
    }

    return csvRows.join('\n');
  }

  /**
   * Stream vault data as CSV
   * @param {string} vaultId - Vault UUID or address
   * @param {import('stream').Writable} stream - Response stream to write to
   */
  async streamVaultAsCSV(vaultId, stream) {
    try {
      // Write CSV headers
      stream.write(this.generateCSVHeaders());

      // Get vault data
      const vault = await this.getVaultDataForExport(vaultId);

      // Write vault data as CSV
      const csvData = this.vaultToCSV(vault);
      stream.write(csvData);

      // End the stream
      stream.end();
    } catch (error) {
      logger.error('Error streaming vault as CSV:', error);
      stream.destroy(error);
    }
  }
}

module.exports = new VaultExportService();
