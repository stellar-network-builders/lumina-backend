const express = require('express');
const router = express.Router();
const db = require('../db');
const logger = require('../utils/logger');

// GET /api/token/:address/supply
router.get('/:address/supply', async (req, res) => {
  try {
    const tokenAddress = req.params.address.toLowerCase();

    // 1. Get total minted (from db or a model)
    const totalMintedResult = await db.query(
      'SELECT SUM(amount) AS total_minted FROM tokens WHERE address = $1',
      [tokenAddress]
    );
    const totalMinted = totalMintedResult.rows[0]?.total_minted || 0;

    // 2. Sum unvested balances
    const unvestedResult = await db.query(
      'SELECT SUM(unvested_balance) AS total_unvested FROM vesting_vaults WHERE token_address = $1 AND active = true',
      [tokenAddress]
    );
    const totalUnvested = unvestedResult.rows[0]?.total_unvested || 0;

    // 3. Calculate circulating
    const circulatingSupply = totalMinted - totalUnvested;

    return res.json({
      token: tokenAddress,
      circulatingSupply,
      totalMinted,
      totalUnvested
    });
  } catch (err) {
    logger.error('Token supply query error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
