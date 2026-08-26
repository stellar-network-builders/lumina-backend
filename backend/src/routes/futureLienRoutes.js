const express = require('express');
const router = express.Router();
const futureLienService = require('../services/futureLienService');
const logger = require('../utils/logger');
// There is no `../middleware/authMiddleware` module / `authenticateToken` export;
// build the user-auth middleware from authService.
const authService = require('../services/authService');
const authenticateToken = authService.authenticate();
// Inline route validators use express-validator's param/query/body.
const { body, param, query } = require('express-validator');
const {
  createFutureLienValidation,
  processLienReleaseValidation,
  cancelFutureLienValidation,
  getLienValidation,
  createGrantStreamValidation,
  calculatorValidation,
  handleValidationErrors
} = require('../middleware/futureLienValidation');

// POST /api/future-liens - Create a new future lien
router.post('/future-liens', authenticateToken, createFutureLienValidation, handleValidationErrors, async (req, res) => {
  try {
    const creatorAddress = req.user.address || req.body.creator_address;
    const result = await futureLienService.createFutureLien(req.body, creatorAddress);

    res.status(201).json({
      success: true,
      data: result,
      message: 'Future lien created successfully'
    });
  } catch (error) {
    logger.error('Error creating future lien:', error);
    res.status(400).json({
      success: false,
      error: error.message,
      message: 'Failed to create future lien'
    });
  }
});

// GET /api/future-liens/beneficiary/:address - Get liens for a beneficiary
router.get('/future-liens/beneficiary/:address', authenticateToken, [
  param('address').isEthereumAddress().withMessage('Valid beneficiary address required'),
  query('status').optional().isIn(['pending', 'active', 'completed', 'cancelled']).withMessage('Invalid status'),
  query('include_inactive').optional().isBoolean().withMessage('Include inactive must be boolean'),
], handleValidationErrors, async (req, res) => {
  try {
    const { address } = req.params;
    const options = {
      status: req.query.status,
      includeInactive: req.query.include_inactive === 'true'
    };

    const liens = await futureLienService.getBeneficiaryLiens(address, options);

    res.json({
      success: true,
      data: liens,
      count: liens.length
    });
  } catch (error) {
    logger.error('Error getting beneficiary liens:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve beneficiary liens'
    });
  }
});

// GET /api/future-liens/vault/:address - Get liens for a vault
router.get('/future-liens/vault/:address', authenticateToken, [
  param('address').isEthereumAddress().withMessage('Valid vault address required'),
  query('status').optional().isIn(['pending', 'active', 'completed', 'cancelled']).withMessage('Invalid status'),
  query('include_inactive').optional().isBoolean().withMessage('Include inactive must be boolean'),
], handleValidationErrors, async (req, res) => {
  try {
    const { address } = req.params;
    const options = {
      status: req.query.status,
      includeInactive: req.query.include_inactive === 'true'
    };

    const liens = await futureLienService.getVaultLiens(address, options);

    res.json({
      success: true,
      data: liens,
      count: liens.length
    });
  } catch (error) {
    logger.error('Error getting vault liens:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve vault liens'
    });
  }
});

// GET /api/future-liens/grant-stream/:id - Get liens for a grant stream
router.get('/future-liens/grant-stream/:id', authenticateToken, [
  param('id').isInt({ min: 1 }).withMessage('Valid grant stream ID required'),
  query('status').optional().isIn(['pending', 'active', 'completed', 'cancelled']).withMessage('Invalid status'),
  query('include_inactive').optional().isBoolean().withMessage('Include inactive must be boolean'),
], handleValidationErrors, async (req, res) => {
  try {
    const { id } = req.params;
    const options = {
      status: req.query.status,
      includeInactive: req.query.include_inactive === 'true'
    };

    const liens = await futureLienService.getGrantStreamLiens(parseInt(id), options);

    res.json({
      success: true,
      data: liens,
      count: liens.length
    });
  } catch (error) {
    logger.error('Error getting grant stream liens:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve grant stream liens'
    });
  }
});

// POST /api/future-liens/:id/release - Process a release from a lien
router.post('/future-liens/:id/release', authenticateToken, processLienReleaseValidation, handleValidationErrors, async (req, res) => {
  try {
    const { id } = req.params;
    const processorAddress = req.user.address || req.body.processor_address;

    const releaseData = {
      lien_id: parseInt(id),
      ...req.body
    };

    const result = await futureLienService.processLienRelease(releaseData, processorAddress);

    res.json({
      success: true,
      data: result,
      message: 'Lien release processed successfully'
    });
  } catch (error) {
    logger.error('Error processing lien release:', error);
    res.status(400).json({
      success: false,
      error: error.message,
      message: 'Failed to process lien release'
    });
  }
});

// POST /api/future-liens/:id/cancel - Cancel a future lien
router.post('/future-liens/:id/cancel', authenticateToken, cancelFutureLienValidation, handleValidationErrors, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const cancellerAddress = req.user.address || req.body.canceller_address;

    const result = await futureLienService.cancelFutureLien(parseInt(id), cancellerAddress, reason);

    res.json({
      success: true,
      data: result,
      message: 'Future lien cancelled successfully'
    });
  } catch (error) {
    logger.error('Error cancelling future lien:', error);
    res.status(400).json({
      success: false,
      error: error.message,
      message: 'Failed to cancel future lien'
    });
  }
});

