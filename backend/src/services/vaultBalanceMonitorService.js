const logger = require('../utils/logger');
const crypto = require('crypto');
const { Vault, SubSchedule, VaultBalanceMonitorState } = require('../models');
const BalanceTracker = require('./balanceTracker');
const criticalAlertService = require('./criticalAlertService');

class VaultBalanceMonitorService {
  constructor({
    balanceTracker = new BalanceTracker(),
    alertService = criticalAlertService,
    now = () => new Date(),
  } = {}) {
    this.balanceTracker = balanceTracker;
    this.alertService = alertService;
    this.now = now;
    this.targetVaultAddress = process.env.VAULT_BALANCE_MONITOR_VAULT_ADDRESS || '';
    this.targetTokenAddress = process.env.VAULT_BALANCE_MONITOR_TOKEN_ADDRESS || '';
    this.discrepancyTolerance = this.parseNumber(
      process.env.VAULT_BALANCE_MONITOR_TOLERANCE,
      0
    );
  }

  isEnabled() {
    return process.env.VAULT_BALANCE_MONITOR_ENABLED !== 'false';
  }

  async runCheck() {
    const startedAt = this.now();
    const result = {
      checked: 0,
      discrepancies: 0,
      alertsSent: 0,
      duplicateAlertsSuppressed: 0,
      errors: 0,
      startedAt: startedAt.toISOString(),
    };

    const vaults = await this.getTargetVaults();

    for (const vault of vaults) {
      result.checked += 1;

      try {
        const check = await this.checkVaultBalance(vault, startedAt);

        if (check.isDiscrepancy) {
          result.discrepancies += 1;

          if (check.alertSent) {
            result.alertsSent += 1;
          } else if (check.alertSuppressed) {
            result.duplicateAlertsSuppressed += 1;
          }
        }
      } catch (error) {
        result.errors += 1;
        logger.error(`Vault balance monitoring failed for ${vault.address}:`, error);
        await this.recordErrorState(vault, error, startedAt);
      }
    }

    logger.info(
      `Vault balance monitor completed. Checked ${result.checked} vault(s), ` +
        `${result.discrepancies} discrepancy(ies), ${result.alertsSent} alert(s), ${result.errors} error(s).`
    );

    return result;
  }

  async getTargetVaults() {
    const where = {
      is_active: true,
      is_blacklisted: false,
    };

    if (this.targetVaultAddress) {
      where.address = this.targetVaultAddress;
    }

    return Vault.findAll({
      where,
      include: [
        {
          model: SubSchedule,
          as: 'subSchedules',
          required: false,
          where: {
            is_active: true,
          },
          attributes: [
            'id',
            'top_up_amount',
            'amount_withdrawn',
            'cumulative_claimed_amount',
            'cliff_date',
            'vesting_start_date',
            'vesting_duration',
            'end_timestamp',
          ],
        },
      ],
      order: [['created_at', 'ASC']],
    });
  }

  async checkVaultBalance(vault, asOfDate = this.now()) {
    const tokenAddress = this.targetTokenAddress || vault.token_address;
    const onChainBalance = await this.balanceTracker.getActualBalance(
      tokenAddress,
      vault.address
    );
    const parsedOnChainBalance = this.parseRequiredNumber(
      onChainBalance,
      `on-chain balance for vault ${vault.address}`
    );
    const expectedBalances = this.calculateExpectedBalances(
      vault.subSchedules || [],
      asOfDate
    );
    const rawDifference =
      expectedBalances.expectedUnvestedBalance - parsedOnChainBalance;
    const absoluteDifference = Math.abs(rawDifference);
    const isDiscrepancy = absoluteDifference > this.discrepancyTolerance;
    const differenceDirection = rawDifference > 0 ? 'shortfall' : 'surplus';
    const state = await this.findOrCreateState(vault, tokenAddress);

    const checkPayload = {
      vaultId: vault.id,
      vaultAddress: vault.address,
      tokenAddress,
      onChainBalance: this.toDecimalString(parsedOnChainBalance),
      expectedUnvestedBalance: this.toDecimalString(expectedBalances.expectedUnvestedBalance),
      expectedUnclaimedBalance: this.toDecimalString(expectedBalances.expectedUnclaimedBalance),
      difference: this.toDecimalString(rawDifference),
      absoluteDifference: this.toDecimalString(absoluteDifference),
      differenceDirection,
      timestamp: asOfDate.toISOString(),
      checkedSchedules: expectedBalances.checkedSchedules,
    };

    if (!isDiscrepancy) {
      await state.update({
        status: 'healthy',
        last_checked_at: asOfDate,
        last_discrepancy_signature: null,
        token_address: tokenAddress,
        last_on_chain_balance: checkPayload.onChainBalance,
        last_expected_unvested_balance: checkPayload.expectedUnvestedBalance,
        last_expected_unclaimed_balance: checkPayload.expectedUnclaimedBalance,
        last_difference: checkPayload.difference,
        last_error_message: null,
      });

      logger.info(
        `Vault ${vault.address} balance verified. ` +
          `On-chain ${checkPayload.onChainBalance}, expected unvested ${checkPayload.expectedUnvestedBalance}.`
      );

      return { isDiscrepancy: false, alertSent: false, alertSuppressed: false, payload: checkPayload };
    }

    const discrepancySignature = this.createDiscrepancySignature(checkPayload);
    const shouldAlert =
      state.status !== 'discrepancy' ||
      state.last_discrepancy_signature !== discrepancySignature;

    let alertSent = false;
    if (shouldAlert) {
      const alertResult = await this.alertService.sendVaultBalanceDiscrepancyAlert(checkPayload);
      alertSent = alertResult.sent;
    } else {
      logger.warn(
        `Vault ${vault.address} discrepancy unchanged. Suppressing duplicate alert for signature ${discrepancySignature}.`
      );
    }

    await state.update({
      status: 'discrepancy',
      last_checked_at: asOfDate,
      last_alerted_at: alertSent ? asOfDate : state.last_alerted_at,
      last_discrepancy_signature: discrepancySignature,
      token_address: tokenAddress,
      last_on_chain_balance: checkPayload.onChainBalance,
      last_expected_unvested_balance: checkPayload.expectedUnvestedBalance,
      last_expected_unclaimed_balance: checkPayload.expectedUnclaimedBalance,
      last_difference: checkPayload.difference,
      last_error_message: null,
    });

    logger.error(
      `Vault balance discrepancy detected for ${vault.address}. ` +
        `On-chain ${checkPayload.onChainBalance}, expected unvested ${checkPayload.expectedUnvestedBalance}, ` +
        `${differenceDirection} ${checkPayload.absoluteDifference}.`
    );

    return {
      isDiscrepancy: true,
      alertSent,
      alertSuppressed: !shouldAlert,
      payload: checkPayload,
    };
  }

