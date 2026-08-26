const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { RefreshToken } = require('../models');
const { Organization } = require('../models');

class AuthService {
  constructor() {
    this.accessTokenExpiry = '15m'; // Short-lived access token
    this.refreshTokenExpiry = '7d'; // Longer-lived refresh token
    this.saltRounds = 12;
  }

  /**
   * Generate JWT access token
   * @param {string} userAddress - User wallet address
   * @param {string} role - User role (admin/user)
   * @returns {string} JWT token
   */
  generateAccessToken(userAddress, role = 'user') {
    const payload = {
      address: userAddress,
      role: role,
      type: 'access'
    };

    return jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: this.accessTokenExpiry,
      issuer: 'vesting-vault',
      audience: 'vesting-vault-api'
    });
  }

  /**
   * Generate refresh token
   * @param {string} userAddress - User wallet address
   * @returns {string} Refresh token
   */
  generateRefreshToken(userAddress) {
    const payload = {
      address: userAddress,
      type: 'refresh',
      random: Math.random().toString(36).substring(2) // Add randomness
    };

    return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
      expiresIn: this.refreshTokenExpiry,
      issuer: 'vesting-vault',
      audience: 'vesting-vault-api'
    });
  }

  /**
   * Hash refresh token for storage
   * @param {string} token - Refresh token
   * @returns {Promise<string>} Hashed token
   */
  async hashRefreshToken(token) {
    return await bcrypt.hash(token, this.saltRounds);
  }

  /**
   * Verify refresh token against hash
   * @param {string} token - Plain token
   * @param {string} hashedToken - Hashed token from database
   * @returns {Promise<boolean>} Whether token matches
   */
  async verifyRefreshToken(token, hashedToken) {
    return await bcrypt.compare(token, hashedToken);
  }

  /**
   * Create and store refresh token
   * @param {string} userAddress - User wallet address
   * @returns {Promise<{accessToken: string, refreshToken: string}>} Tokens
   */
  async createTokens(userAddress) {
    try {
      // Determine user role
      const role = await this.getUserRole(userAddress);

      // Generate tokens
      const accessToken = this.generateAccessToken(userAddress, role);
      const refreshToken = this.generateRefreshToken(userAddress);

      // Hash refresh token for storage
      const hashedRefreshToken = await this.hashRefreshToken(refreshToken);

      // Calculate expiration date
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days from now

      // Store refresh token in database
      await RefreshToken.create({
        token: hashedRefreshToken,
        user_address: userAddress,
        expires_at: expiresAt,
        is_revoked: false
      });

      return {
        accessToken,
        refreshToken,
        expiresIn: '15m',
        tokenType: 'Bearer'
      };
    } catch (error) {
      logger.error('Error creating tokens:', error);
      throw new Error('Failed to create tokens');
    }
  }

  /**
   * Refresh access token using refresh token
   * @param {string} refreshToken - Refresh token
   * @returns {Promise<{accessToken: string, refreshToken: string}>} New tokens
   */
  async refreshTokens(refreshToken) {
    try {
      // Verify the refresh token
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, {
        issuer: 'vesting-vault',
        audience: 'vesting-vault-api'
      });

      if (decoded.type !== 'refresh') {
        throw new Error('Invalid token type');
      }

      // Find the refresh token in database
      const storedTokens = await RefreshToken.findAll({
        where: {
          user_address: decoded.address,
          is_revoked: false,
          expires_at: {
            [require('sequelize').Op.gt]: new Date()
          }
        },
        order: [['created_at', 'DESC']]
      });

      if (storedTokens.length === 0) {
        throw new Error('No valid refresh token found');
      }

      // Find matching token (check against all recent tokens)
      let matchedToken = null;
      for (const storedToken of storedTokens) {
        const isValid = await this.verifyRefreshToken(refreshToken, storedToken.token);
        if (isValid) {
          matchedToken = storedToken;
          break;
        }
      }

      if (!matchedToken) {
        throw new Error('Invalid refresh token');
      }

      // Revoke the old refresh token (rotation)
      await matchedToken.update({ is_revoked: true });

      // Create new tokens
      return await this.createTokens(decoded.address);
    } catch (error) {
      logger.error('Error refreshing tokens:', error);
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        throw new Error('Invalid or expired refresh token');
      }
      throw error;
    }
  }

  /**
   * Revoke all refresh tokens for a user
   * @param {string} userAddress - User wallet address
   * @returns {Promise<number>} Number of revoked tokens
   */
  async revokeAllUserTokens(userAddress) {
    try {
      const result = await RefreshToken.update(
        { is_revoked: true },
        {
          where: {
            user_address: userAddress,
            is_revoked: false
          }
        }
      );

      return result[0]; // Number of updated rows
    } catch (error) {
      logger.error('Error revoking tokens:', error);
      throw new Error('Failed to revoke tokens');
    }
  }

  /**
   * Clean up expired refresh tokens
   * @returns {Promise<number>} Number of cleaned up tokens
   */
  async cleanupExpiredTokens() {
    try {
      const result = await RefreshToken.destroy({
        where: {
          expires_at: {
            [require('sequelize').Op.lt]: new Date()
          }
        }
      });

      return result;
    } catch (error) {
      logger.error('Error cleaning up expired tokens:', error);
      return 0;
    }
  }

  /**
   * Verify access token
   * @param {string} token - Access token
   * @returns {Promise<object>} Decoded token payload
   */
  async verifyAccessToken(token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: 'vesting-vault',
        audience: 'vesting-vault-api'
      });

      if (decoded.type !== 'access') {
        throw new Error('Invalid token type');
      }

      return decoded;
    } catch (error) {
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        throw new Error('Invalid or expired access token');
      }
      throw error;
    }
  }

  /**
   * Get user role based on organization admin status
   * @param {string} userAddress - User wallet address
   * @returns {Promise<string>} User role ('admin' or 'user')
   */
  async getUserRole(userAddress) {
    try {
      const org = await Organization.findOne({
        where: { admin_address: userAddress }
      });

      return org ? 'admin' : 'user';
    } catch (error) {
      logger.error('Error getting user role:', error);
      return 'user'; // Default to user role on error
    }
  }

  /**
   * Set secure cookie for refresh token
   * @param {object} res - Express response object
   * @param {string} refreshToken - Refresh token
   */
  setRefreshTokenCookie(res, refreshToken) {
    const cookieOptions = {
      httpOnly: true, // Prevent client-side JavaScript access
      secure: process.env.NODE_ENV === 'production', // Only send over HTTPS
      sameSite: 'Strict', // Prevent CSRF
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in milliseconds
      path: '/api/auth/refresh' // Only accessible by refresh endpoint
    };

    res.cookie('refreshToken', refreshToken, cookieOptions);
  }

  /**
   * Clear refresh token cookie
   * @param {object} res - Express response object
   */
  clearRefreshTokenCookie(res) {
    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      path: '/api/auth/refresh'
    });
  }

  /**
   * Get refresh token from cookie
   * @param {object} req - Express request object
   * @returns {string|null} Refresh token or null
   */
  getRefreshTokenFromCookie(req) {
    return req.cookies?.refreshToken || null;
  }

  /**
   * Extract token from Authorization header
   * @param {object} req - Express request object
   * @returns {string|null} Token or null
   */
  extractTokenFromHeader(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return null;
  }

  /**
   * Authentication middleware for Express
   * @param {boolean} requireAdmin - Whether admin access is required
   * @returns {function} Middleware function
   */
  authenticate(requireAdmin = false) {
    return async (req, res, next) => {
      try {
        const token = this.extractTokenFromHeader(req);
        
        if (!token) {
          return res.status(401).json({
            success: false,
            error: 'Access token required'
          });
        }

        const decoded = await this.verifyAccessToken(token);

        if (requireAdmin && decoded.role !== 'admin') {
          return res.status(403).json({
            success: false,
            error: 'Admin access required'
          });
        }

        // Add user info to request
        req.user = {
          address: decoded.address,
          role: decoded.role
        };

        next();
      } catch (error) {
        return res.status(401).json({
          success: false,
          error: error.message || 'Authentication failed'
        });
      }
    };
  }
}

module.exports = new AuthService();