// GET /api/future-liens/summary - Get active lien summary
router.get('/future-liens/summary', authenticateToken, [
  query('vault_address').optional().isEthereumAddress().withMessage('Invalid vault address'),
  query('beneficiary_address').optional().isEthereumAddress().withMessage('Invalid beneficiary address'),
  query('grant_stream_id').optional().isInt({ min: 1 }).withMessage('Invalid grant stream ID'),
], handleValidationErrors, async (req, res) => {
  try {
    const options = {
      vault_address: req.query.vault_address,
      beneficiary_address: req.query.beneficiary_address,
      grant_stream_id: req.query.grant_stream_id ? parseInt(req.query.grant_stream_id) : null
    };

    const summary = await futureLienService.getActiveLienSummary(options);

    res.json({
      success: true,
      data: summary,
      count: summary.length
    });
  } catch (error) {
    logger.error('Error getting lien summary:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve lien summary'
    });
  }
});

// GET /api/future-liens/:id - Get specific lien details
router.get('/future-liens/:id', authenticateToken, getLienValidation, handleValidationErrors, async (req, res) => {
  try {
    const { id } = req.params;

    // Use the beneficiary liens endpoint with specific ID filter
    const liens = await futureLienService.getBeneficiaryLiens('', { includeInactive: true });
    const lien = liens.find(l => l.id === parseInt(id));

    if (!lien) {
      return res.status(404).json({
        success: false,
        error: 'Lien not found',
        message: `Future lien with ID ${id} not found`
      });
    }

    res.json({
      success: true,
      data: lien
    });
  } catch (error) {
    logger.error('Error getting lien details:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve lien details'
    });
  }
});

// POST /api/grant-streams - Create a new grant stream
router.post('/grant-streams', authenticateToken, createGrantStreamValidation, handleValidationErrors, async (req, res) => {
  try {
    const creatorAddress = req.user.address || req.body.creator_address;
    const result = await futureLienService.createGrantStream(req.body, creatorAddress);

    res.status(201).json({
      success: true,
      data: result,
      message: 'Grant stream created successfully'
    });
  } catch (error) {
    logger.error('Error creating grant stream:', error);
    res.status(400).json({
      success: false,
      error: error.message,
      message: 'Failed to create grant stream'
    });
  }
});

// GET /api/grant-streams - Get all active grant streams
router.get('/grant-streams', authenticateToken, async (req, res) => {
  try {
    const grantStreams = await futureLienService.getActiveGrantStreams();

    res.json({
      success: true,
      data: grantStreams,
      count: grantStreams.length
    });
  } catch (error) {
    logger.error('Error getting grant streams:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve grant streams'
    });
  }
});

// GET /api/grant-streams/:id - Get specific grant stream details
router.get('/grant-streams/:id', authenticateToken, [
  param('id').isInt({ min: 1 }).withMessage('Valid grant stream ID required'),
], handleValidationErrors, async (req, res) => {
  try {
    const { id } = req.params;

    const grantStreams = await futureLienService.getActiveGrantStreams();
    const grantStream = grantStreams.find(gs => gs.id === parseInt(id));

    if (!grantStream) {
      return res.status(404).json({
        success: false,
        error: 'Grant stream not found',
        message: `Grant stream with ID ${id} not found`
      });
    }

    res.json({
      success: true,
      data: grantStream
    });
  } catch (error) {
    logger.error('Error getting grant stream details:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to retrieve grant stream details'
    });
  }
});

// GET /api/vesting-to-grant/calculator - Calculate potential lien impact
router.get('/vesting-to-grant/calculator', authenticateToken, calculatorValidation, handleValidationErrors, async (req, res) => {
  try {
    const {
      vault_address,
      beneficiary_address,
      committed_amount,
      release_rate_type,
      release_start_date,
      release_end_date
    } = req.query;

    // Get current vesting calculation
    const vestingService = require('../services/vestingService');
    const vestingCalculation = await vestingService.calculateWithdrawableAmount(
      vault_address,
      beneficiary_address
    );

    // Calculate projected releases
    const releaseStart = new Date(release_start_date);
    const releaseEnd = new Date(release_end_date);
    const totalDays = (releaseEnd - releaseStart) / (1000 * 60 * 60 * 24);

    let projectedReleases = [];

    if (release_rate_type === 'linear') {
      // Project monthly releases for linear type
      const monthlyAmount = parseFloat(committed_amount) / (totalDays / 30);
      for (let month = 0; month < Math.ceil(totalDays / 30); month++) {
        const releaseDate = new Date(releaseStart);
        releaseDate.setMonth(releaseDate.getMonth() + month);

        if (releaseDate <= releaseEnd) {
          projectedReleases.push({
            date: releaseDate.toISOString(),
            amount: Math.min(monthlyAmount, parseFloat(committed_amount) - (monthlyAmount * month))
          });
        }
      }
    } else if (release_rate_type === 'immediate') {
      projectedReleases.push({
        date: releaseStart.toISOString(),
        amount: parseFloat(committed_amount)
      });
    }

    // milestone projections would be handled differently

    res.json({
      success: true,
      data: {
        current_vesting: vestingCalculation,
        lien_projection: {
          committed_amount: parseFloat(committed_amount),
          release_rate_type,
          release_period: {
            start: release_start_date,
            end: release_end_date,
            total_days: Math.ceil(totalDays)
          },
          projected_releases: projectedReleases,
          total_releases: projectedReleases.reduce((sum, r) => sum + r.amount, 0)
        },
        impact_analysis: {
          remaining_vesting_after_commitment: Math.max(0, vestingCalculation.total_vested - parseFloat(committed_amount)),
          commitment_percentage: vestingCalculation.total_vested > 0 ?
            (parseFloat(committed_amount) / vestingCalculation.total_vested) * 100 : 0
        }
      }
    });
  } catch (error) {
    logger.error('Error calculating lien impact:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to calculate lien impact'
    });
  }
});

module.exports = router;
