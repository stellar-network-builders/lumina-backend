const express = require('express');
const router = express.Router();
const accountingExportService = require('../services/accountingExportService');
const { Organization } = require('../models');
const logger = require('../utils/logger');

/**
 * GET /api/org/:id/export/xero
 * Export organization's token payroll expenses as Xero-compatible CSV
 */
router.get('/:id/export/xero', async (req, res) => {
  try {
    const { id: organizationId } = req.params;
    const { startDate, endDate, tokenAddress } = req.query;

    // Validate organization exists
    const organization = await Organization.findOne({
      where: { id: organizationId }
    });

    if (!organization) {
      return res.status(404).json({
        success: false,
        error: 'Organization not found'
      });
    }

    // Validate export options
    const validation = accountingExportService.validateExportOptions({
      startDate,
      endDate,
      tokenAddress
    });

    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid parameters',
        details: validation.errors
      });
    }

    // Generate Xero CSV
    const csvContent = await accountingExportService.generateXeroExport(organizationId, {
      startDate,
      endDate,
      tokenAddress
    });

    // Set response headers for CSV download
    const filename = `${organization.name || 'organization'}_xero_export_${new Date().toISOString().split('T')[0]}.csv`;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);

  } catch (error) {
    logger.error('Error in Xero export endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * GET /api/org/:id/export/quickbooks
 * Export organization's token payroll expenses as QuickBooks-compatible CSV
 */
router.get('/:id/export/quickbooks', async (req, res) => {
  try {
    const { id: organizationId } = req.params;
    const { startDate, endDate, tokenAddress } = req.query;

    // Validate organization exists
    const organization = await Organization.findOne({
      where: { id: organizationId }
    });

    if (!organization) {
      return res.status(404).json({
        success: false,
        error: 'Organization not found'
      });
    }

    // Validate export options
    const validation = accountingExportService.validateExportOptions({
      startDate,
      endDate,
      tokenAddress
    });

    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid parameters',
        details: validation.errors
      });
    }

    // Generate QuickBooks CSV
    const csvContent = await accountingExportService.generateQuickBooksExport(organizationId, {
      startDate,
      endDate,
      tokenAddress
    });

    // Set response headers for CSV download
    const filename = `${organization.name || 'organization'}_quickbooks_export_${new Date().toISOString().split('T')[0]}.csv`;
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);

  } catch (error) {
    logger.error('Error in QuickBooks export endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

/**
 * GET /api/org/:id/export/summary
 * Get export summary statistics for an organization
 */
router.get('/:id/export/summary', async (req, res) => {
  try {
    const { id: organizationId } = req.params;
    const { startDate, endDate, tokenAddress } = req.query;

    // Validate organization exists
    const organization = await Organization.findOne({
      where: { id: organizationId }
    });

    if (!organization) {
      return res.status(404).json({
        success: false,
        error: 'Organization not found'
      });
    }

    // Validate export options
    const validation = accountingExportService.validateExportOptions({
      startDate,
      endDate,
      tokenAddress
    });

    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid parameters',
        details: validation.errors
      });
    }

    // Get export summary
    const summary = await accountingExportService.getExportSummary(organizationId, {
      startDate,
      endDate,
      tokenAddress
    });

    res.json({
      success: true,
      data: {
        organization: {
          id: organization.id,
          name: organization.name
        },
        ...summary
      }
    });

  } catch (error) {
    logger.error('Error in export summary endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

module.exports = router;
