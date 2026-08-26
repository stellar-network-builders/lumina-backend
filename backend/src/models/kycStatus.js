const logger = require('../utils/logger');
const { DataTypes } = require('sequelize');
const { sequelize } = require('../database/connection');

/**
 * KycStatus - Model for tracking KYC/AML verification status and expiration
 * 
 * This model monitors the expiration_date of user's SEP-12 KYC status,
 * tracks compliance notifications, and manages soft-lock mechanisms
 * for ongoing due diligence requirements.
 */
const KycStatus = sequelize.define('KycStatus', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_address: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'User wallet address',
  },
  sep12_customer_id: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'SEP-12 customer ID from Stellar KYC service',
  },
  kyc_status: {
    type: DataTypes.ENUM('VERIFIED', 'PENDING', 'REJECTED', 'EXPIRED', 'SOFT_LOCKED'),
    allowNull: false,
    defaultValue: 'PENDING',
    comment: 'Current KYC verification status',
  },
  kyc_level: {
    type: DataTypes.ENUM('BASIC', 'ENHANCED', 'INSTITUTIONAL'),
    allowNull: false,
    defaultValue: 'BASIC',
    comment: 'KYC verification level',
  },
  verification_date: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Date when KYC was last verified',
  },
  expiration_date: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'KYC status expiration date',
  },
  days_until_expiration: {
    type: DataTypes.VIRTUAL,
    get() {
      if (!this.expiration_date) return null;
      const now = new Date();
      const expiration = new Date(this.expiration_date);
      const diffTime = expiration - now;
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      return diffDays;
    },
    comment: 'Calculated days until expiration',
  },
  is_expiring_soon: {
    type: DataTypes.VIRTUAL,
    get() {
      const days = this.days_until_expiration;
      return days !== null && days <= 7 && days > 0;
    },
    comment: 'Whether KYC is expiring within 7 days',
  },
  is_expired: {
    type: DataTypes.VIRTUAL,
    get() {
      const days = this.days_until_expiration;
      return days !== null && days <= 0;
    },
    comment: 'Whether KYC status has expired',
  },
  risk_score: {
    type: DataTypes.DECIMAL(3, 2),
    allowNull: false,
    defaultValue: 0.00,
    comment: 'Risk assessment score (0.00-1.00)',
  },
  risk_level: {
    type: DataTypes.ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'),
    allowNull: false,
    defaultValue: 'LOW',
    comment: 'Risk level based on assessment',
  },
  last_screening_date: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Date of last AML screening',
  },
  next_screening_date: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Scheduled next AML screening date',
  },
  soft_lock_enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'Whether soft-lock is enabled for this user',
  },
  soft_lock_reason: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Reason for soft-lock activation',
  },
  soft_lock_date: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Date when soft-lock was applied',
  },
  notifications_sent: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: [],
    comment: 'Track sent notifications with timestamps',
  },
  last_notification_date: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Date of last notification sent',
  },
  notification_preferences: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: {
      email: true,
      push: true,
      sms: false,
      in_app: true
    },
    comment: 'User notification preferences',
  },
  verification_provider: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'stellar',
    comment: 'KYC verification provider (stellar, chainalysis, etc.)',
  },
  provider_reference_id: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Reference ID from verification provider',
  },
  sep12_response_data: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Raw SEP-12 API response data',
  },
  compliance_notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Internal compliance notes and observations',
  },
  manual_review_required: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: 'Whether manual compliance review is required',
  },
  manual_review_date: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Date when manual review was last performed',
  },
  reviewed_by: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Admin who performed manual review',
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    comment: 'Whether this KYC record is active',
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'kyc_statuses',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      fields: ['user_address'],
      unique: true
    },
    {
      fields: ['kyc_status'],
    },
    {
      fields: ['expiration_date'],
    },
    {
      fields: ['risk_level'],
    },
    {
      fields: ['soft_lock_enabled'],
    },
    {
      fields: ['verification_provider'],
    },
    {
      fields: ['sep12_customer_id'],
    },
    {
      fields: ['is_active'],
    },
  ],
});

