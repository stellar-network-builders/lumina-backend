const logger = require('../utils/logger');
const TaxJurisdiction = require('../models/taxJurisdiction');

/**
 * TaxOracleService
 * Integrates with external tax oracles to fetch real-time tax brackets.
 */
class TaxOracleService {
  /**
   * Fetches the applicable tax rate for a specific jurisdiction and amount.
   */
  async getApplicableTaxRate(jurisdictionCode, amountUsd, eventType) {
    const jurisdiction = await TaxJurisdiction.getByCode(jurisdictionCode);
    if (!jurisdiction) throw new Error(`Jurisdiction ${jurisdictionCode} not supported.`);

    // 1. Try Primary Oracle (e.g., TaxBit)
    try {
      return await this._fetchFromTaxBit(jurisdictionCode, amountUsd, eventType);
    } catch (error) {
      logger.warn(`TaxBit Oracle failed for ${jurisdictionCode}, trying secondary...`);
    }

    // 2. Try Secondary Oracle (e.g., CoinTracker)
    try {
      return await this._fetchFromCoinTracker(jurisdictionCode, amountUsd, eventType);
    } catch (error) {
      logger.warn(`CoinTracker Oracle failed, falling back to internal rules.`);
    }

    // 3. Internal Fallback
    // Using the instance method from the TaxJurisdiction model provided in context
    return {
      rate: jurisdiction.getTaxRate(amountUsd),
      source: 'INTERNAL_FALLBACK'
    };
  }

  /**
   * Fetches the applicable tax rates for a specific jurisdiction.
   */
  async getTaxRates(jurisdictionCode, amountUsd, eventType) {
    const rateInfo = await this.getApplicableTaxRate(jurisdictionCode, amountUsd, eventType);
    return {
      provider: rateInfo.source,
      data: {
        tax_rate: rateInfo.rate,
        tax_treatment: 'INCOME', // Default
        filing_deadline: new Date(new Date().getFullYear() + 1, 3, 15)
      }
    };
  }

  /**
   * Calculates tax liability using oracle logic.
   */
  async calculateTaxLiability(jurisdictionCode, amountUsd, eventType) {
    const rateInfo = await this.getApplicableTaxRate(jurisdictionCode, amountUsd, eventType);
    return {
      provider: rateInfo.source,
      data: {
        tax_liability: (amountUsd * (rateInfo.rate / 100)),
        tax_rate_percent: rateInfo.rate,
        taxable_income: amountUsd
      }
    };
  }

  /**
   * Fetches withholding requirements for a jurisdiction.
   */
  async getWithholdingRequirements(jurisdictionCode) {
    return {
      provider: 'internal',
      data: {
        withholding_required: jurisdictionCode === 'US' ? false : true,
        default_withholding_rate: 20.0
      }
    };
  }

  async _fetchFromTaxBit(jurisdictionCode, amountUsd, eventType) {
    // Mocking API call: if (process.env.TAXBIT_API_KEY) { ... }
    throw new Error('Not implemented'); 
  }

  async _fetchFromCoinTracker(jurisdictionCode, amountUsd, eventType) {
    // Mocking API call: if (process.env.COINTRACKER_API_KEY) { ... }
    throw new Error('Not implemented');
  }
}

module.exports = new TaxOracleService();