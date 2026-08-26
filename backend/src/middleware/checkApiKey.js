const db = require('../database'); // Adjust the path as necessary
const crypto = require('crypto');
const logger = require('../utils/logger');

const checkApiKey = async (req, res, next) => {
    try {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    // Hash the API key to compare with stored hashed keys
    const hashedApiKey = crypto.createHash('sha256').update(apiKey).digest('hex');

    // Check if the hashed API key exists in the database
      const [rows] = await db.query(
        'SELECT id FROM api_keys WHERE hashed_key = ? AND revoked_at IS NULL LIMIT 1',
        { replacements: [hashedApiKey] }
      );
      
      if (!rows || rows.length === 0) {
        return res.status(403).json({ message: 'Invalid API key' });
      }

    next();
    } catch (error) {
        logger.error('Error checking API key:', error);
        return res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = checkApiKey;