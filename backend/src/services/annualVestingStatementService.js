const logger = require('../utils/logger');
const { AnnualVestingStatement, Vault, SubSchedule, ClaimsHistory, Token, Organization, Beneficiary } = require('../models');
const { Op } = require('sequelize');
const priceService = require('./priceService');
const annualStatementPDFService = require('./annualStatementPDFService');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Sentry = require('@sentry/node');

class AnnualVestingStatementService {
  constructor() {
    this.transparencyKey = process.env.TRANSPARENCY_PRIVATE_KEY;
    this.transparencyPublicKey = process.env.TRANSPARENCY_PUBLIC_KEY;
    
    if (!this.transparencyKey || !this.transparencyPublicKey) {
      throw new Error('TRANSPARENCY_PRIVATE_KEY and TRANSPARENCY_PUBLIC_KEY environment variables are required');
    }
  }

  /**
   * Generate annual vesting statement for a user
   * @param {string} userAddress - User wallet address
   * @param {number} year - Statement year
   * @returns {Promise<Object>} Generated statement data
   */
  async generateAnnualStatement(userAddress, year) {
    try {
      logger.info(`Generating annual statement for ${userAddress} for year ${year}`);
      
      // Check if statement already exists
      const existingStatement = await AnnualVestingStatement.getStatementByUserAndYear(userAddress, year);
      if (existingStatement) {
        logger.info(`Statement already exists for ${userAddress} year ${year}`);
        return existingStatement;
      }

      // Get all vaults for the user
      const userVaults = await this.getUserVaults(userAddress);
      
      // Aggregate vesting data for the year
      const statementData = await this.aggregateVestingData(userAddress, userVaults, year);
      
      // Generate PDF
      const pdfBuffer = await this.generateStatementPDF(statementData, year);
      
      // Digitally sign the PDF
      const digitalSignature = await this.signPDF(pdfBuffer);
      
      // Save PDF to storage
      const filePath = await this.savePDFToStorage(pdfBuffer, userAddress, year);
      
      // Create statement record
      const statement = await AnnualVestingStatement.create({
        user_address: userAddress,
        year: year,
        statement_data: statementData,
        pdf_file_path: filePath,
        digital_signature: digitalSignature,
        transparency_key_public_address: this.transparencyPublicKey,
        total_vested_amount: statementData.summary.totalVestedAmount,
        total_claimed_amount: statementData.summary.totalClaimedAmount,
        total_unclaimed_amount: statementData.summary.totalUnclaimedAmount,
        total_fmv_usd: statementData.summary.totalFMVUSD,
        total_realized_gains_usd: statementData.summary.totalRealizedGainsUSD,
        number_of_vaults: statementData.summary.numberOfVaults,
        number_of_claims: statementData.summary.numberOfClaims,
      });

      logger.info(`Successfully generated annual statement for ${userAddress} year ${year}`);
      return statement;
      
    } catch (error) {
      logger.error(`Error generating annual statement for ${userAddress} year ${year}:`, error);
      Sentry.captureException(error, {
        tags: { service: 'annual-statement' },
        extra: { userAddress, year }
      });
      throw error;
    }
  }

  /**
   * Get all vaults for a user
   * @param {string} userAddress - User wallet address
   * @returns {Promise<Array>} Array of vaults with related data
   */
  async getUserVaults(userAddress) {
    // Get vaults through beneficiary relationship
    const beneficiaries = await Beneficiary.findAll({
      where: { address: userAddress },
      include: [
        {
          model: Vault,
          as: 'vault',
          include: [
            {
              model: SubSchedule,
              as: 'subSchedules',
            },
            {
              model: Token,
              as: 'token',
            },
            {
              model: Organization,
              as: 'organization',
            },
          ],
        },
      ],
    });

    // Extract vaults from beneficiaries
    return beneficiaries.map(beneficiary => beneficiary.vault);
  }

  /**
   * Aggregate vesting data for a specific year
   * @param {string} userAddress - User wallet address
   * @param {Array} vaults - User vaults
   * @param {number} year - Statement year
   * @returns {Promise<Object>} Aggregated statement data
   */
  async aggregateVestingData(userAddress, vaults, year) {
    const startDate = new Date(year, 0, 1); // January 1st
    const endDate = new Date(year, 11, 31, 23, 59, 59); // December 31st
    
    const statementData = {
      userAddress,
      year,
      period: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      },
      vaults: [],
      summary: {
        totalVestedAmount: '0',
        totalClaimedAmount: '0',
        totalUnclaimedAmount: '0',
        totalFMVUSD: '0',
        totalRealizedGainsUSD: '0',
        numberOfVaults: vaults.length,
        numberOfClaims: 0,
      },
      claims: [],
      monthlyBreakdown: [],
    };

