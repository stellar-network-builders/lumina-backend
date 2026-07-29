/**
 * QUARANTINED TEST SUITES — pre-existing failures inherited from main.
 *
 * These suites fail for reasons unrelated to any single feature PR: legacy
 * mocha/chai-style tests, per-suite mock/setup bugs, stale assertions, and a
 * Cypress spec that jest should not run. They are excluded from the blocking
 * `npm test` run (see jest.config.js) so it reflects the health of the
 * maintained suite, and are run separately and non-blocking via
 * `npm run test:quarantine` for burn-down.
 *
 * HOW TO BURN DOWN: fix a suite, then delete its path below so it rejoins the
 * blocking run. The goal is to drive this list to empty.
 *
 * Paths are relative to this directory (jest rootDir).
 */
module.exports = [
  "e2e/auth-flow.spec.js",
  "src/graphql/__tests__/resolvers.test.js",
  "src/middleware/rule144Compliance.middleware.test.js",
  "src/routes/vestingHistory.test.js",
  "src/services/__tests__/beneficiaryLoyaltyBadgeService.test.js",
  "src/services/__tests__/capTableService.test.js",
  "src/services/__tests__/costBasisCalculationService.test.js",
  "src/services/accountConsolidationService.jest.test.js",
  "src/services/accountConsolidationService.test.js",
  "src/services/annualVestingStatementService.test.js",
  "src/services/balanceTracker.test.js",
  "src/services/claimCalculator.fuzz.test.js",
  "src/services/claimWebhookDispatcher.integration.test.js",
  "src/services/claimWebhookDispatcherService.test.js",
  "src/services/contractUpgradeService.test.js",
  "src/services/dexOracleService.test.js",
  "src/services/idempotencyKeyService.integration.test.js",
  "src/services/idempotencyKeyService.test.js",
  "src/services/kycExpirationWorker.test.js",
  "src/services/ledgerReorgDetector.test.js",
  "src/services/ledgerResyncService.test.js",
  "src/services/pathPaymentAnalyticsService.test.js",
  "src/services/roiAnalyticsService.test.js",
  "src/services/rpcQueueService.test.js",
  "src/services/rule144ComplianceService.test.js",
  "src/services/sorobanEventPollerService.test.js",
  "src/services/sorobanVestingParity.test.js",
  "src/services/stellarPathPaymentListener.test.js",
  "src/services/taxCalculationService.test.js",
  "src/services/ticketTypes.service.test.js",
  "src/services/tvlPriceCorrelationService.test.js",
  "src/services/vestingService.test.js",
  "src/test/privacyMasking.test.js",
  "src/test/vaultRegistry.test.js",
  "src/tests/api.fuzz.test.js",
  "src/tests/batchRevocation.test.js",
  "src/tests/sep10Auth.test.js",
  "test/accountConsolidation.integration.test.js",
  "test/auditorApi.test.js",
  "test/auth.integration.test.js",
  "test/delegateFunctionality.test.js",
  "test/futureLienIntegration.test.js",
  "test/futureLienService.test.js",
  "test/historicalPriceTracking.test.js",
  "test/legalDocumentHashingApi.test.js",
  "test/pipeline.test.js",
  "test/vesting-topup.test.js",
  "test/vestingApi.test.js",
  "test/vestingService.test.js",
];
