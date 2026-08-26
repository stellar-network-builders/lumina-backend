const express = require('express');
const router = express.Router();
const vaultRegistryService = require('../services/vaultRegistryService');
const Sentry = require('@sentry/node');
const { applyPrivacyMasking } = require('../utils/privacyMasking');
const authService = require('../services/authService');
const logger = require('../utils/logger');

/**
 * @swagger
 * components:
 *   schemas:
 *     VaultRegistryEntry:
 *       type: object
 *       properties:
 *         contract_id:
 *           type: string
 *           description: Stellar contract address/hash
 *         project_name:
 *           type: string
 *           description: Human-readable project name
 *         creator_address:
 *           type: string
 *           description: Address of the vault creator
 *         deployment_ledger:
 *           type: integer
 *           description: Ledger number when vault was deployed
 *         deployment_transaction_hash:
 *           type: string
 *           description: Transaction hash of deployment
 *         token_address:
 *           type: string
 *           description: Token address associated with vault
 *         vault_type:
 *           type: string
 *           enum: [standard, cliff, dynamic]
 *           description: Type of vault contract
 *         is_active:
 *           type: boolean
 *           description: Whether vault is currently active
 *         discovered_at:
 *           type: string
 *           format: date-time
 *           description: When vault was discovered by indexer
 *         metadata:
 *           type: object
 *           description: Additional metadata about the vault
 */

/**
 * @swagger
 * /api/registry/vaults/by-creator/{creatorAddress}:
 *   get:
 *     summary: List all vaults created by a specific address
 *     tags: [Vault Registry]
 *     parameters:
 *       - in: path
 *         name: creatorAddress
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar address of the vault creator
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of results to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip
 *       - in: query
 *         name: includeInactive
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include inactive vaults in results
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [discovered_at, deployment_ledger, project_name]
 *           default: discovered_at
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [ASC, DESC]
 *           default: DESC
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Successfully retrieved vaults by creator
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     vaults:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/VaultRegistryEntry'
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         total:
 *                           type: integer
 *                         limit:
 *                           type: integer
 *                         offset:
 *                           type: integer
 *                         has_more:
 *                           type: boolean
 *       400:
 *         description: Invalid parameters
 *       500:
 *         description: Server error
 */
router.get('/vaults/by-creator/:creatorAddress', async (req, res) => {
  try {
    const { creatorAddress } = req.params;
    const options = {
      limit: req.query.limit,
      offset: req.query.offset,
      includeInactive: req.query.includeInactive === 'true',
      sortBy: req.query.sortBy || 'discovered_at',
      sortOrder: req.query.sortOrder || 'DESC'
    };

    // Validate Stellar address format
    if (!creatorAddress || typeof creatorAddress !== 'string' || creatorAddress.length < 10) {
      return res.status(400).json({
        success: false,
        error: 'Invalid creator address format'
      });
    }

    const result = await vaultRegistryService.listVaultsByCreator(creatorAddress, options);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Error in list_vaults_by_creator:', error);
    Sentry.captureException(error, {
      tags: { route: 'vaultRegistry', endpoint: 'list_vaults_by_creator' },
      extra: { params: req.params, query: req.query }
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error while fetching vaults by creator'
    });
  }
});

/**
 * @swagger
 * /api/registry/vaults/search:
 *   get:
 *     summary: Search vaults by project name
 *     tags: [Vault Registry]
 *     parameters:
 *       - in: query
 *         name: projectName
 *         required: true
 *         schema:
 *           type: string
 *         description: Project name to search for (partial match)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of results to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip
 *       - in: query
 *         name: includeInactive
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include inactive vaults in results
 *     responses:
 *       200:
 *         description: Successfully searched vaults
 *       400:
 *         description: Missing or invalid parameters
 *       500:
 *         description: Server error
 */
router.get('/vaults/search', async (req, res) => {
  try {
    const { projectName } = req.query;

    if (!projectName || projectName.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Project name must be at least 2 characters long'
      });
    }

    const options = {
      limit: req.query.limit,
      offset: req.query.offset,
      includeInactive: req.query.includeInactive === 'true'
    };

    const result = await vaultRegistryService.searchVaultsByProjectName(projectName.trim(), options);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Error in search_vaults:', error);
    Sentry.captureException(error, {
      tags: { route: 'vaultRegistry', endpoint: 'search_vaults' },
      extra: { query: req.query }
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error while searching vaults'
    });
  }
});