    // Process each vault
    for (const vault of vaults) {
      const vaultData = await this.processVaultForYear(vault, year, startDate, endDate);
      statementData.vaults.push(vaultData);
      
      // Update summary
      statementData.summary.totalVestedAmount = this.addDecimal(
        statementData.summary.totalVestedAmount,
        vaultData.totalVestedAmount
      );
      statementData.summary.totalClaimedAmount = this.addDecimal(
        statementData.summary.totalClaimedAmount,
        vaultData.totalClaimedAmount
      );
      statementData.summary.totalUnclaimedAmount = this.addDecimal(
        statementData.summary.totalUnclaimedAmount,
        vaultData.totalUnclaimedAmount
      );
      statementData.summary.totalFMVUSD = this.addDecimal(
        statementData.summary.totalFMVUSD,
        vaultData.totalFMVUSD
      );
      statementData.summary.totalRealizedGainsUSD = this.addDecimal(
        statementData.summary.totalRealizedGainsUSD,
        vaultData.totalRealizedGainsUSD
      );
      statementData.summary.numberOfClaims += vaultData.claims.length;
      
      // Add claims to statement
      statementData.claims.push(...vaultData.claims);
    }

    // Generate monthly breakdown
    statementData.monthlyBreakdown = await this.generateMonthlyBreakdown(userAddress, year);