// Instance methods
KycStatus.prototype.updateKycStatus = async function({
  kycStatus,
  kycLevel,
  verificationDate,
  expirationDate,
  riskScore,
  riskLevel,
  sep12ResponseData,
  providerReferenceId,
  complianceNotes
}) {
  const updates = {};
  
  if (kycStatus !== undefined) updates.kyc_status = kycStatus;
  if (kycLevel !== undefined) updates.kyc_level = kycLevel;
  if (verificationDate !== undefined) updates.verification_date = verificationDate;
  if (expirationDate !== undefined) updates.expiration_date = expirationDate;
  if (riskScore !== undefined) updates.risk_score = riskScore;
  if (riskLevel !== undefined) updates.risk_level = riskLevel;
  if (sep12ResponseData !== undefined) updates.sep12_response_data = sep12ResponseData;
  if (providerReferenceId !== undefined) updates.provider_reference_id = providerReferenceId;
  if (complianceNotes !== undefined) updates.compliance_notes = complianceNotes;
  
  updates.updated_at = new Date();
  
  await this.update(updates);
  return this;
};

KycStatus.prototype.applySoftLock = async function(reason = 'KYC status expiring soon') {
  await this.update({
    kyc_status: 'SOFT_LOCKED',
    soft_lock_enabled: true,
    soft_lock_reason: reason,
    soft_lock_date: new Date(),
    updated_at: new Date()
  });
  
  logger.info(`Soft-lock applied to user ${this.user_address}: ${reason}`);
  return this;
};

KycStatus.prototype.removeSoftLock = async function(reason = 'KYC status updated') {
  await this.update({
    kyc_status: 'VERIFIED',
    soft_lock_enabled: false,
    soft_lock_reason: null,
    soft_lock_date: null,
    compliance_notes: `Soft-lock removed: ${reason}. ${this.compliance_notes || ''}`,
    updated_at: new Date()
  });
  
  logger.info(`Soft-lock removed for user ${this.user_address}: ${reason}`);
  return this;
};

KycStatus.prototype.addNotification = async function(type, message) {
  const notifications = this.notifications_sent || [];
  notifications.push({
    type,
    message,
    sent_at: new Date(),
    days_until_expiration: this.days_until_expiration
  });
  
  await this.update({
    notifications_sent: notifications,
    last_notification_date: new Date(),
    updated_at: new Date()
  });
  
  return this;
};

KycStatus.prototype.requiresReverification = function() {
  return this.is_expiring_soon || this.is_expired || this.kyc_status === 'SOFT_LOCKED';
};

KycStatus.prototype.canClaim = function() {
  return this.kyc_status === 'VERIFIED' && !this.is_expired && !this.soft_lock_enabled;
};

KycStatus.prototype.getComplianceStatus = function() {
  const daysUntilExpiration = this.days_until_expiration;
  
  if (this.kyc_status === 'SOFT_LOCKED') {
    return {
      status: 'SOFT_LOCKED',
      canClaim: false,
      urgency: 'CRITICAL',
      message: 'Claims temporarily locked due to compliance requirements',
      action: 'Complete re-verification immediately'
    };
  }
  
  if (this.is_expired) {
    return {
      status: 'EXPIRED',
      canClaim: false,
      urgency: 'CRITICAL',
      message: 'KYC verification has expired',
      action: 'Complete re-verification immediately'
    };
  }
  
  if (this.is_expiring_soon) {
    const urgency = daysUntilExpiration <= 3 ? 'CRITICAL' : 'HIGH';
    return {
      status: 'EXPIRING_SOON',
      canClaim: daysUntilExpiration > 3, // Allow claims if more than 3 days
      urgency,
      message: `KYC verification expires in ${daysUntilExpiration} days`,
      action: 'Complete re-verification before expiration'
    };
  }
  
  if (this.kyc_status === 'VERIFIED') {
    return {
      status: 'VERIFIED',
      canClaim: true,
      urgency: 'LOW',
      message: 'KYC verification is current',
      action: 'Monitor for expiration'
    };
  }
  
  return {
    status: this.kyc_status,
    canClaim: false,
    urgency: 'HIGH',
    message: 'KYC verification required',
    action: 'Complete KYC verification process'
  };
};