/**
 * @swagger
 * /api/registry/vaults:
 *   get:
 *     summary: Get all vaults in the registry (for ecosystem analytics)
 *     tags: [Vault Registry]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of results to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip
 *       - in: query
 *         name: includeInactive
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include inactive vaults in results
 *       - in: query
 *         name: vaultType
 *         schema:
 *           type: string
 *           enum: [standard, cliff, dynamic]
 *         description: Filter by vault type
 *     responses:
 *       200:
 *         description: Successfully retrieved all vaults
 *       500:
 *         description: Server error
 */
router.get('/vaults', async (req, res) => {
  try {
    const options = {
      limit: req.query.limit,
      offset: req.query.offset,
      includeInactive: req.query.includeInactive === 'true',
      vaultType: req.query.vaultType
    };

    const result = await vaultRegistryService.getAllVaults(options);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Error in get_all_vaults:', error);
    Sentry.captureException(error, {
      tags: { route: 'vaultRegistry', endpoint: 'get_all_vaults' },
      extra: { query: req.query }
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error while fetching all vaults'
    });
  }
});

/**
 * @swagger
 * /api/registry/vaults/{contractId}:
 *   get:
 *     summary: Get specific vault details by contract ID
 *     tags: [Vault Registry]
 *     parameters:
 *       - in: path
 *         name: contractId
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar contract ID
 *     responses:
 *       200:
 *         description: Successfully retrieved vault details
 *       404:
 *         description: Vault not found
 *       500:
 *         description: Server error
 */
router.get('/vaults/:contractId', authService.authenticate(false), async (req, res) => {
  try {
    const { contractId } = req.params;

    const { VaultRegistry, Vault, Beneficiary } = require('../models');
    const vault = await VaultRegistry.findOne({
      where: { contract_id: contractId },
      include: [{
        model: Vault,
        as: 'vaultDetails',
        required: false,
        include: [{
          model: Beneficiary,
          as: 'beneficiaries',
          required: false
        }]
      }]
    });

    if (!vault) {
      return res.status(404).json({
        success: false,
        error: 'Vault not found in registry'
      });
    }

    // Get user information from request (if available)
    const user = req.user || null;

    // Apply privacy masking if vault has privacy mode enabled
    let responseData = vault;
    if (vault.vaultDetails && vault.vaultDetails.privacy_mode_enabled) {
      responseData = applyPrivacyMasking(vault, user);
    }

    res.json({
      success: true,
      data: responseData
    });
  } catch (error) {
    logger.error('Error in get_vault_by_id:', error);
    Sentry.captureException(error, {
      tags: { route: 'vaultRegistry', endpoint: 'get_vault_by_id' },
      extra: { params: req.params }
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error while fetching vault details'
    });
  }
});

/**
 * @swagger
 * /api/registry/stats:
 *   get:
 *     summary: Get registry statistics for ecosystem analytics
 *     tags: [Vault Registry]
 *     responses:
 *       200:
 *         description: Successfully retrieved registry statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     total_vaults:
 *                       type: integer
 *                     active_vaults:
 *                       type: integer
 *                     unique_creators:
 *                       type: integer
 *                     vaults_by_type:
 *                       type: object
 *                       additionalProperties:
 *                         type: integer
 *                     recent_deployments:
 *                       type: integer
 *       500:
 *         description: Server error
 */
router.get('/stats', async (req, res) => {
  try {
    const { VaultRegistry, sequelize } = require('../models');

    // Get various statistics
    const [
      totalVaults,
      activeVaults,
      uniqueCreators,
      vaultsByType,
      recentDeployments
    ] = await Promise.all([
      VaultRegistry.count(),
      VaultRegistry.count({ where: { is_active: true } }),
      VaultRegistry.count({
        distinct: true,
        col: 'creator_address'
      }),
      VaultRegistry.findAll({
        attributes: [
          'vault_type',
          [sequelize.fn('COUNT', sequelize.col('vault_type')), 'count']
        ],
        group: ['vault_type']
      }),
      VaultRegistry.count({
        where: {
          discovered_at: {
            [sequelize.Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
          }
        }
      })
    ]);

    const vaultTypeStats = vaultsByType.reduce((acc, item) => {
      acc[item.vault_type] = parseInt(item.dataValues.count);
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        total_vaults: totalVaults,
        active_vaults: activeVaults,
        unique_creators: uniqueCreators,
        vaults_by_type: vaultTypeStats,
        recent_deployments: recentDeployments
      }
    });
  } catch (error) {
    logger.error('Error in get_registry_stats:', error);
    Sentry.captureException(error, {
      tags: { route: 'vaultRegistry', endpoint: 'get_registry_stats' }
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error while fetching registry statistics'
    });
  }
});

module.exports = router;