    return statementData;
  }

  /**
   * Process a single vault for the given year
   * @param {Object} vault - Vault object
   * @param {number} year - Statement year
   * @param {Date} startDate - Year start date
   * @param {Date} endDate - Year end date
   * @returns {Promise<Object>} Vault data for the year
   */
  async processVaultForYear(vault, year, startDate, endDate) {
    // Get claims for this vault within the year
    const claims = await ClaimsHistory.findAll({
      where: {
        token_address: vault.token_address,
        claim_timestamp: {
          [Op.between]: [startDate, endDate],
        },
      },
      order: [['claim_timestamp', 'ASC']],
    });

    // Get token prices for FMV calculation
    const yearEndPrice = await priceService.getTokenPrice(vault.token_address, endDate);
    
    // Calculate vesting progress
    const vestingCalculations = await this.calculateVestingProgress(vault, endDate);

    return {
      vault: {
        id: vault.id,
        name: vault.name,
        address: vault.address,
        token: vault.token,
        organization: vault.organization,
      },
      totalVestedAmount: vestingCalculations.totalVestedAmount,
      totalClaimedAmount: claims.reduce((sum, claim) => 
        this.addDecimal(sum, claim.amount_claimed), '0'
      ),
      totalUnclaimedAmount: this.subtractDecimal(
        vestingCalculations.totalVestedAmount,
        claims.reduce((sum, claim) => 
          this.addDecimal(sum, claim.amount_claimed), '0'
        )
      ),
      totalFMVUSD: this.multiplyDecimal(
        vestingCalculations.totalVestedAmount,
        yearEndPrice
      ),
      totalRealizedGainsUSD: this.calculateRealizedGains(claims, yearEndPrice),
      claims: claims.map(claim => ({
        ...claim.toJSON(),
        fmv_usd_at_claim: claim.price_at_claim_usd,
        realized_gain_usd: this.calculateClaimGain(claim, yearEndPrice),
      })),
      vestingSchedule: vestingCalculations,
    };
  }

  /**
   * Calculate vesting progress for a vault at a specific date
   * @param {Object} vault - Vault object
   * @param {Date} asOfDate - Date to calculate as of
   * @returns {Promise<Object>} Vesting calculations
   */
  async calculateVestingProgress(vault, asOfDate) {
    // This would integrate with your existing vesting calculation logic
    // For now, returning a placeholder structure
    return {
      totalVestedAmount: '0', // TODO: Calculate based on your vesting logic
      totalAllocation: vault.total_amount,
      vestingPercentage: '0',
      remainingToVest: vault.total_amount,
      cliffDate: null, // TODO: cliff date from schedule
      vestingEndDate: null, // TODO: end date from schedule
    };
  }

  /**
   * Calculate realized gains for claims
   * @param {Array} claims - Claims array
   * @param {number} yearEndPrice - Year end token price
   * @returns {string} Total realized gains
   */
  calculateRealizedGains(claims, yearEndPrice) {
    return claims.reduce((total, claim) => 
      this.addDecimal(total, this.calculateClaimGain(claim, yearEndPrice)), '0'
    );
  }

  /**
   * Calculate gain for a single claim
   * @param {Object} claim - Claim object
   * @param {number} yearEndPrice - Year end token price
   * @returns {string} Gain amount
   */
  calculateClaimGain(claim, yearEndPrice) {
    // This would be based on cost basis tracking
    // For now, using claim price as basis
    const claimValue = parseFloat(claim.amount_claimed) * parseFloat(claim.price_at_claim_usd || 0);
    const currentValue = parseFloat(claim.amount_claimed) * yearEndPrice;
    return (currentValue - claimValue).toString();
  }

  /**
   * Generate monthly breakdown for the year
   * @param {string} userAddress - User address
   * @param {number} year - Statement year
   * @returns {Promise<Array>} Monthly breakdown data
   */
  async generateMonthlyBreakdown(userAddress, year) {
    const monthlyData = [];
    
    for (let month = 0; month < 12; month++) {
      const monthStart = new Date(year, month, 1);
      const monthEnd = new Date(year, month + 1, 0, 23, 59, 59);
      
      const monthClaims = await ClaimsHistory.findAll({
        where: {
          user_address: userAddress,
          claim_timestamp: {
            [Op.between]: [monthStart, monthEnd],
          },
        },
      });

      monthlyData.push({
        month: month + 1,
        monthName: monthStart.toLocaleString('default', { month: 'long' }),
        claims: monthClaims.length,
        totalClaimed: monthClaims.reduce((sum, claim) => 
          this.addDecimal(sum, claim.amount_claimed), '0'
        ),
        totalUSD: monthClaims.reduce((sum, claim) => {
          const claimValue = parseFloat(claim.amount_claimed) * parseFloat(claim.price_at_claim_usd || 0);
          return this.addDecimal(sum, claimValue.toString()), '0';
        }, '0'),
      });
    }
    
    return monthlyData;
  }

  /**
   * Generate PDF for the statement
   * @param {Object} statementData - Statement data
   * @param {number} year - Statement year
   * @returns {Promise<Buffer>} PDF buffer
   */
  async generateStatementPDF(statementData, year) {
    // This will be implemented in the enhanced PDF service
    return await pdfService.generateAnnualStatement(statementData, year);
  }

  /**
   * Digitally sign PDF with transparency key
   * @param {Buffer} pdfBuffer - PDF buffer
   * @returns {Promise<string>} Digital signature
   */
  async signPDF(pdfBuffer) {
    try {
      const hash = crypto.createHash('sha256').update(pdfBuffer).digest();
      const signature = crypto.sign('sha256', hash, this.transparencyKey);
      return signature.toString('base64');
    } catch (error) {
      logger.error('Error signing PDF:', error);
      throw new Error('Failed to sign PDF');
    }
  }

  /**
   * Save PDF to storage
   * @param {Buffer} pdfBuffer - PDF buffer
   * @param {string} userAddress - User address
   * @param {number} year - Statement year
   * @returns {Promise<string>} File path
   */
  async savePDFToStorage(pdfBuffer, userAddress, year) {
    const fileName = `annual-statement-${userAddress}-${year}.pdf`;
    const filePath = path.join(process.env.PDF_STORAGE_PATH || './statements', fileName);
    
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(filePath, pdfBuffer);
    return filePath;
  }

  /**
   * Get statement for user
   * @param {string} userAddress - User address
   * @param {number} year - Statement year
   * @returns {Promise<Object>} Statement object
   */
  async getStatement(userAddress, year) {
    const statement = await AnnualVestingStatement.getStatementByUserAndYear(userAddress, year);
    
    if (!statement) {
      throw new Error(`Statement not found for ${userAddress} year ${year}`);
    }
    
    // Mark as accessed
    await statement.markAsAccessed();
    
    return statement;
  }

  /**
   * Get all statements for a user
   * @param {string} userAddress - User address
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Statements with pagination
   */
  async getUserStatements(userAddress, options = {}) {
    return await AnnualVestingStatement.getUserStatements(userAddress, options);
  }

  /**
   * Verify statement signature
   * @param {string} userAddress - User address
   * @param {number} year - Statement year
   * @param {string} signature - Signature to verify
   * @param {Buffer} pdfBuffer - Original PDF buffer
   * @returns {Promise<boolean>} Verification result
   */
  async verifyStatementSignature(userAddress, year, signature, pdfBuffer) {
    try {
      const statement = await AnnualVestingStatement.getStatementByUserAndYear(userAddress, year);
      
      if (!statement || statement.digital_signature !== signature) {
        return false;
      }
      
      const hash = crypto.createHash('sha256').update(pdfBuffer).digest();
      const isValid = crypto.verify('sha256', hash, statement.transparency_key_public_address, Buffer.from(signature, 'base64'));
      
      return isValid;
    } catch (error) {
      logger.error('Error verifying signature:', error);
      return false;
    }
  }

  // Utility methods for decimal arithmetic
  addDecimal(a, b) {
    const numA = parseFloat(a) || 0;
    const numB = parseFloat(b) || 0;
    return (numA + numB).toString();
  }

  subtractDecimal(a, b) {
    const numA = parseFloat(a) || 0;
    const numB = parseFloat(b) || 0;
    return (numA - numB).toString();
  }

  multiplyDecimal(a, b) {
    const numA = parseFloat(a) || 0;
    const numB = parseFloat(b) || 0;
    return (numA * numB).toString();
  }
}

module.exports = new AnnualVestingStatementService();
