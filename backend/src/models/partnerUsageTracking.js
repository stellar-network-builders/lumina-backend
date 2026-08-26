const logger = require('../utils/logger');
const { DataTypes } = require('sequelize');
const { sequelize } = require('../database/connection');
const PartnerManagement = require('./partnerManagement');

/**
 * PartnerUsageTracking
 * Tracks API usage for partners to generate monthly reports
 */
const PartnerUsageTracking = sequelize.define('PartnerUsageTracking', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  partner_id: {
    type: DataTypes.UUID,
    allowNull: false,
    comment: 'Reference to partner management ID',
  },
  api_key: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'API key used for the request',
  },
  endpoint: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'API endpoint accessed',
  },
  request_method: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'HTTP method (GET, POST, etc.)',
  },
  response_status: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'HTTP response status code',
  },
  response_time_ms: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Response time in milliseconds',
  },
  request_timestamp: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
    comment: 'When the request was made',
  },
  request_size_bytes: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'Size of request payload in bytes',
  },
  response_size_bytes: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'Size of response payload in bytes',
  },
  error_message: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Error message if request failed',
  },
  ip_address: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'IP address of the requester',
  },
  user_agent: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'User agent string',
  },
  metadata: {
    type: DataTypes.JSONB,
    allowNull: true,
    comment: 'Additional request metadata',
  },
  billing_period: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Billing period (e.g., "2026-03")',
  },
}, {
  tableName: 'partner_usage_tracking',
  timestamps: false,
  createdAt: 'request_timestamp',
  indexes: [
    {
      fields: ['partner_id'],
    },
    {
      fields: ['api_key'],
    },
    {
      fields: ['request_timestamp'],
    },
    {
      fields: ['billing_period'],
    },
    {
      fields: ['endpoint'],
    },
    {
      fields: ['partner_id', 'request_timestamp'],
    },
  ],
});

// Association
PartnerUsageTracking.belongsTo(PartnerManagement, {
  foreignKey: 'partner_id',
  as: 'partner'
});

/**
 * Track API request
 * @param {Object} requestData - Request data to track
 */
PartnerUsageTracking.trackRequest = async function(requestData) {
  try {
    await this.create(requestData);
  } catch (error) {
    logger.error('Error tracking partner usage:', error);
  }
};

/**
 * Get usage statistics for a partner
 * @param {string} partnerId - Partner ID
 * @param {string} billingPeriod - Billing period (YYYY-MM)
 * @returns {Promise<Object>} Usage statistics
 */
PartnerUsageTracking.getUsageStats = async function(partnerId, billingPeriod) {
  const stats = await this.findAll({
    where: {
      partner_id: partnerId,
      billing_period: billingPeriod
    },
    attributes: [
      [sequelize.fn('COUNT', sequelize.col('id')), 'total_requests'],
      [sequelize.fn('SUM', sequelize.case([
        [{ response_status: { [sequelize.Op.gte]: 200, [sequelize.Op.lt]: 300 } }, 1]
      ], { else: 0 })), 'successful_requests'],
      [sequelize.fn('SUM', sequelize.case([
        [{ response_status: { [sequelize.Op.gte]: 400 } }, 1]
      ], { else: 0 })), 'failed_requests'],
      [sequelize.fn('AVG', sequelize.col('response_time_ms')), 'avg_response_time_ms'],
      [sequelize.fn('SUM', sequelize.col('request_size_bytes')), 'total_request_bytes'],
      [sequelize.fn('SUM', sequelize.col('response_size_bytes')), 'total_response_bytes']
    ],
    raw: true
  });

  return stats[0];
};

/**
 * Get daily usage breakdown
 * @param {string} partnerId - Partner ID
 * @param {string} billingPeriod - Billing period (YYYY-MM)
 * @returns {Promise<Array>} Daily usage breakdown
 */
PartnerUsageTracking.getDailyBreakdown = async function(partnerId, billingPeriod) {
  return await this.findAll({
    where: {
      partner_id: partnerId,
      billing_period: billingPeriod
    },
    attributes: [
      [sequelize.fn('DATE', sequelize.col('request_timestamp')), 'date'],
      [sequelize.fn('COUNT', sequelize.col('id')), 'requests'],
      [sequelize.fn('AVG', sequelize.col('response_time_ms')), 'avg_response_time']
    ],
    group: [sequelize.fn('DATE', sequelize.col('request_timestamp'))],
    order: [[sequelize.fn('DATE', sequelize.col('request_timestamp')), 'ASC']],
    raw: true
  });
};

/**
 * Get top endpoints by usage
 * @param {string} partnerId - Partner ID
 * @param {string} billingPeriod - Billing period (YYYY-MM)
 * @param {number} limit - Number of top endpoints to return
 * @returns {Promise<Array>} Top endpoints
 */
PartnerUsageTracking.getTopEndpoints = async function(partnerId, billingPeriod, limit = 10) {
  return await this.findAll({
    where: {
      partner_id: partnerId,
      billing_period: billingPeriod
    },
    attributes: [
      'endpoint',
      [sequelize.fn('COUNT', sequelize.col('id')), 'request_count'],
      [sequelize.fn('AVG', sequelize.col('response_time_ms')), 'avg_response_time']
    ],
    group: ['endpoint'],
    order: [[sequelize.literal('COUNT(id)'), 'DESC']],
    limit: limit,
    raw: true
  });
};

module.exports = PartnerUsageTracking;