  calculateExpectedBalances(subSchedules, asOfDate = this.now()) {
    let expectedUnvestedBalance = 0;
    let expectedUnclaimedBalance = 0;

    for (const schedule of subSchedules) {
      const totalAmount = this.parseNumber(schedule.top_up_amount, 0);
      const cumulativeClaimed = this.parseNumber(
        schedule.cumulative_claimed_amount ?? schedule.amount_withdrawn,
        0
      );
      const vestedAmount = this.calculateVestedAmount(schedule, asOfDate);

      expectedUnvestedBalance += Math.max(0, totalAmount - vestedAmount);
      expectedUnclaimedBalance += Math.max(0, totalAmount - cumulativeClaimed);
    }

    return {
      expectedUnvestedBalance,
      expectedUnclaimedBalance,
      checkedSchedules: subSchedules.length,
    };
  }

  calculateVestedAmount(schedule, asOfDate = this.now()) {
    const totalAmount = this.parseNumber(schedule.top_up_amount, 0);
    const vestingStartDate = schedule.vesting_start_date
      ? new Date(schedule.vesting_start_date)
      : null;
    const cliffDate = schedule.cliff_date ? new Date(schedule.cliff_date) : null;
    const vestingDuration = Number(schedule.vesting_duration || 0);

    if (cliffDate && asOfDate < cliffDate) {
      return 0;
    }

    if (!vestingStartDate || asOfDate < vestingStartDate) {
      return 0;
    }

    if (vestingDuration <= 0) {
      return totalAmount;
    }

    const vestingEndDate = schedule.end_timestamp
      ? new Date(schedule.end_timestamp)
      : new Date(vestingStartDate.getTime() + vestingDuration * 1000);

    if (asOfDate >= vestingEndDate) {
      return totalAmount;
    }

    const elapsedSeconds = Math.max(
      0,
      (asOfDate.getTime() - vestingStartDate.getTime()) / 1000
    );

    return Math.min(totalAmount, (elapsedSeconds * totalAmount) / vestingDuration);
  }

  async recordErrorState(vault, error, asOfDate) {
    try {
      const state = await this.findOrCreateState(
        vault,
        this.targetTokenAddress || vault.token_address
      );

      await state.update({
        status: 'error',
        last_checked_at: asOfDate,
        token_address: this.targetTokenAddress || vault.token_address,
        last_error_message: error.message,
      });
    } catch (stateError) {
      logger.error(
        `Failed to persist vault balance monitor error state for ${vault.address}:`,
        stateError
      );
    }
  }

  async findOrCreateState(vault, tokenAddress) {
    const [state] = await VaultBalanceMonitorState.findOrCreate({
      where: {
        vault_id: vault.id,
      },
      defaults: {
        vault_id: vault.id,
        token_address: tokenAddress,
      },
    });

    return state;
  }

  createDiscrepancySignature(payload) {
    return crypto
      .createHash('sha256')
      .update(
        [
          payload.vaultAddress,
          payload.tokenAddress,
          payload.onChainBalance,
          payload.expectedUnvestedBalance,
          payload.absoluteDifference,
        ].join(':')
      )
      .digest('hex');
  }

  parseNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  parseRequiredNumber(value, label) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid numeric value for ${label}: ${value}`);
    }

    return parsed;
  }

  toDecimalString(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return '0';
    }

    return parsed.toFixed(18).replace(/\.?0+$/, '');
  }
}

module.exports = VaultBalanceMonitorService;