// Class methods
KycStatus.findByUserAddress = async function(userAddress) {
  return await this.findOne({
    where: { 
      user_address: userAddress,
      is_active: true 
    }
  });
};

KycStatus.createKycStatus = async function({
  userAddress,
  sep12CustomerId,
  kycStatus = 'PENDING',
  kycLevel = 'BASIC',
  verificationDate,
  expirationDate,
  riskScore = 0.00,
  riskLevel = 'LOW',
  verificationProvider = 'stellar',
  providerReferenceId,
  sep12ResponseData,
  notificationPreferences
}) {
  return await this.create({
    user_address: userAddress,
    sep12_customer_id: sep12CustomerId,
    kyc_status: kycStatus,
    kyc_level: kycLevel,
    verification_date: verificationDate,
    expiration_date: expirationDate,
    risk_score: riskScore,
    risk_level: riskLevel,
    verification_provider: verificationProvider,
    provider_reference_id: providerReferenceId,
    sep12_response_data: sep12ResponseData,
    notification_preferences: notificationPreferences || {
      email: true,
      push: true,
      sms: false,
      in_app: true
    }
  });
};

KycStatus.findExpiringSoon = async function(daysThreshold = 7) {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() + daysThreshold);
  
  return await this.findAll({
    where: {
      expiration_date: {
        [require('sequelize').Op.lte]: thresholdDate
      },
      kyc_status: {
        [require('sequelize').Op.notIn]: ['EXPIRED', 'SOFT_LOCKED']
      },
      is_active: true
    },
    order: [['expiration_date', 'ASC']]
  });
};

KycStatus.findExpired = async function() {
  const now = new Date();
  
  return await this.findAll({
    where: {
      expiration_date: {
        [require('sequelize').Op.lte]: now
      },
      kyc_status: {
        [require('sequelize').Op.notIn]: ['EXPIRED', 'SOFT_LOCKED']
      },
      is_active: true
    },
    order: [['expiration_date', 'ASC']]
  });
};

KycStatus.findSoftLocked = async function() {
  return await this.findAll({
    where: {
      soft_lock_enabled: true,
      is_active: true
    },
    order: [['soft_lock_date', 'DESC']]
  });
};

KycStatus.getComplianceStatistics = async function() {
  const totalUsers = await this.count({ where: { is_active: true } });
  const verifiedUsers = await this.count({ 
    where: { kyc_status: 'VERIFIED', is_active: true } 
  });
  const softLockedUsers = await this.count({ 
    where: { soft_lock_enabled: true, is_active: true } 
  });
  const expiringSoonUsers = await this.count({
    where: {
      expiration_date: {
        [require('sequelize').Op.lte]: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      },
      kyc_status: {
        [require('sequelize').Op.notIn]: ['EXPIRED', 'SOFT_LOCKED']
      },
      is_active: true
    }
  });
  
  const riskBreakdown = await this.findAll({
    attributes: [
      'risk_level',
      [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']
    ],
    where: { is_active: true },
    group: ['risk_level'],
    raw: true
  });

  const statusBreakdown = await this.findAll({
    attributes: [
      'kyc_status',
      [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count']
    ],
    where: { is_active: true },
    group: ['kyc_status'],
    raw: true
  });

  return {
    totalUsers,
    verifiedUsers,
    softLockedUsers,
    expiringSoonUsers,
    complianceRate: totalUsers > 0 ? ((verifiedUsers / totalUsers) * 100).toFixed(2) : '0.00',
    riskBreakdown: riskBreakdown.reduce((acc, item) => {
      acc[item.risk_level] = parseInt(item.count);
      return acc;
    }, {}),
    statusBreakdown: statusBreakdown.reduce((acc, item) => {
      acc[item.kyc_status] = parseInt(item.count);
      return acc;
    }, {})
  };
};

// Add association method
KycStatus.associate = function (models) {
  // Add associations if needed
  // For example, association with User model if it exists
};

module.exports = KycStatus;
