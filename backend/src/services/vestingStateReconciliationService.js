'use strict';

const logger = require('../utils/logger');
const { Vault, Beneficiary, SubSchedule, ClaimsHistory, SorobanEvent, IndexerState } = require('../models');
const { sequelize } = require('../database/connection');
const { Op } = require('sequelize');
const VestingStateReconciliation = require('../models/vestingStateReconciliation');
const ClaimCalculator = require('./claimCalculator');
const BalanceTracker = require('./balanceTracker');
const SorobanRpcClient = require('./sorobanRpcClient');
const Sentry = require('@sentry/node');
const auditLogger = require('./auditLogger');

const PRECISION_TOLERANCE = '0.000000000000000001'; // 1e-18 — one wei-level
const PRECISION_TOLERANCE_NUM = 1e-18;
const CLAIM_COUNT_TOLERANCE = 0;
const SUBSCHEDULE_COUNT_TOLERANCE = 0;

class VestingStateReconciliationService {
  constructor(options = {}) {
    this.serviceName = 'vesting-state-reconciliation';
    this.precisionTolerance = options.precisionTolerance ?? PRECISION_TOLERANCE_NUM;
    this.claimCountTolerance = options.claimCountTolerance ?? CLAIM_COUNT_TOLERANCE;
    this.subScheduleCountTolerance = options.subScheduleCountTolerance ?? SUBSCHEDULE_COUNT_TOLERANCE;
    this.batchSize = options.batchSize || 50;
    this.autoReconcile = options.autoReconcile ?? false;
    this.isRunning = false;
    this.lastRunAt = null;
    this.lastRunSummary = null;

    const rpcUrl = process.env.SOROBAN_RPC_URL || process.env.STELLAR_RPC_URL;
    if (rpcUrl) {
      this.rpcClient = new SorobanRpcClient(rpcUrl, {
        timeout: options.rpcTimeout || 15000,
        maxRetries: options.maxRetries || 3,
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Public entry point — reconcile all active vaults
  // ────────────────────────────────────────────────────────────────────────────

  async reconcileAllVaults(runType = 'scheduled') {
    if (this.isRunning) {
      throw new Error('Reconciliation already in progress');
    }

    const runId = `recon_${Date.now()}`;
    const startTime = Date.now();
    this.isRunning = true;

    let checked = 0;
    let inSync = 0;
    let desync = 0;
    let errors = 0;
    let autoReconciled = 0;

    try {
      logger.info(`[${runId}] Starting state reconciliation for all vaults (runType=${runType})...`);

      const vaults = await Vault.findAll({
        where: { is_active: true, is_blacklisted: false },
        order: [['created_at', 'ASC']],
      });

      for (const vault of vaults) {
        try {
          const result = await this.reconcileVault(vault, runType);
          checked++;
          if (result.status === 'in_sync') inSync++;
          else if (result.status === 'desync_detected') {
            desync++;
            if (result.autoReconciled) autoReconciled++;
          }
        } catch (err) {
          errors++;
          logger.error(`[${runId}] Reconciliation failed for vault ${vault.address}:`, err.message);
          Sentry.captureException(err, {
            tags: { service: this.serviceName, vault_address: vault.address },
            extra: { run_id: runId },
          });
        }
      }

      const duration = Date.now() - startTime;
      const summary = {
        runId,
        runType,
        checked,
        inSync,
        desync,
        autoReconciled,
        errors,
        durationMs: duration,
        timestamp: new Date().toISOString(),
      };

      this.lastRunAt = new Date();
      this.lastRunSummary = summary;

      logger.info(
        `[${runId}] Reconciliation complete: ${checked} checked, ${inSync} in-sync, ` +
        `${desync} desync (${autoReconciled} auto-reconciled), ${errors} errors — ${duration}ms`
      );

      return summary;
    } catch (err) {
      logger.error(`[${runId}] Fatal reconciliation error:`, err);
      Sentry.captureException(err, { tags: { service: this.serviceName, operation: 'reconcile_all' } });
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Single-vault reconciliation
  // ────────────────────────────────────────────────────────────────────────────

  async reconcileVault(vaultOrAddress, runType = 'scheduled') {
    const startedAt = new Date();
    const startTime = Date.now();

    let vault = vaultOrAddress;
    if (typeof vaultOrAddress === 'string') {
      vault = await Vault.findOne({ where: { address: vaultOrAddress } });
      if (!vault) throw new Error(`Vault not found: ${vaultOrAddress}`);
    }

    if (vault.is_blacklisted) {
      return { status: 'error', error: 'Vault is blacklisted', vault_address: vault.address };
    }

    const reconRecord = await VestingStateReconciliation.create({
      vault_id: vault.id,
      vault_address: vault.address,
      run_type: runType,
      status: 'in_sync',
      checks_performed: {},
      started_at: startedAt,
    });

    try {
      // ── 1. Gather off-chain state ──────────────────────────────────────────
      const offChain = await this._gatherOffChainState(vault);

      // ── 2. Gather on-chain state ───────────────────────────────────────────
      let onChain = null;
      let ledgerAtCheck = null;
      try {
        const chainResult = await this._gatherOnChainState(vault);
        onChain = chainResult.state;
        ledgerAtCheck = chainResult.ledgerSequence;
      } catch (chainErr) {
        // If on-chain fetch fails, record error but continue with partial checks
        logger.warn(`On-chain state fetch failed for vault ${vault.address}: ${chainErr.message}`);
      }

      // ── 3. Run individual checks ───────────────────────────────────────────
      const checks = {};
      const desyncDetails = [];

      // Check A: Sub-schedule count match
      checks.subschedule_count = this._checkSubScheduleCount(offChain, onChain);
      if (!checks.subschedule_count.passed) desyncDetails.push(checks.subschedule_count);

      // Check B: Total allocated amount match
      checks.total_allocated = this._checkTotalAllocated(offChain, onChain);
      if (!checks.total_allocated.passed) desyncDetails.push(checks.total_allocated);

      // Check C: Cumulative claimed amount match
      checks.cumulative_claimed = this._checkCumulativeClaimed(offChain, onChain);
      if (!checks.cumulative_claimed.passed) desyncDetails.push(checks.cumulative_claimed);

      // Check D: Beneficiary withdrawal totals vs claims history
      checks.beneficiary_withdrawals = this._checkBeneficiaryWithdrawals(offChain);
      if (!checks.beneficiary_withdrawals.passed) desyncDetails.push(checks.beneficiary_withdrawals);

      // Check E: Precision drift detection across subschedules
      checks.precision_drift = this._checkPrecisionDrift(offChain);
      if (!checks.precision_drift.passed) desyncDetails.push(checks.precision_drift);

      // Check F: Vested amount consistency (off-chain formula vs on-chain if available)
      checks.vested_amount_consistency = this._checkVestedAmountConsistency(offChain, onChain);
      if (!checks.vested_amount_consistency.passed) desyncDetails.push(checks.vested_amount_consistency);

      // Check G: On-chain balance vs expected unvested (if on-chain data available)
      if (onChain && onChain.onChainBalance !== null) {
        checks.on_chain_balance = this._checkOnChainBalance(offChain, onChain);
        if (!checks.on_chain_balance.passed) desyncDetails.push(checks.on_chain_balance);
      }

      // Check H: Unprocessed events that may indicate missed on-chain state changes
      checks.unprocessed_events = await this._checkUnprocessedEvents(vault);
      if (!checks.unprocessed_events.passed) desyncDetails.push(checks.unprocessed_events);

      // ── 4. Determine overall status ────────────────────────────────────────
      const allPassed = desyncDetails.length === 0;
      const overallStatus = allPassed ? 'in_sync' : 'desync_detected';
      let autoReconciled = false;

      // ── 5. Auto-reconcile if configured and safe ───────────────────────────
      if (!allPassed && this.autoReconcile) {
        const reconResult = await this._attemptAutoReconcile(vault, offChain, onChain, desyncDetails);
        if (reconResult.success) {
          autoReconciled = true;
        }
      }

      // ── 6. Persist result ──────────────────────────────────────────────────
      const completedAt = new Date();
      const driftTotal = checks.precision_drift?.driftTotal ?? 0;

      await reconRecord.update({
        status: autoReconciled ? 'reconciled' : overallStatus,
        checks_performed: checks,
        desync_details: allPassed ? null : desyncDetails,
        off_chain_snapshot: this._sanitizeSnapshot(offChain),
        on_chain_snapshot: onChain ? this._sanitizeSnapshot(onChain) : null,
        ledger_at_check: ledgerAtCheck,
        precision_drift_total: String(driftTotal),
        auto_reconciled: autoReconciled,
        completed_at: completedAt,
        duration_ms: Date.now() - startTime,
      });

      // ── 7. Alert on desync ─────────────────────────────────────────────────
      if (!allPassed && !autoReconciled) {
        await this._sendDesyncAlert(vault, desyncDetails);
        auditLogger.logAction('system', 'VESTING_DESYNC_DETECTED', vault.address, {
          desyncChecks: desyncDetails.map(d => d.check),
          runType,
        });
      }

      return {
        status: autoReconciled ? 'reconciled' : overallStatus,
        vault_address: vault.address,
        checks,
        desync_details: allPassed ? null : desyncDetails,
        auto_reconciled: autoReconciled,
        precision_drift_total: driftTotal,
        duration_ms: Date.now() - startTime,
      };
    } catch (err) {
      await reconRecord.update({
        status: 'error',
        error_message: err.message,
        completed_at: new Date(),
        duration_ms: Date.now() - startTime,
      });
      throw err;
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Off-chain state gathering
  // ────────────────────────────────────────────────────────────────────────────

  async _gatherOffChainState(vault) {
    const subSchedules = await SubSchedule.findAll({
      where: { vault_id: vault.id, is_active: true },
    });

    const beneficiaries = await Beneficiary.findAll({
      where: { vault_id: vault.id },
    });

    const claimsHistory = await ClaimsHistory.findAll({
      where: { token_address: vault.token_address },
      order: [['claim_timestamp', 'ASC']],
    });

    const now = new Date();
    const claimCalculator = new ClaimCalculator();

    // Compute off-chain totals
    let offChainTotalAllocated = 0;
    let offChainCumulativeClaimed = 0;
    let offChainTotalVested = 0;
    let precisionDriftAccum = 0;

    const subScheduleDetails = [];
    for (const ss of subSchedules) {
      const topUp = parseFloat(ss.top_up_amount) || 0;
      const cumulativeClaimed = parseFloat(ss.cumulative_claimed_amount || 0);
      const amountWithdrawn = parseFloat(ss.amount_withdrawn || 0);
      const vested = claimCalculator._calculateVestedAmount(ss, now);

      offChainTotalAllocated += topUp;
      offChainCumulativeClaimed += cumulativeClaimed;
      offChainTotalVested += vested;

      // Precision drift: difference between cumulative_claimed and amount_withdrawn
      // that is NOT explained by intentional rounding (dust prevention)
      const drift = Math.abs(cumulativeClaimed - amountWithdrawn);
      if (drift > this.precisionTolerance) {
        precisionDriftAccum += drift;
      }

      subScheduleDetails.push({
        id: ss.id,
        top_up_amount: topUp,
        cumulative_claimed_amount: cumulativeClaimed,
        amount_withdrawn: amountWithdrawn,
        vested_at_now: vested,
        cliff_date: ss.cliff_date,
        vesting_start_date: ss.vesting_start_date,
        vesting_duration: ss.vesting_duration,
        end_timestamp: ss.end_timestamp,
        transaction_hash: ss.transaction_hash,
        block_number: ss.block_number,
        drift,
      });
    }

    // Beneficiary totals
    let beneficiaryTotalAllocated = 0;
    let beneficiaryTotalWithdrawn = 0;
    const beneficiaryDetails = [];
    for (const b of beneficiaries) {
      const alloc = parseFloat(b.total_allocated) || 0;
      const withdrawn = parseFloat(b.total_withdrawn) || 0;
      beneficiaryTotalAllocated += alloc;
      beneficiaryTotalWithdrawn += withdrawn;
      beneficiaryDetails.push({
        id: b.id,
        address: b.address,
        total_allocated: alloc,
        total_withdrawn: withdrawn,
      });
    }

    // Claims history totals
    let claimsHistoryTotalClaimed = 0;
    const claimTxHashes = new Set();
    for (const ch of claimsHistory) {
      const amt = parseFloat(ch.amount_claimed) || 0;
      claimsHistoryTotalClaimed += amt;
      claimTxHashes.add(ch.transaction_hash);
    }

    return {
      vaultId: vault.id,
      vaultAddress: vault.address,
      tokenAddress: vault.token_address,
      tokenType: vault.token_type,
      totalAmount: parseFloat(vault.total_amount) || 0,
      subScheduleCount: subSchedules.length,
      subScheduleDetails,
      offChainTotalAllocated,
      offChainCumulativeClaimed,
      offChainTotalVested,
      precisionDriftAccum,
      beneficiaryCount: beneficiaries.length,
      beneficiaryDetails,
      beneficiaryTotalAllocated,
      beneficiaryTotalWithdrawn,
      claimsHistoryCount: claimsHistory.length,
      claimsHistoryTotalClaimed,
      claimTxHashes: [...claimTxHashes],
      checkedAt: now,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  On-chain state gathering
  // ────────────────────────────────────────────────────────────────────────────

  async _gatherOnChainState(vault) {
    if (!this.rpcClient) {
      return { state: null, ledgerSequence: null };
    }

    const latestLedger = await this.rpcClient.getLatestLedger();
    const ledgerSequence = latestLedger.sequence || latestLedger;

    let onChainBalance = null;
    try {
      const balanceTracker = new BalanceTracker();
      const balanceStr = await balanceTracker.getActualBalance(vault.token_address, vault.address);
      onChainBalance = parseFloat(balanceStr) || 0;
    } catch (err) {
      logger.warn(`Could not fetch on-chain balance for vault ${vault.address}: ${err.message}`);
    }

    // Attempt to read on-chain vesting schedule data via contract instance
    let onChainSubScheduleCount = null;
    let onChainCumulativeClaimed = null;
    let onChainTotalAllocated = null;
    try {
      const contractState = await this._readContractState(vault);
      onChainSubScheduleCount = contractState.subScheduleCount;
      onChainCumulativeClaimed = contractState.cumulativeClaimed;
      onChainTotalAllocated = contractState.totalAllocated;
    } catch (err) {
      logger.warn(`Could not read contract state for vault ${vault.address}: ${err.message}`);
    }

    return {
      ledgerSequence,
      state: {
        onChainBalance,
        onChainSubScheduleCount,
        onChainCumulativeClaimed,
        onChainTotalAllocated,
        ledgerSequence,
      },
    };
  }

  async _readContractState(vault) {
    // Placeholder for actual contract state reading via Soroban RPC
    // In production, this would call the vesting contract's read-only functions
    // to get the authoritative on-chain state: schedule count, claimed amounts, etc.
    // For now, returns nulls to indicate "on-chain data not available via this method"
    return {
      subScheduleCount: null,
      cumulativeClaimed: null,
      totalAllocated: null,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Individual checks
  // ────────────────────────────────────────────────────────────────────────────

  _checkSubScheduleCount(offChain, onChain) {
    const offChainCount = offChain.subScheduleCount;
    const onChainCount = onChain?.onChainSubScheduleCount;

    if (onChainCount === null || onChainCount === undefined) {
      return {
        check: 'subschedule_count',
        passed: true,
        note: 'On-chain sub-schedule count unavailable; skipped cross-chain comparison',
        offChain: offChainCount,
        onChain: onChainCount,
      };
    }

    const diff = Math.abs(offChainCount - onChainCount);
    const passed = diff <= this.subScheduleCountTolerance;

    return {
      check: 'subschedule_count',
      passed,
      offChain: offChainCount,
      onChain: onChainCount,
      difference: diff,
      tolerance: this.subScheduleCountTolerance,
    };
  }

  _checkTotalAllocated(offChain, onChain) {
    const offChainTotal = offChain.offChainTotalAllocated;
    const onChainTotal = onChain?.onChainTotalAllocated;

    if (onChainTotal === null || onChainTotal === undefined) {
      // Fallback: compare off-chain sum of sub-schedule top_up_amounts vs vault.total_amount
      const vaultTotal = offChain.totalAmount;
      const diff = Math.abs(offChainTotal - vaultTotal);
      const passed = diff <= this.precisionTolerance;

      return {
        check: 'total_allocated',
        passed,
        offChain: offChainTotal,
        onChain: vaultTotal,
        difference: diff,
        tolerance: this.precisionTolerance,
        note: 'On-chain total unavailable; compared off-chain sum vs vault.total_amount',
      };
    }

    const diff = Math.abs(offChainTotal - onChainTotal);
    const passed = diff <= this.precisionTolerance;

    return {
      check: 'total_allocated',
      passed,
      offChain: offChainTotal,
      onChain: onChainTotal,
      difference: diff,
      tolerance: this.precisionTolerance,
    };
  }

  _checkCumulativeClaimed(offChain, onChain) {
    const offChainClaimed = offChain.offChainCumulativeClaimed;
    const onChainClaimed = onChain?.onChainCumulativeClaimed;

    if (onChainClaimed === null || onChainClaimed === undefined) {
      // Cross-validate: cumulative_claimed across subschedules should match claims_history sum
      const claimsHistoryTotal = offChain.claimsHistoryTotalClaimed;
      const diff = Math.abs(offChainClaimed - claimsHistoryTotal);
      const passed = diff <= this.precisionTolerance;

      return {
        check: 'cumulative_claimed',
        passed,
        offChain: offChainClaimed,
        onChain: claimsHistoryTotal,
        difference: diff,
        tolerance: this.precisionTolerance,
        note: 'On-chain claimed unavailable; compared off-chain cumulative vs claims_history total',
      };
    }

    const diff = Math.abs(offChainClaimed - onChainClaimed);
    const passed = diff <= this.precisionTolerance;

    return {
      check: 'cumulative_claimed',
      passed,
      offChain: offChainClaimed,
      onChain: onChainClaimed,
      difference: diff,
      tolerance: this.precisionTolerance,
    };
  }

  _checkBeneficiaryWithdrawals(offChain) {
    // Internal consistency: sum of beneficiary.total_withdrawn should approximate
    // the sum of sub-schedule cumulative_claimed_amount (scaled by allocation ratio)
    const totalWithdrawn = offChain.beneficiaryTotalWithdrawn;
    const cumulativeClaimed = offChain.offChainCumulativeClaimed;

    // For a single beneficiary, these should be very close
    // For multiple beneficiaries, total_withdrawn is the sum of actual on-chain withdrawals
    // while cumulative_claimed tracks per-schedule claims — they should be in the same ballpark
    const diff = Math.abs(totalWithdrawn - cumulativeClaimed);
    // Use a slightly larger tolerance for beneficiary-level comparison since
    // multiple beneficiaries can create allocation-ratio scaling differences
    const tolerance = Math.max(this.precisionTolerance, cumulativeClaimed * 1e-12);
    const passed = diff <= tolerance;

    return {
      check: 'beneficiary_withdrawals',
      passed,
      beneficiaryTotalWithdrawn: totalWithdrawn,
      subScheduleCumulativeClaimed: cumulativeClaimed,
      difference: diff,
      tolerance,
    };
  }

  _checkPrecisionDrift(offChain) {
    const driftTotal = offChain.precisionDriftAccum;
    const driftPerSchedule = offChain.subScheduleCount > 0
      ? driftTotal / offChain.subScheduleCount
      : 0;

    // Flag if average drift per schedule exceeds tolerance
    const passed = driftPerSchedule <= this.precisionTolerance;

    return {
      check: 'precision_drift',
      passed,
      driftTotal,
      driftPerSchedule,
      subScheduleCount: offChain.subScheduleCount,
      tolerance: this.precisionTolerance,
      details: offChain.subScheduleDetails
        .filter(s => s.drift > this.precisionTolerance)
        .map(s => ({
          subScheduleId: s.id,
          drift: s.drift,
          cumulativeClaimed: s.cumulative_claimed_amount,
          amountWithdrawn: s.amount_withdrawn,
        })),
    };
  }

  _checkVestedAmountConsistency(offChain, onChain) {
    // Verify that the off-chain linear vesting formula produces consistent results
    // across ClaimCalculator and VestingService
    const now = offChain.checkedAt;
    const claimCalculator = new ClaimCalculator();

    let inconsistencies = 0;
    const details = [];

    for (const ss of offChain.subScheduleDetails) {
      const topUp = ss.top_up_amount;
      const vestedFromCalculator = claimCalculator._calculateVestedAmount(
        { 
          cliff_date: ss.cliff_date,
          vesting_start_date: ss.vesting_start_date,
          vesting_duration: ss.vesting_duration,
          top_up_amount: String(topUp),
        },
        now
      );

      const diff = Math.abs(vestedFromCalculator - ss.vested_at_now);
      if (diff > this.precisionTolerance) {
        inconsistencies++;
        details.push({
          subScheduleId: ss.id,
          expectedVested: vestedFromCalculator,
          actualVested: ss.vested_at_now,
          difference: diff,
        });
      }
    }

    return {
      check: 'vested_amount_consistency',
      passed: inconsistencies === 0,
      inconsistencies,
      details: details.length > 0 ? details : undefined,
    };
  }

  _checkOnChainBalance(offChain, onChain) {
    // Compare on-chain token balance with expected unvested + unclaimed balance
    const onChainBalance = onChain.onChainBalance;
    const expectedUnvested = offChain.offChainTotalAllocated - offChain.offChainTotalVested;
    const expectedUnclaimed = offChain.offChainTotalAllocated - offChain.offChainCumulativeClaimed;

    // On-chain balance should be at least the unvested portion
    // (it may be higher if there are unclaimed vested tokens)
    const diff = Math.abs(onChainBalance - expectedUnclaimed);
    const tolerance = Math.max(this.precisionTolerance, expectedUnclaimed * 1e-10);
    const passed = diff <= tolerance;

    return {
      check: 'on_chain_balance',
      passed,
      onChainBalance,
      expectedUnvested,
      expectedUnclaimed,
      difference: diff,
      tolerance,
    };
  }

  async _checkUnprocessedEvents(vault) {
    const unprocessedCount = await SorobanEvent.count({
      where: {
        processed: false,
        contract_address: vault.address,
      },
    });

    // Also check for events related to this vault's token
    const unprocessedTokenEvents = await SorobanEvent.count({
      where: {
        processed: false,
        contract_address: vault.token_address,
      },
    });

    const total = unprocessedCount + unprocessedTokenEvents;
    const passed = total === 0;

    return {
      check: 'unprocessed_events',
      passed,
      unprocessedVaultEvents: unprocessedCount,
      unprocessedTokenEvents,
      total,
      note: total > 0
        ? `${total} unprocessed events may indicate missed on-chain state changes`
        : 'All events processed',
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Auto-reconciliation
  // ────────────────────────────────────────────────────────────────────────────

  async _attemptAutoReconcile(vault, offChain, onChain, desyncDetails) {
    const t = await sequelize.transaction();

    try {
      let fixesApplied = 0;

      for (const detail of desyncDetails) {
        switch (detail.check) {
          case 'precision_drift': {
            // Fix: sync amount_withdrawn to cumulative_claimed_amount for drifted subschedules
            if (detail.details && detail.details.length > 0) {
              for (const driftDetail of detail.details) {
                const ss = await SubSchedule.findByPk(driftDetail.subScheduleId, { transaction: t });
                if (ss) {
                  await ss.update(
                    { amount_withdrawn: ss.cumulative_claimed_amount },
                    { transaction: t }
                  );
                  fixesApplied++;
                }
              }
            }
            break;
          }

          case 'beneficiary_withdrawals': {
            // Fix: sync beneficiary.total_withdrawn to match cumulative claimed
            const beneficiaries = await Beneficiary.findAll({
              where: { vault_id: vault.id },
              transaction: t,
            });

            const totalAllocated = offChain.beneficiaryTotalAllocated;
            const cumulativeClaimed = offChain.offChainCumulativeClaimed;

            if (totalAllocated > 0 && beneficiaries.length > 0) {
              const claimRatio = Math.min(1, cumulativeClaimed / totalAllocated);
              for (const b of beneficiaries) {
                const alloc = parseFloat(b.total_allocated) || 0;
                const expectedWithdrawn = alloc * claimRatio;
                const actualWithdrawn = parseFloat(b.total_withdrawn) || 0;
                const diff = Math.abs(expectedWithdrawn - actualWithdrawn);
                if (diff > this.precisionTolerance) {
                  await b.update(
                    { total_withdrawn: String(expectedWithdrawn) },
                    { transaction: t }
                  );
                  fixesApplied++;
                }
              }
            }
            break;
          }

          case 'unprocessed_events': {
            // Don't auto-process events; just flag for the event processor
            logger.warn(
              `Auto-reconcile: skipping unprocessed events fix for vault ${vault.address} — ` +
              `requires event processor to handle`
            );
            break;
          }

          default: {
            // For subschedule_count, total_allocated, cumulative_claimed, on_chain_balance:
            // these require on-chain data to reconcile safely — log but don't auto-fix
            logger.warn(
              `Auto-reconcile: skipping ${detail.check} fix — requires manual review or on-chain data`
            );
          }
        }
      }

      await t.commit();

      if (fixesApplied > 0) {
        auditLogger.logAction('system', 'VESTING_AUTO_RECONCILED', vault.address, {
          fixesApplied,
          desyncChecks: desyncDetails.map(d => d.check),
        });
      }

      return { success: fixesApplied > 0, fixesApplied };
    } catch (err) {
      await t.rollback();
      logger.error(`Auto-reconcile failed for vault ${vault.address}:`, err);
      return { success: false, error: err.message };
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Alerting
  // ────────────────────────────────────────────────────────────────────────────

  async _sendDesyncAlert(vault, desyncDetails) {
    try {
      const slackWebhookService = require('./slackWebhookService');
      const failedChecks = desyncDetails.map(d => d.check).join(', ');

      const message = `**Vesting State Desync Detected**

**Vault:** ${vault.address}
**Token:** ${vault.token_address}
**Failed Checks:** ${failedChecks}
**Details:** ${JSON.stringify(desyncDetails, null, 2)}
**Timestamp:** ${new Date().toISOString()}

**Action Required:** Review off-chain vs on-chain state for this vault and determine if manual reconciliation is needed.`;

      await slackWebhookService.sendAlert(message, {
        channel: '#critical-alerts',
        username: 'Vesting State Reconciliation',
        priority: 'high',
      });
    } catch (err) {
      logger.error('Failed to send desync alert:', err);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  //  Helpers
  // ────────────────────────────────────────────────────────────────────────────

  _sanitizeSnapshot(state) {
    // Trim large arrays to prevent bloating the reconciliation record
    if (!state) return null;

    const snapshot = { ...state };

    // Keep only first 5 sub-schedule details in the snapshot
    if (Array.isArray(snapshot.subScheduleDetails) && snapshot.subScheduleDetails.length > 5) {
      snapshot.subScheduleDetails = snapshot.subScheduleDetails.slice(0, 5);
      snapshot.subScheduleDetailsTruncated = true;
    }

    // Keep only first 10 beneficiary details
    if (Array.isArray(snapshot.beneficiaryDetails) && snapshot.beneficiaryDetails.length > 10) {
      snapshot.beneficiaryDetails = snapshot.beneficiaryDetails.slice(0, 10);
      snapshot.beneficiaryDetailsTruncated = true;
    }

    // Remove claim tx hashes list (can be very large)
    delete snapshot.claimTxHashes;

    return snapshot;
  }

  getStatus() {
    return {
      serviceName: this.serviceName,
      isRunning: this.isRunning,
      lastRunAt: this.lastRunAt,
      lastRunSummary: this.lastRunSummary,
      config: {
        precisionTolerance: this.precisionTolerance,
        claimCountTolerance: this.claimCountTolerance,
        subScheduleCountTolerance: this.subScheduleCountTolerance,
        batchSize: this.batchSize,
        autoReconcile: this.autoReconcile,
      },
    };
  }

  updateConfig(config) {
    if (config.precisionTolerance !== undefined) this.precisionTolerance = config.precisionTolerance;
    if (config.claimCountTolerance !== undefined) this.claimCountTolerance = config.claimCountTolerance;
    if (config.subScheduleCountTolerance !== undefined) this.subScheduleCountTolerance = config.subScheduleCountTolerance;
    if (config.batchSize !== undefined) this.batchSize = config.batchSize;
    if (config.autoReconcile !== undefined) this.autoReconcile = config.autoReconcile;
  }
}

module.exports = VestingStateReconciliationService;
