// Utility to check if admin_address belongs to org_id
const logger = require('../utils/logger');
const isAdminOfOrg = async (adminAddress, orgId) => {
  if (!adminAddress || !orgId) return false;
  try {
    const models = require('../../models');
    const org = await models.Organization.findOne({
      where: { id: orgId, admin_address: adminAddress }
    });
    return !!org;
  } catch (err) {
    logger.error('Error in isAdminOfOrg:', err);
    return false;
  }
};

const MOCK_USERS = {
  '0x1234567890123456789012345678901234567890': {
    address: '0x1234567890123456789012345678901234567890',
    role: 'admin'
  },
  '0x9876543210987654321098765432109876543210': {
    address: '0x9876543210987654321098765432109876543210',
    role: 'user'
  }
};

const extractUserFromRequest = (req) => {
  if (!req || !req.headers) return null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    if (token === 'admin-token') {
      return MOCK_USERS['0x1234567890123456789012345678901234567890'];
    }
    if (token === 'user-token') {
      return MOCK_USERS['0x9876543210987654321098765432109876543210'];
    }
  }

  const userAddress = req.headers['x-user-address'];
  if (userAddress) {
    return MOCK_USERS[userAddress] || {
      address: userAddress,
      role: 'user'
    };
  }

  return null;
};

const authMiddleware = (options = {}) => {
  return async (resolve, parent, args, context, info) => {
    const { requireAuth = false, requireAdmin = false, allowedOperations = [] } = options;
    const user = context.user || extractUserFromRequest(context.req);
    context.user = user;

    if (requireAuth && !user) {
      throw new Error('Authentication required. Please provide valid credentials.');
    }

    if (requireAdmin && (!user || user.role !== 'admin')) {
      throw new Error('Admin access required for this operation.');
    }

    if (allowedOperations.length > 0 && user) {
      const operationName = info.operation.operation === 'mutation' 
        ? info.fieldName 
        : `${info.operation.operation}.${info.fieldName}`;
      
      const isAllowed = allowedOperations.some(allowedOp => 
        operationName.includes(allowedOp)
      );

      if (!isAllowed && user.role !== 'admin') {
        throw new Error(`Operation '${operationName}' is not allowed for your role.`);
      }
    }

    args.user = user;
    return resolve(parent, args, context, info);
  };
};

const roleBasedAccess = {
  public: authMiddleware({ requireAuth: false }),
  user: authMiddleware({ requireAuth: true }),
  admin: authMiddleware({ requireAuth: true, requireAdmin: true }),
  selfService: authMiddleware({ 
    requireAuth: true,
    allowedOperations: ['beneficiary', 'withdraw', 'claims']
  }),
  readOnly: authMiddleware({ 
    requireAuth: false,
    allowedOperations: ['Query']
  })
};

const canAccessVault = async (userAddress, vaultAddress) => {
  if (!userAddress) return { canAccess: false, role: null };
  try {
    const models = require('../../models');
    const vault = await models.Vault.findOne({
      where: { address: vaultAddress, owner_address: userAddress }
    });
    if (vault) return { canAccess: true, role: 'owner' };

    const beneficiary = await models.Beneficiary.findOne({
      where: { address: userAddress },
      include: [{
        model: models.Vault,
        as: 'vault',
        where: { address: vaultAddress }
      }]
    });
    if (beneficiary) return { canAccess: true, role: 'beneficiary' };

    const user = MOCK_USERS[userAddress];
    if (user && user.role === 'admin') return { canAccess: true, role: 'admin' };

    return { canAccess: false, role: null };
  } catch (error) {
    logger.error('Error checking vault access:', error);
    return { canAccess: false, role: null };
  }
};

const vaultAccessMiddleware = async (resolve, parent, args, context, info) => {
  const user = context.user;
  if (!user) throw new Error('Authentication required to access vault data.');

  let vaultAddress = args.address || args.vaultAddress || args.input?.vaultAddress;
  if (vaultAddress) {
    const access = await canAccessVault(user.address, vaultAddress);
    if (!access.canAccess) throw new Error('Access denied. You do not have permission to access this vault.');
    context.vaultAccessRole = access.role;
  }
  return resolve(parent, args, context, info);
};

const getRateLimitForUser = (user) => {
  if (!user) return 10;
  switch (user.role) {
    case 'admin': return 1000;
    case 'user': return 100;
    default: return 50;
  }
};

module.exports = {
  isAdminOfOrg,
  authMiddleware,
  roleBasedAccess,
  canAccessVault,
  vaultAccessMiddleware,
  getRateLimitForUser
};
