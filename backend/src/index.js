// Initialize OpenTelemetry tracing first - must be imported before any other modules
const { initializeTracing } = require('./tracing/tracing');
initializeTracing();

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { strictCors, helmetMiddleware } = require('./middleware/security.middleware');
const http = require('http');
const { rateLimit } = require('express-rate-limit');
const { walletRateLimitMiddleware } = require('./middleware/wallet-ratelimit.middleware');
const { smartCompression } = require('./middleware/compression.middleware');
const { paginateWithCursor, validateCursorParams } = require('./services/cursorPaginationService');

const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');

// Import swagger documentation
const swaggerUi = require("swagger-ui-express");
const swaggerSpecs = require("./swagger/options");

// Initialize OpenTelemetry BEFORE everything else
require("./services/telemetryService");

// Import Metrics and Queue services
const metricsService = require("./services/metricsService");
const { metricsMiddleware } = require("./middleware/metrics.middleware");
const { globalRateLimiter, authRateLimiter } = require("./middleware/rateLimit.middleware");
// Background job manager: BullMQ queues with retry/backoff, dead-letter queues,
// stalled-job detection and DLQ monitoring/alerting.
const backgroundJobManager = require("./workers/backgroundJobManager");
backgroundJobManager.init();


dotenv.config();

// Keep the HTTP server alive when a background service (Soroban RPC poller,
// path-payment listener, indexing jobs, etc.) throws asynchronously. Without
// these handlers an unhandled rejection terminates the whole process in modern
// Node, taking the API down with it.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (continuing):', reason && reason.message ? reason.message : reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception (continuing):', error && error.message ? error.message : error);
});

const app = express();

// --- NestJS Integration Start ---
let throttlerService;
let pdfQueue;
let exportQueue;

const initNest = async () => {
  const nestApp = await bootstrapNest(app);
  throttlerService = nestApp.get(ThrottlerService);
  pdfQueue = nestApp.get(getQueueToken('pdf-generation'));
  exportQueue = nestApp.get(getQueueToken('csv-export'));

  // Expose queues to app for use in routes
  app.set('pdfQueue', pdfQueue);
  app.set('exportQueue', exportQueue);

  console.log('NestJS bridge established');
};

// Global rate limiting middleware using NestJS Throttler
app.use(async (req, res, next) => {
  if (!throttlerService) {
    // If NestJS isn't ready yet, skip throttling (or wait)
    return next();
  }

  const ip = req.ip || req.get('x-forwarded-for') || req.socket.remoteAddress;
  const isAuth = req.path.includes('/api/auth/');

  try {
    const limit = isAuth ? 10 : 100;
    const ttl = 60000;
    const key = `throttle:${isAuth ? 'auth' : 'global'}:${ip}`;

    const { success } = await throttlerService.throttle({
      limit,
      ttl,
      key,
    });

    if (!success) {
      return res.status(429).json({
        success: false,
        error: "Too many requests. Please try again later.",
      });
    }
    next();
  } catch (e) {
    console.error("Throttler error:", e);
    next();
  }
});
// --- NestJS Integration End ---

Sentry.init({
  // Fallback to a dummy DSN so Sentry SDK doesn't disable itself when testing without credentials
  dsn: process.env.SENTRY_DSN || "http://public_key@localhost:9999/1",
  debug: process.env.NODE_ENV !== "test", // Output sentry operations to console (disable in production/test)
  environment: process.env.NODE_ENV || "development",
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 1.0, // 100% of transactions for performance monitoring
  profilesSampleRate: 1.0, // 100% of transactions are profiled
});

const PORT = process.env.PORT || 4000;

const httpServer = http.createServer(app);

// Initialize Vesting Update WebSocket Server (Deferred to startServer)
// const VestingUpdateWebSocket = require('./websocket/vesting-update.websocket');
// const vestingUpdateWebSocket = new VestingUpdateWebSocket(httpServer);

// Sentry request handler must be the first middleware (only if Sentry is properly configured)
if (process.env.SENTRY_DSN && Sentry.Handlers) {
  app.use(Sentry.Handlers.requestHandler());
  app.use(Sentry.Handlers.tracingHandler());
}

// OpenTelemetry tracing middleware - applies to all routes
const { tracingMiddleware } = require("./middleware/tracing.middleware");
app.use(tracingMiddleware);

// Security: Helmet (CSP, HSTS, X-Frame-Options, …) + strict CORS (Issue #260)
app.use(helmetMiddleware);
app.use(strictCors);
app.use(express.json());
app.use(require("cookie-parser")());

// Apply metrics middleware
app.use(metricsMiddleware);

// Apply global rate limiting
app.use(globalRateLimiter);

// Apply strict rate limiting to auth routes
app.use("/api/auth", authRateLimiter);


// Apply smart compression to all API routes (compresses JSON >1KB)
app.use('/api', smartCompression);

// Apply wallet-based rate limiting to all API routes
app.use("/api", walletRateLimitMiddleware);

// Import and apply vault pause middleware
const {
  vaultPauseMiddleware,
  vaultStatusMiddleware,
} = require("./middleware/vaultPause.middleware");

// Import and apply Rule 144 compliance middleware
const {
  rule144ComplianceMiddleware,
  recordClaimComplianceMiddleware
} = require('./middleware/rule144Compliance.middleware');

// Apply vault status middleware to all API routes
app.use("/api", vaultStatusMiddleware);

// Apply vault pause middleware to vault-specific endpoints
app.use("/api/vaults", vaultPauseMiddleware);
app.use("/api/claims", vaultPauseMiddleware);
app.use("/api/user", vaultPauseMiddleware);
app.use("/api/admin/vault", vaultPauseMiddleware);

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpecs));

const claimRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1,
  message: {
    success: false,
    error: "Too many claim requests. Please wait 1 minute before trying again.",
  },
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

const { getSequelize } = require('./database/connection');
const secretsService = require('./services/secretsService');
const models = require('./models');
const { OrganizationWebhook } = models;
// Register webhook URL for organization
// For now, let's create a simple isAdminOfOrg function inline
const isAdminOfOrg = async (adminAddress, orgId) => {
  if (!adminAddress || !orgId) return false;
  try {
    const org = await models.Organization.findOne({
      where: { id: orgId, admin_address: adminAddress },
    });
    return !!org;
  } catch (err) {
    console.error("Error in isAdminOfOrg:", err);
    return false;
  }
};
// Register webhook URL for organization with admin/org check
app.post("/api/admin/webhooks", async (req, res) => {
  try {
    const { organization_id, webhook_url, admin_address } = req.body;
    if (!organization_id || !webhook_url || !admin_address) {
      return res
        .status(400)
        .json({
          success: false,
          error: "organization_id, webhook_url, and admin_address are required",
        });
    }
    const isAdmin = await isAdminOfOrg(admin_address, organization_id);
    if (!isAdmin) {
      return res
        .status(403)
        .json({
          success: false,
          error: "Forbidden: admin_address does not belong to organization",
        });
    }
    const webhook = await OrganizationWebhook.create({
      organization_id,
      webhook_url,
    });
    res.status(201).json({ success: true, data: webhook });
  } catch (error) {
    console.error("Error registering webhook:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const indexingService = require("./services/indexingService");
const adminService = require("./services/adminService");
const vestingService = require("./services/vestingService");
const merkleVaultService = require("./services/merkleVaultService");
const discordBotService = require("./services/discordBotService");
const cacheService = require("./services/cacheService");
const tvlService = require("./services/tvlService");
const vaultExportService = require("./services/vaultExportService");
const authService = require("./services/authService");
const notificationService = require("./services/notificationService");
const liquidityMonitorService = require("./services/liquidityMonitorService");
const pdfService = require("./services/pdfService");
const legalDocumentHashingService = require("./services/legalDocumentHashingService");
const ledgerSyncService = require("./services/ledgerSyncService");
const multiSigRevocationService = require("./services/multiSigRevocationService");
const dividendService = require("./services/dividendService");
const accountConsolidationService = require("./services/accountConsolidationService");
const VaultService = require("./services/vaultService");
const batchRevocationService = require("./services/batchRevocationService");
const monthlyReportJob = require("./jobs/monthlyReportJob");
const { VaultReconciliationJob } = require("./jobs/vaultReconciliationJob");
const vaultArchivalJob = require("./jobs/vaultArchivalJob");
const historicalPriceTrackingJob = require("./jobs/historicalPriceTrackingJob");
const integrityMonitoringJob = require("./jobs/integrityMonitoringJob");
const vaultRegistryIndexingJob = require("./jobs/vaultRegistryIndexingJob");
const vaultBalanceMonitoringJob = require("./jobs/vaultBalanceMonitoringJob");
const claimWebhookListenerService = require("./services/claimWebhookListenerService");
const stellarPathPaymentListener = require("./services/stellarPathPaymentListener");
const kycExpirationWorker = require("./jobs/kycExpirationWorker");
const gdprComplianceJob = require("./jobs/gdprComplianceJob");
const VestingStateReconciliationJob = require("./jobs/vestingStateReconciliationJob");

const { Token, initTokenModel } = models; // models already has these
// Note: models/index.js already calls initTokenModel(sequelize)

// All models are already initialized and exported via require("./models")
const analyticsRoutes = require("./routes/analyticsRoutes");

// Import webhooks routes
const webhooksRoutes = require("./routes/webhooks");
const organizationRoutes = require("./routes/organization");
const hsmRoutes = require("./routes/hsm");
const historicalPriceRoutes = require("./routes/historicalPriceRoutes");
const auditorRoutes = require("./routes/auditor");
const vaultRegistryRoutes = require("./routes/vaultRegistry");
const contractUpgradeRoutes = require("./routes/contractUpgrade");
const conversionAnalyticsRoutes = require("./routes/conversionAnalytics");
const correlationRoutes = require("./routes/correlationRoutes");
const futureLienRoutes = require("./routes/futureLienRoutes");
const healthRoutes = require("./routes/healthRoutes");
const kycStatusRoutes = require("./routes/kycStatusRoutes");
const unlockProjectionRoutes = require("./routes/unlockProjectionRoutes");

app.get("/", (req, res) => {
  res.json({ message: "Vesting Vault API is running!" });
});

app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Prometheus metrics endpoint
app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", metricsService.register.contentType);
    res.end(await metricsService.register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
});

// Database connection pool + query performance status (issue #8)
app.get("/admin/db/pool-status", (req, res) => {
  try {
    const connectionPoolMonitor = require("./database/connectionPoolMonitor");
    const queryPerformanceMonitor = require("./database/queryPerformanceMonitor");
    const limit = parseInt(req.query.slowLimit, 10) || 25;

    res.json({
      success: true,
      data: {
        pool: connectionPoolMonitor.getStatus(),
        queries: queryPerformanceMonitor.getStats(),
        slowQueries: queryPerformanceMonitor.getSlowQueries(limit),
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error("Error fetching DB pool status:", error);
    res.status(500).json({ success: false, error: "Failed to fetch DB pool status" });
  }
});


// Enhanced health check with readiness probe
app.get("/health/ready", async (req, res) => {
  try {
    // Check database connection
    await sequelize.authenticate();

    // Check Redis connection if available
    let redisStatus = "not_configured";
    try {
      const cacheService = require("./services/cacheService");
      if (cacheService.isReady()) {
        redisStatus = "healthy";
      }
    } catch (redisError) {
      redisStatus = "unavailable";
    }

    // All checks passed
    res.json({
      status: "ready",
      timestamp: new Date().toISOString(),
      checks: {
        database: "healthy",
        redis: redisStatus,
      },
    });
  } catch (error) {
    console.error("Health check failed:", error);
    res.status(503).json({
      status: "not_ready",
      timestamp: new Date().toISOString(),
      error: error.message,
    });
  }
});

// Liveness probe endpoint
app.get("/health/live", (req, res) => {
  // Simple liveness check - just confirms the process is running
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();

  res.json({
    status: "alive",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(uptime),
    memory: {
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + "MB",
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + "MB",
      rss: Math.round(memoryUsage.rss / 1024 / 1024) + "MB",
    },
  });
});

// Circuit breaker health endpoint — reports the live state of every registered
// downstream-dependency circuit. Returns 503 if any circuit is currently open.
app.get("/health/circuit-breakers", (req, res) => {
  try {
    const circuitBreakerRegistry = require("./resilience/circuitBreakerRegistry");
    const circuits = circuitBreakerRegistry.getAllStates();
    const anyOpen = circuits.some((c) => c.state === "OPEN");

    res.status(anyOpen ? 503 : 200).json({
      status: anyOpen ? "degraded" : "healthy",
      timestamp: new Date().toISOString(),
      total: circuits.length,
      open: circuits.filter((c) => c.state === "OPEN").length,
      circuits,
    });
  } catch (error) {
    res.status(500).json({ status: "error", error: error.message });
  }
});

// Manual circuit reset — recover a tripped circuit without a service restart.
app.post("/health/circuit-breakers/:service/reset", (req, res) => {
  try {
    const circuitBreakerRegistry = require("./resilience/circuitBreakerRegistry");
    const reset = circuitBreakerRegistry.reset(req.params.service);
    if (!reset) {
      return res.status(404).json({ success: false, error: `No circuit registered for '${req.params.service}'` });
    }
    res.json({ success: true, service: req.params.service, message: "Circuit reset to CLOSED" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Authentication endpoints
app.post("/api/auth/login", async (req, res) => {
  try {
    const { address, signature } = req.body;

    if (!address || !signature) {
      return res.status(400).json({
        success: false,
        error: "Address and signature are required",
      });
    }

    // TODO: Verify signature with Ethereum message
    // For now, we'll create tokens without signature verification
    // In production, implement proper EIP-712 signature verification

    const tokens = await authService.createTokens(address);

    // Set refresh token in secure cookie
    authService.setRefreshTokenCookie(res, tokens.refreshToken);

    // Return access token in response (don't return refresh token)
    res.json({
      success: true,
      data: {
        accessToken: tokens.accessToken,
        expiresIn: tokens.expiresIn,
        tokenType: tokens.tokenType,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Login failed",
    });
  }
});

// POST /api/auth/refresh - Token refresh endpoint
app.post("/api/auth/refresh", async (req, res) => {
  try {
    // Try to get refresh token from cookie first
    let refreshToken = authService.getRefreshTokenFromCookie(req);

    // If not in cookie, try request body
    if (!refreshToken) {
      refreshToken = req.body.refreshToken;
    }

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        error: "Refresh token required",
      });
    }

    // Refresh tokens (this will revoke the old token and create new ones)
    const newTokens = await authService.refreshTokens(refreshToken);

    // Set new refresh token in secure cookie
    authService.setRefreshTokenCookie(res, newTokens.refreshToken);

    // Return new access token
    res.json({
      success: true,
      data: {
        accessToken: newTokens.accessToken,
        expiresIn: newTokens.expiresIn,
        tokenType: newTokens.tokenType,
      },
    });
  } catch (error) {
    console.error("Token refresh error:", error);

    // Clear invalid refresh token cookie
    authService.clearRefreshTokenCookie(res);

    res.status(401).json({
      success: false,
      error: error.message || "Token refresh failed",
    });
  }
});

// POST /api/auth/logout - Logout endpoint
app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = authService.extractTokenFromHeader(req);

    if (token) {
      try {
        const decoded = await authService.verifyAccessToken(token);
        // Revoke all refresh tokens for this user
        await authService.revokeAllUserTokens(decoded.address);
      } catch (error) {
        // Token might be invalid, but still clear cookie
        console.log("Invalid token during logout:", error.message);
      }
    }

    // Clear refresh token cookie
    authService.clearRefreshTokenCookie(res);

    res.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("Logout error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Logout failed",
    });
  }
});

// GET /api/auth/me - Get current user info
app.get("/api/auth/me", authService.authenticate(), async (req, res) => {
  try {
    const user = req.user;

    res.json({
      success: true,
      data: {
        address: user.address,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Get user info error:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to get user info",
    });
  }
});
// Mount webhooks routes
app.use("/webhooks", webhooksRoutes);

// Mount organization routes
app.use("/api/org", organizationRoutes);

// Mount HSM routes (high security endpoints)
app.use("/api/hsm", hsmRoutes);

// Mount historical price tracking routes
app.use("/api/historical-prices", historicalPriceRoutes);

// Mount auditor routes (read-only auditor API for due diligence)
app.use("/api/auditor", auditorRoutes);

// Mount vault registry routes (ecosystem-wide vault discovery)
app.use("/api/registry", vaultRegistryRoutes);

// Mount contract upgrade routes (proxy-style upgrade functionality)
app.use("/api/contract-upgrade", contractUpgradeRoutes);

// Mount conversion analytics routes (path payment analytics and cost basis tracking)
app.use("/api/conversion-analytics", conversionAnalyticsRoutes);

// Mount TVL-price correlation analysis routes
app.use("/api/correlation", correlationRoutes);

// Mount vesting-to-grant-stream integration routes
app.use("/api", futureLienRoutes);

// Mount contract verification routes (prevent impersonation scams)
app.use("/api/contract-verification", require('./routes/contractVerification'));

// Mount batch claims routes (enterprise payroll optimization)
app.use("/api/batch-claims", require('./routes/batchClaims'));

// Mount partner management routes (institutional partner API access)
app.use("/api/partners", require('./routes/partnerManagement'));

// Mount KYC status routes (KYC management and admin approval)
app.use("/api/kyc-status", kycStatusRoutes);

// Mount Soroban events routes (event indexing and monitoring)
app.use("/api/soroban-events", require('./routes/sorobanEvents'));

// Mount ledger reorg management routes (reorg detection and resync)
app.use("/api/ledger-reorg", require('./routes/ledgerReorg'));

// Mount vesting history routes (optimized PostgreSQL queries)
app.use("/api/vesting-history", require('./routes/vestingHistory'));

// Mount background queue admin routes (status, DLQ inspection, manual retry)
app.use("/admin/queues", require('./routes/adminQueues'));

// Historical price tracking job management endpoints
app.post("/api/admin/jobs/historical-prices/start", async (req, res) => {
  try {
    historicalPriceTrackingJob.start();
    res.json({
      success: true,
      message: "Historical price tracking job started",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/jobs/historical-prices/stop", async (req, res) => {
  try {
    historicalPriceTrackingJob.stop();
    res.json({
      success: true,
      message: "Historical price tracking job stopped",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/jobs/historical-prices/run", async (req, res) => {
  try {
    await historicalPriceTrackingJob.run();
    res.json({
      success: true,
      message: "Historical price tracking job completed",
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/admin/jobs/historical-prices/stats", async (req, res) => {
  try {
    const stats = historicalPriceTrackingJob.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GDPR compliance job management endpoints
app.post("/api/admin/jobs/gdpr-compliance/run", async (req, res) => {
  try {
    const gdprJob = new gdprComplianceJob();
    const results = await gdprJob.runManually();
    res.json({
      success: true,
      message: "GDPR compliance check completed",
      data: results
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/admin/jobs/gdpr-compliance/stats", async (req, res) => {
  try {
    const gdprJob = new gdprComplianceJob();
    const stats = await gdprJob.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mount unlock projection routes
app.use('/api/analytics/projections', unlockProjectionRoutes);

// Mount analytics routes
app.use('/api', analyticsRoutes);

// ── Vesting Routes ────────────────────────────────────────────────────────────

// POST /api/vaults - Create a new vault
app.post("/api/vaults", async (req, res) => {
  try {
    const vault = await vestingService.createVault(req.body);
    res.status(201).json({ success: true, data: vault });
  } catch (error) {
    console.error("Error creating vault:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/vaults/:vaultAddress/top-up - Process a top-up
app.post("/api/vaults/:vaultAddress/top-up", async (req, res) => {
  try {
    const { vaultAddress } = req.params;
    const subSchedule = await vestingService.processTopUp({
      vault_address: vaultAddress,
      ...req.body,
    });
    res.status(201).json({ success: true, data: subSchedule });
  } catch (error) {
    console.error("Error processing top-up:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/vaults/:vaultAddress/schedule - Get vesting schedule
app.get("/api/vaults/:vaultAddress/schedule", async (req, res) => {
  try {
    const { vaultAddress } = req.params;
    const { beneficiaryAddress } = req.query;
    const schedule = await vestingService.getVestingSchedule(
      vaultAddress,
      beneficiaryAddress,
    );
    res.json({ success: true, data: schedule });
  } catch (error) {
    console.error("Error fetching vesting schedule:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/vaults/:vaultAddress/:beneficiaryAddress/withdrawable - Calculate withdrawable
app.get(
  "/api/vaults/:vaultAddress/:beneficiaryAddress/withdrawable",
  async (req, res) => {
    try {
      const { vaultAddress, beneficiaryAddress } = req.params;
      const { timestamp } = req.query;
      const result = await vestingService.calculateWithdrawableAmount(
        vaultAddress,
        beneficiaryAddress,
        timestamp ? new Date(timestamp) : new Date(),
      );
      res.json({ success: true, data: result });
    } catch (error) {
      console.error("Error calculating withdrawable amount:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// POST /api/vaults/:vaultAddress/:beneficiaryAddress/withdraw - Process withdrawal
app.post(
  "/api/vaults/:vaultAddress/:beneficiaryAddress/withdraw",
  async (req, res) => {
    try {
      const { vaultAddress, beneficiaryAddress } = req.params;
      const result = await vestingService.processWithdrawal({
        vault_address: vaultAddress,
        beneficiary_address: beneficiaryAddress,
        ...req.body,
      });
      res.json({ success: true, data: result });
    } catch (error) {
      console.error("Error processing withdrawal:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  },
);

// GET /api/vaults/:vaultAddress/summary - Vault summary
app.get("/api/vaults/:vaultAddress/summary", async (req, res) => {
  try {
    const { vaultAddress } = req.params;
    const summary = await vestingService.getVaultSummary(vaultAddress);
    res.json({ success: true, data: summary });
  } catch (error) {
    console.error("Error fetching vault summary:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const legalDocumentUploadMiddleware = express.raw({
  type: ["application/pdf"],
  limit: process.env.LEGAL_DOCUMENT_MAX_SIZE || "10mb",
});

app.post(
  "/api/vaults/:id/legal-document",
  authService.authenticate(),
  legalDocumentUploadMiddleware,
  async (req, res) => {
    try {
      const record = await legalDocumentHashingService.hashAndStoreDocument({
        vaultId: req.params.id,
        pdfBuffer: req.body,
        documentName: req.headers["x-document-name"] || req.query.documentName,
        mimeType: req.headers["content-type"],
        uploaderAddress: req.user.address,
        uploaderRole: req.user.role,
      });

      res.status(201).json({
        success: true,
        data: {
          id: record.id,
          vault_id: record.vault_id,
          document_type: record.document_type,
          document_name: record.document_name,
          sha256_hash: record.sha256_hash,
          file_size_bytes: record.file_size_bytes,
          uploaded_by: record.uploaded_by,
          uploaded_at: record.uploaded_at,
        },
      });
    } catch (error) {
      console.error("Error hashing legal document:", error);
      const status = error.message.includes("not found")
        ? 404
        : error.message.includes("permission")
          ? 403
          : error.message.includes("PDF")
            ? 400
            : 500;
      res.status(status).json({ success: false, error: error.message });
    }
  },
);

app.get(
  "/api/vaults/:id/legal-document",
  authService.authenticate(),
  async (req, res) => {
    try {
      const record = await legalDocumentHashingService.getStoredDocument(
        req.params.id,
        req.user.address,
        req.user.role,
      );

      res.json({
        success: true,
        data: {
          id: record.id,
          vault_id: record.vault_id,
          document_type: record.document_type,
          document_name: record.document_name,
          mime_type: record.mime_type,
          file_size_bytes: record.file_size_bytes,
          sha256_hash: record.sha256_hash,
          uploaded_by: record.uploaded_by,
          uploaded_at: record.uploaded_at,
          last_verified_at: record.last_verified_at,
        },
      });
    } catch (error) {
      console.error("Error fetching legal document fingerprint:", error);
      const status = error.message.includes("not found")
        ? 404
        : error.message.includes("permission")
          ? 403
          : 500;
      res.status(status).json({ success: false, error: error.message });
    }
  },
);

app.post(
  "/api/vaults/:id/legal-document/verify",
  authService.authenticate(),
  legalDocumentUploadMiddleware,
  async (req, res) => {
    try {
      const result = await legalDocumentHashingService.verifyDocument({
        vaultId: req.params.id,
        pdfBuffer: req.body,
        requesterAddress: req.user.address,
        requesterRole: req.user.role,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error("Error verifying legal document fingerprint:", error);
      const status = error.message.includes("not found")
        ? 404
        : error.message.includes("permission")
          ? 403
          : error.message.includes("PDF")
            ? 400
            : 500;
      res.status(status).json({ success: false, error: error.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────

// Merkle vesting airdrops (Issue #51)
app.post("/api/merkle-vault/build-tree", async (req, res) => {
  try {
    const { entries } = req.body;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "entries array required" });
    }
    const data = merkleVaultService.buildMerkleVaultData(entries);
    res.json({
      success: true,
      data: {
        rootHash: data.rootHash,
        totalAmount: data.totalAmount,
        proofsByIndex: data.proofsByIndex,
      },
    });
  } catch (error) {
    console.error("Error building Merkle tree:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/claims", claimRateLimiter, async (req, res) => {
  try {
    const claim = await indexingService.processClaim(req.body);

    // Apply recording middleware after successful claim
    await recordClaimComplianceMiddleware(req, res, () => { });

    res.status(201).json({ success: true, data: claim });
  } catch (error) {
    console.error("Error processing claim:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/claims/batch", claimRateLimiter, async (req, res) => {
  try {
    const result = await indexingService.processBatchClaims(req.body.claims);

    // Apply recording middleware for each claim in batch
    for (const claim of req.body.claims) {
      const mockReq = { body: claim, path: '/api/claims/batch' };
      await recordClaimComplianceMiddleware(mockReq, res, () => { });
    }

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error processing batch claims:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/api/claims/backfill-prices", claimRateLimiter, async (req, res) => {
  try {
    const processedCount = await indexingService.backfillMissingPrices();
    res.json({
      success: true,
      message: `Backfilled prices for ${processedCount} claims`,
    });
  } catch (error) {
    console.error("Error backfilling prices:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/claims/:userAddress/realized-gains", async (req, res) => {
  try {
    const { userAddress } = req.params;
    const { startDate, endDate } = req.query;

    const gains = await indexingService.getRealizedGains(
      userAddress,
      startDate ? new Date(startDate) : null,
      endDate ? new Date(endDate) : null,
    );

    res.json({ success: true, data: gains });
  } catch (error) {
    console.error("Error calculating realized gains:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// POST /api/admin/batch-revoke - Batch revoke multiple beneficiaries
app.post("/api/admin/batch-revoke", authService.authenticate(true), async (req, res) => {
  try {
    const {
      vaultAddress,
      beneficiaryAddresses,
      reason,
      treasuryAddress,
      admin_address
    } = req.body;

    // Validate input
    if (!vaultAddress || !beneficiaryAddresses || !reason) {
      return res.status(400).json({
        success: false,
        error: "vaultAddress, beneficiaryAddresses, and reason are required",
      });
    }

    if (!Array.isArray(beneficiaryAddresses) || beneficiaryAddresses.length === 0) {
      return res.status(400).json({
        success: false,
        error: "beneficiaryAddresses must be a non-empty array",
      });
    }

    // Use authenticated user's address as admin address
    const adminAddress = req.user.address;

    // Validate parameters
    await batchRevocationService.validateBatchRevocation({
      vaultAddress,
      beneficiaryAddresses,
      adminAddress,
    });

    // Execute batch revocation
    const result = await batchRevocationService.batchRevokeBeneficiaries({
      vaultAddress,
      beneficiaryAddresses,
      adminAddress,
      reason,
      treasuryAddress,
    });

    res.json({
      success: true,
      message: result.message,
      data: {
        vault_address: result.vault_address,
        beneficiaries_revoked: result.beneficiaries_revoked,
        total_vested_paid: result.total_vested_paid,
        total_unvested_returned: result.total_unvested_returned,
        treasury_address: result.treasury_address,
        individual_results: result.results,
      },
    });
  } catch (error) {
    console.error("Batch revocation error:", error);

    // Handle specific error types
    let statusCode = 500;
    if (error.message.includes('not found')) {
      statusCode = 404;
    } else if (error.message.includes('blacklisted') || error.message.includes('Unauthorized')) {
      statusCode = 403;
    } else if (error.message.includes('required') || error.message.includes('must be')) {
      statusCode = 400;
    }

    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/api/admin/revoke", async (req, res) => {
  try {
    const { adminAddress, targetVault, reason } = req.body;
    const result = await adminService.revokeAccess(
      adminAddress,
      targetVault,
      reason,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error revoking access:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/clean-break", async (req, res) => {
  try {
    const {
      vaultAddress,
      beneficiaryAddress,
      terminationTimestamp,
      treasuryAddress,
    } = req.body;

    if (!vaultAddress || !beneficiaryAddress) {
      return res.status(400).json({
        success: false,
        error: "vaultAddress and beneficiaryAddress are required",
      });
    }

    const result = await vestingService.calculateCleanBreak(
      vaultAddress,
      beneficiaryAddress,
      terminationTimestamp || new Date(),
      treasuryAddress,
    );

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error executing clean break:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/create", async (req, res) => {
  try {
    const { adminAddress, targetVault, vaultConfig } = req.body;
    const result = await adminService.createVault(
      adminAddress,
      targetVault,
      vaultConfig,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error creating vault:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/api/admin/transfer", async (req, res) => {
  try {
    const { adminAddress, targetVault, newOwner } = req.body;
    const result = await adminService.transferVault(
      adminAddress,
      targetVault,
      newOwner,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error transferring vault:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/admin/vault/privacy - Toggle privacy mode for a vault
app.post("/api/admin/vault/privacy", async (req, res) => {
  try {
    const { cursor, limit = 100 } = req.query;

    // Validate cursor parameters
    const paginationOptions = validateCursorParams(req, 'created_at');

    const result = await paginateWithCursor(models.AuditLog, {
      cursor: paginationOptions.cursor,
      orderField: 'created_at',
      orderDirection: 'DESC',
      limit: paginationOptions.limit
    });

    res.json({
      success: true,
      data: {
        audit_logs: result.items,
        pagination: result.pagination
      }
    });
  } catch (error) {
    console.error("Error toggling privacy mode:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/admin/audit-logs", async (req, res) => {
  try {
    const { limit } = req.query;
    const result = await adminService.getAuditLogs(
      limit ? parseInt(limit) : 100,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/propose-new-admin", async (req, res) => {
  try {
    const { currentAdminAddress, newAdminAddress, contractAddress } = req.body;
    const result = await adminService.proposeNewAdmin(
      currentAdminAddress,
      newAdminAddress,
      contractAddress,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error proposing new admin:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/accept-ownership", async (req, res) => {
  try {
    const { newAdminAddress, transferId } = req.body;
    const result = await adminService.acceptOwnership(
      newAdminAddress,
      transferId,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error accepting ownership:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/admin/transfer-ownership", async (req, res) => {
  try {
    const { currentAdminAddress, newAdminAddress, contractAddress } = req.body;
    const result = await adminService.transferOwnership(
      currentAdminAddress,
      newAdminAddress,
      contractAddress,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error transferring ownership:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/admin/pending-transfers", async (req, res) => {
  try {
    const { contractAddress } = req.query;
    const result = await adminService.getPendingTransfers(contractAddress);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error fetching pending transfers:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/stats/tvl", async (req, res) => {
  try {
    const tvlStats = await tvlService.getTVLStats();
    res.json({
      success: true,
      data: {
        total_value_locked: tvlStats.total_value_locked,
        active_vaults_count: tvlStats.active_vaults_count,
        formatted_tvl: tvlService.formatTVL(tvlStats.total_value_locked),
        last_updated_at: tvlStats.last_updated_at,
      },
    });
  } catch (error) {
    console.error("Error fetching TVL stats:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delegate routes
app.post("/api/delegate/set", async (req, res) => {
  try {
    const { vaultId, ownerAddress, delegateAddress } = req.body;
    const { Vault } = require("./models");
    const vault = await Vault.findOne({
      where: { id: vaultId, owner_address: ownerAddress },
    });
    if (!vault)
      return res
        .status(500)
        .json({ success: false, error: "Vault not found or access denied" });
    if (!delegateAddress || delegateAddress === "invalid_address")
      return res
        .status(500)
        .json({ success: false, error: "Invalid delegate address" });
    await vault.update({ delegate_address: delegateAddress });
    res.json({
      success: true,
      data: { message: "Delegate set successfully", vault },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/delegate/claim", async (req, res) => {
  try {
    const { delegateAddress, vaultAddress, releaseAmount } = req.body;
    const { Vault, SubSchedule } = require("./models");
    const vault = await Vault.findOne({
      where: { address: vaultAddress, delegate_address: delegateAddress },
    });
    if (!vault)
      return res
        .status(500)
        .json({
          success: false,
          error: "Vault not found or delegate not authorized",
        });

    const amount = parseFloat(releaseAmount);
    const subSchedule = await SubSchedule.findOne({
      where: { vault_id: vault.id },
    });

    if (
      subSchedule &&
      subSchedule.vesting_start_date &&
      new Date() < new Date(subSchedule.vesting_start_date)
    ) {
      return res
        .status(500)
        .json({ success: false, error: "Insufficient releasable amount" });
    }

    if (subSchedule) {
      const newReleased =
        (parseFloat(subSchedule.amount_released) || 0) + amount;
      await subSchedule.update({ amount_released: String(newReleased) });
    }

    res.json({
      success: true,
      data: {
        message: "Tokens claimed successfully by delegate",
        releaseAmount,
        ownerAddress: vault.owner_address,
        delegateAddress,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/delegate/:vaultAddress/info", async (req, res) => {
  try {
    const { vaultAddress } = req.params;
    const { Vault, SubSchedule, Beneficiary } = require("./models");
    const vault = await Vault.findOne({
      where: { address: vaultAddress },
      include: [{ model: SubSchedule, as: "subSchedules" }],
    });
    if (!vault)
      return res
        .status(500)
        .json({ success: false, error: "Vault not found or inactive" });
    res.json({ success: true, data: { vault } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Notification endpoints
app.post("/api/notifications/register-device", async (req, res) => {
  try {
    const { userAddress, deviceToken, platform, appVersion } = req.body;

    if (!userAddress || !deviceToken || !platform) {
      return res.status(400).json({
        success: false,
        error: "userAddress, deviceToken, and platform are required",
      });
    }

    if (!["ios", "android", "web"].includes(platform)) {
      return res.status(400).json({
        success: false,
        error: "platform must be one of: ios, android, web",
      });
    }

    const deviceTokenRecord = await notificationService.registerDeviceToken(
      userAddress,
      deviceToken,
      platform,
      appVersion,
    );

    res.status(201).json({
      success: true,
      data: {
        id: deviceTokenRecord.id,
        userAddress: deviceTokenRecord.user_address,
        platform: deviceTokenRecord.platform,
        registeredAt: deviceTokenRecord.created_at,
      },
    });
  } catch (error) {
    console.error("Error registering device token:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.delete("/api/notifications/unregister-device", async (req, res) => {
  try {
    const { deviceToken } = req.body;

    if (!deviceToken) {
      return res.status(400).json({
        success: false,
        error: "deviceToken is required",
      });
    }

    const success =
      await notificationService.unregisterDeviceToken(deviceToken);

    res.json({
      success: true,
      data: { unregistered: success },
    });
  } catch (error) {
    console.error("Error unregistering device token:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/notifications/devices/:userAddress", async (req, res) => {
  try {
    const { userAddress } = req.params;

    const deviceTokens =
      await notificationService.getUserDeviceTokens(userAddress);

    res.json({
      success: true,
      data: deviceTokens.map((token) => ({
        id: token.id,
        platform: token.platform,
        appVersion: token.app_version,
        lastUsedAt: token.last_used_at,
        registeredAt: token.created_at,
      })),
    });
  } catch (error) {
    console.error("Error fetching user device tokens:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Multi-Signature Revocation Endpoints
// POST /api/admin/multi-sig/config - Create multi-sig configuration for vault
app.post(
  "/api/admin/multi-sig/config",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const { vaultAddress, signers, requiredSignatures } = req.body;
      const createdBy = req.user.address;

      if (
        !vaultAddress ||
        !signers ||
        !Array.isArray(signers) ||
        !requiredSignatures
      ) {
        return res.status(400).json({
          success: false,
          error:
            "vaultAddress, signers array, and requiredSignatures are required",
        });
      }

      const config = await multiSigRevocationService.createMultiSigConfig(
        vaultAddress,
        signers,
        requiredSignatures,
        createdBy,
      );

      res.status(201).json({
        success: true,
        data: config,
      });
    } catch (error) {
      console.error("Error creating multi-sig config:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// GET /api/admin/multi-sig/config/:vaultAddress - Get multi-sig configuration
app.get(
  "/api/admin/multi-sig/config/:vaultAddress",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const { vaultAddress } = req.params;

      const config =
        await multiSigRevocationService.getMultiSigConfig(vaultAddress);

      if (!config) {
        return res.status(404).json({
          success: false,
          error: "Multi-sig configuration not found",
        });
      }

      res.json({
        success: true,
        data: config,
      });
    } catch (error) {
      console.error("Error getting multi-sig config:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// POST /api/admin/multi-sig/proposal - Create revocation proposal
app.post(
  "/api/admin/multi-sig/proposal",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const { vaultAddress, beneficiaryAddress, amountToRevoke, reason } =
        req.body;
      const proposedBy = req.user.address;

      if (!vaultAddress || !beneficiaryAddress || !amountToRevoke || !reason) {
        return res.status(400).json({
          success: false,
          error:
            "vaultAddress, beneficiaryAddress, amountToRevoke, and reason are required",
        });
      }

      const proposal = await multiSigRevocationService.createRevocationProposal(
        vaultAddress,
        beneficiaryAddress,
        amountToRevoke,
        reason,
        proposedBy,
      );

      res.status(201).json({
        success: true,
        data: proposal,
      });
    } catch (error) {
      console.error("Error creating revocation proposal:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// GET /api/admin/multi-sig/proposal/:proposalId - Get proposal details
app.get(
  "/api/admin/multi-sig/proposal/:proposalId",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const { proposalId } = req.params;

      const proposal = await multiSigRevocationService.getProposal(proposalId);

      res.json({
        success: true,
        data: proposal,
      });
    } catch (error) {
      console.error("Error getting proposal:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// GET /api/admin/multi-sig/proposals/:vaultAddress - Get pending proposals for vault
app.get(
  "/api/admin/multi-sig/proposals/:vaultAddress",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const { vaultAddress } = req.params;

      const proposals =
        await multiSigRevocationService.getPendingProposals(vaultAddress);

      res.json({
        success: true,
        data: proposals,
      });
    } catch (error) {
      console.error("Error getting pending proposals:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// POST /api/admin/multi-sig/sign - Sign a proposal
app.post(
  "/api/admin/multi-sig/sign",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const { proposalId, signature } = req.body;
      const signerAddress = req.user.address;

      if (!proposalId || !signature) {
        return res.status(400).json({
          success: false,
          error: "proposalId and signature are required",
        });
      }

      const result = await multiSigRevocationService.addSignature(
        proposalId,
        signerAddress,
        signature,
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error("Error adding signature:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// GET /api/admin/multi-sig/stats - Get multi-sig statistics
app.get(
  "/api/admin/multi-sig/stats",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const stats = await multiSigRevocationService.getStats();

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      console.error("Error getting multi-sig stats:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// GET /api/vaults/:id/export - Export vault data as CSV (Offloaded to BullMQ)
app.get("/api/vaults/:id/export", async (req, res) => {
  try {
    const { id } = req.params;
    const exportQueue = req.app.get('exportQueue');

    // Offload CSV generation to BullMQ worker
    const outputPath = path.join(__dirname, '../downloads', `export-${id}-${Date.now()}.csv`);
    const job = await exportQueue.add('generate-csv', { vaultId: id, outputPath });

    // Wait for worker to finish (to keep compatibility but offload event loop)
    await job.waitUntilFinished(new (require('bullmq').QueueEvents)('csv-export', {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      }
    }));

    res.download(outputPath);
  } catch (error) {
    console.error("Error queueing CSV export:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Balance query endpoint
app.get("/api/vaults/:id/balance", async (req, res) => {
  try {
    const { id } = req.params;
    const vaultService = new VaultService();

    const balanceInfo = await vaultService.queryBalanceInfo(id);

    res.json({
      success: true,
      data: balanceInfo.toJSON(),
    });
  } catch (error) {
    console.error("Error querying vault balance:", error);

    if (error.message && error.message.includes("not found")) {
      res.status(404).json({
        success: false,
        error: error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
});

// Vesting Agreement PDF endpoint (Offloaded to BullMQ)
app.get("/api/vault/:id/agreement.pdf", async (req, res) => {
  try {
    const { id } = req.params;
    const {
      Vault,
      Beneficiary,
      SubSchedule,
      Organization,
      Token,
    } = require("./models");

    // Find vault with related data
    const vault = await Vault.findOne({
      where: { id },
      include: [
        {
          model: Organization,
          as: "organization",
          required: false,
        },
        {
          model: Beneficiary,
          required: true,
        },
        {
          model: SubSchedule,
          required: false,
        },
      ],
    });

    if (!vault) {
      return res.status(404).json({
        success: false,
        error: "Vault not found",
      });
    }

    // Get token information
    let token = null;
    if (vault.token_address) {
      token = await Token.findOne({
        where: { address: vault.token_address },
      });
    }

    // Prepare data for PDF generation
    const vaultData = {
      vault: vault.get({ plain: true }),
      beneficiaries: vault.Beneficiaries || [],
      subSchedules: vault.SubSchedules || [],
      organization: vault.organization,
      token: token,
    };

    // Generate and stream PDF via BullMQ offloading
    const pdfQueue = req.app.get('pdfQueue');
    const outputPath = path.join(__dirname, '../downloads', `agreement-${vaultData.vault.address}-${Date.now()}.pdf`);

    const job = await pdfQueue.add('generate-pdf', { vaultData, outputPath });

    // Wait for worker to finish (ensures main event loop is free while worker computes)
    await job.waitUntilFinished(new (require('bullmq').QueueEvents)('pdf-generation', {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      }
    }));

    res.download(outputPath);
  } catch (error) {
    console.error("Error queueing PDF generation:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});


// Token distribution endpoint for pie chart data
app.get("/api/token/:address/distribution", async (req, res) => {
  try {
    const { address } = req.params;
    const { Vault } = require("./models");

    // Get all vaults for this token address, grouped by tag
    const distribution = await Vault.findAll({
      attributes: [
        "tag",
        [sequelize.fn("SUM", sequelize.col("total_amount")), "total_amount"],
      ],
      where: {
        token_address: address,
        total_amount: {
          [sequelize.Op.gt]: 0
        }
      },
      group: ["tag"],
  raw: true,
    });

// Format the response
const result = distribution
  .filter((item) => item.tag) // Filter out null tags
  .map((item) => ({
    label: item.tag,
    amount: parseFloat(item.total_amount),
  }))
  .sort((a, b) => b.amount - a.amount); // Sort by amount descending

res.json({
  success: true,
  data: result,
});
  } catch (error) {
  console.error("Error fetching token distribution:", error);
  res.status(500).json({
    success: false,
    error: error.message,
  });
}
});

// Dividend Distribution Endpoints
// POST /api/admin/dividend/round - Create new dividend round
app.post(
  "/api/admin/dividend/round",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const {
        tokenAddress,
        totalAmount,
        dividendToken,
        vestedTreatment = "full",
        unvestedMultiplier = 1.0,
      } = req.body;
      const createdBy = req.user.address;

      if (!tokenAddress || !totalAmount || !dividendToken) {
        return res.status(400).json({
          success: false,
          error: "tokenAddress, totalAmount, and dividendToken are required",
        });
      }

      const dividendRound = await dividendService.createDividendRound(
        tokenAddress,
        totalAmount,
        dividendToken,
        vestedTreatment,
        unvestedMultiplier,
        createdBy,
      );

      res.status(201).json({
        success: true,
        data: dividendRound,
      });
    } catch (error) {
      console.error("Error creating dividend round:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// Token distribution endpoint for pie chart data
app.post(
  "/api/admin/dividend/round",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const {
        tokenAddress,
        totalAmount,
        dividendToken,
        vestedTreatment = "full",
        unvestedMultiplier = 1.0,
      } = req.body;

      const createdBy = req.user.address;

      if (!tokenAddress || !totalAmount || !dividendToken) {
        return res.status(400).json({
          success: false,
          error: "tokenAddress, totalAmount, and dividendToken are required",
        });
      }

      const dividendRound = await dividendService.createDividendRound(
        tokenAddress,
        totalAmount,
        dividendToken,
        vestedTreatment,
        unvestedMultiplier,
        createdBy,
      );

      return res.status(201).json({
        success: true,
        data: dividendRound,
      });
    } catch (error) {
      console.error("Error creating dividend round:", error);
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
); // POST /api/admin/dividend/:roundId/snapshot - Take dividend snapshot
app.post(
  "/api/admin/dividend/:roundId/snapshot",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const { roundId } = req.params;

      const result = await dividendService.takeDividendSnapshot(roundId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error("Error taking dividend snapshot:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// POST /api/admin/dividend/:roundId/calculate - Calculate dividend distributions
app.post(
  "/api/admin/dividend/:roundId/calculate",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const { roundId } = req.params;

      const distributions =
        await dividendService.calculateDividendDistributions(roundId);

      res.json({
        success: true,
        data: distributions,
      });
    } catch (error) {
      console.error("Error calculating dividend distributions:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// POST /api/admin/dividend/:roundId/distribute - Distribute dividends
app.post(
  "/api/admin/dividend/:roundId/distribute",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const { roundId } = req.params;

      const result = await dividendService.distributeDividends(roundId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      console.error("Error distributing dividends:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// GET /api/admin/dividend/round/:roundId - Get dividend round details
app.get(
  "/api/admin/dividend/round/:roundId",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const { roundId } = req.params;

      const dividendRound = await dividendService.getDividendRound(roundId);

      res.json({
        success: true,
        data: dividendRound,
      });
    } catch (error) {
      console.error("Error getting dividend round:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// GET /api/admin/dividend/rounds/:tokenAddress - Get dividend rounds for token
app.get(
  "/api/admin/dividend/rounds/:tokenAddress",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const { tokenAddress } = req.params;
      const { status } = req.query;

      const rounds = await dividendService.getDividendRounds(
        tokenAddress,
        status,
      );

      res.json({
        success: true,
        data: rounds,
      });
    } catch (error) {
      console.error("Error getting dividend rounds:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Annual Vesting Statement API Endpoints
// ─────────────────────────────────────────────────────────────────────────────

const annualVestingStatementService = require('./services/annualVestingStatementService');
const annualStatementPDFService = require('./services/annualStatementPDFService');

// POST /api/statements/annual/generate - Generate annual statement
app.post("/api/statements/annual/generate", async (req, res) => {
  try {
    const { userAddress, year } = req.body;

    if (!userAddress || !year) {
      return res.status(400).json({
        success: false,
        error: "userAddress and year are required",
      });
    }

    const statement = await annualVestingStatementService.generateAnnualStatement(userAddress, parseInt(year));

    res.status(201).json({
      success: true,
      data: {
        id: statement.id,
        userAddress: statement.user_address,
        year: statement.year,
        generatedAt: statement.generated_at,
        summary: {
          totalVestedAmount: statement.total_vested_amount,
          totalClaimedAmount: statement.total_claimed_amount,
          totalUnclaimedAmount: statement.total_unclaimed_amount,
          totalFMVUSD: statement.total_fmv_usd,
          totalRealizedGainsUSD: statement.total_realized_gains_usd,
          numberOfVaults: statement.number_of_vaults,
          numberOfClaims: statement.number_of_claims,
        },
      },
    });
  } catch (error) {
    console.error("Error generating annual statement:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/statements/annual/:userAddress/:year - Get annual statement
app.get("/api/statements/annual/:userAddress/:year", async (req, res) => {
  try {
    const { userAddress, year } = req.params;

    const statement = await annualVestingStatementService.getStatement(userAddress, parseInt(year));

    res.json({
      success: true,
      data: {
        id: statement.id,
        userAddress: statement.user_address,
        year: statement.year,
        statementData: statement.statement_data,
        generatedAt: statement.generated_at,
        accessedAt: statement.accessed_at,
        digitalSignature: statement.digital_signature,
        transparencyKeyPublicKey: statement.transparency_key_public_address,
        summary: {
          totalVestedAmount: statement.total_vested_amount,
          totalClaimedAmount: statement.total_claimed_amount,
          totalUnclaimedAmount: statement.total_unclaimed_amount,
          totalFMVUSD: statement.total_fmv_usd,
          totalRealizedGainsUSD: statement.total_realized_gains_usd,
          numberOfVaults: statement.number_of_vaults,
          numberOfClaims: statement.number_of_claims,
        },
      },
    });
  } catch (error) {
    console.error("Error getting annual statement:", error);
    if (error.message.includes('not found')) {
      res.status(404).json({
        success: false,
        error: error.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
});

// GET /api/statements/annual/:userAddress - Get user's annual statements
app.get("/api/statements/annual/:userAddress", async (req, res) => {
  try {
    const { userAddress } = req.params;
    const { limit = 10, offset = 0 } = req.query;

    const statements = await annualVestingStatementService.getUserStatements(userAddress, {
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json({
      success: true,
      data: {
        statements: statements.rows.map(statement => ({
          id: statement.id,
          year: statement.year,
          generatedAt: statement.generated_at,
          accessedAt: statement.accessed_at,
          summary: {
            totalVestedAmount: statement.total_vested_amount,
            totalClaimedAmount: statement.total_claimed_amount,
            totalUnclaimedAmount: statement.total_unclaimed_amount,
            totalFMVUSD: statement.total_fmv_usd,
            totalRealizedGainsUSD: statement.total_realized_gains_usd,
            numberOfVaults: statement.number_of_vaults,
            numberOfClaims: statement.number_of_claims,
          },
        })),
        pagination: {
          total: statements.count,
          limit: parseInt(limit),
          offset: parseInt(offset),
        },
      },
    });
  } catch (error) {
    console.error("Error getting user statements:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/statements/annual/:userAddress/:year/download - Download annual statement PDF (Offloaded to BullMQ)
app.get("/api/statements/annual/:userAddress/:year/download", async (req, res) => {
  try {
    const { userAddress, year } = req.params;

    const statement = await annualVestingStatementService.getStatement(userAddress, parseInt(year));
    const job = await backgroundJobManager.addAnnualStatementJob(statement.statement_data, parseInt(year));

    res.json({
      success: true,
      message: "Annual statement generation job queued",
      data: { jobId: job.id }
    });
  } catch (error) {
    console.error("Error queueing annual statement:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/jobs/:id - Check job status
app.get("/api/jobs/:id", async (req, res) => {
  try {
    const status = await backgroundJobManager.getJobStatus(req.params.id);
    if (!status) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/exports/download/:filename - Download generated file
app.get("/api/exports/download/:filename", (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, "../exports", filename);

  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ success: false, error: "File not found or expired" });
  }
});


// POST /api/statements/annual/verify - Verify statement authenticity
app.post("/api/statements/annual/verify", async (req, res) => {
  try {
    const { userAddress, year, signature, pdfHash } = req.body;

    if (!userAddress || !year || !signature || !pdfHash) {
      return res.status(400).json({
        success: false,
        error: "userAddress, year, signature, and pdfHash are required",
      });
    }

    // For verification, we would need the original PDF content
    // This endpoint would typically be used with the PDF file upload
    const isValid = await annualVestingStatementService.verifyStatementSignature(
      userAddress,
      parseInt(year),
      signature,
      Buffer.from(pdfHash, 'hex')
    );

    res.json({
      success: true,
      data: {
        isValid,
        verifiedAt: new Date().toISOString(),
        statementId: `${userAddress}-${year}`,
      },
    });
  } catch (error) {
    console.error("Error verifying statement:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/statements/annual/:userAddress/:year/summary - Get statement summary only
app.get("/api/statements/annual/:userAddress/:year/summary", async (req, res) => {
  try {
    const { userAddress, year } = req.params;

    const summary = await annualVestingStatementService.getStatementStats(userAddress, parseInt(year));

    if (!summary) {
      return res.status(404).json({
        success: false,
        error: `Statement summary not found for ${userAddress} year ${year}`,
      });
    }

    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    console.error("Error getting statement summary:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/dividend/history/:userAddress - Get user dividend history
app.get("/api/dividend/history/:userAddress", async (req, res) => {
  try {
    const { userAddress } = req.params;
    const { limit = 50 } = req.query;

    const history = await dividendService.getUserDividendHistory(
      userAddress,
      parseInt(limit),
    );

    res.json({
      success: true,
      data: history,
    });
  } catch (error) {
    console.error("Error getting dividend history:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/admin/dividend/stats - Get dividend statistics
app.get(
  "/api/admin/dividend/stats",
  authService.authenticate(true),
  async (req, res) => {
    try {
      const stats = await dividendService.getStats();

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      console.error("Error getting dividend stats:", error);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  },
);

// ── Account Consolidation Routes ──────────────────────────────────────────────────
// Issue #134 #77: Account Merging and Schedule Consolidation

// GET /api/user/:address/consolidated - Get consolidated view for beneficiary
app.get("/api/user/:address/consolidated", async (req, res) => {
  try {
    const { address } = req.params;
    const {
      organizationId,
      tokenAddress,
      vaultAddresses,
      asOfDate
    } = req.query;

    // Parse array parameters
    let parsedVaultAddresses = null;
    if (vaultAddresses) {
      try {
        parsedVaultAddresses = Array.isArray(vaultAddresses)
          ? vaultAddresses
          : JSON.parse(vaultAddresses);
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: "vaultAddresses must be a valid JSON array"
        });
      }
    }

    // Parse date parameter
    let parsedAsOfDate = null;
    if (asOfDate) {
      parsedAsOfDate = new Date(asOfDate);
      if (isNaN(parsedAsOfDate.getTime())) {
        return res.status(400).json({
          success: false,
          error: "asOfDate must be a valid ISO date"
        });
      }
    }

    const consolidatedView = await accountConsolidationService.getConsolidatedView(address, {
      organizationId,
      tokenAddress,
      vaultAddresses: parsedVaultAddresses,
      asOfDate: parsedAsOfDate
    });

    // GET /api/dividend/history/:userAddress - Get user dividend history (cursor-based pagination)
    app.get('/api/dividend/history/:userAddress', async (req, res) => {
      try {
        const { userAddress } = req.params;
        const { cursor, limit = 50 } = req.query;

        // Validate cursor parameters
        const paginationOptions = validateCursorParams(req, 'created_at');

        const result = await paginateWithCursor(models.DividendDistribution, {
          cursor: paginationOptions.cursor,
          orderField: 'created_at',
          orderDirection: 'DESC',
          limit: paginationOptions.limit,
          where: { user_address: userAddress }
        });

        res.json({
          success: true,
          data: {
            dividend_history: result.items,
            pagination: result.pagination
          }
        });
      } catch (error) {
        console.error('Error getting dividend history:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    if (!Array.isArray(addressesToMerge) || addressesToMerge.length === 0) {
      return res.status(400).json({
        success: false,
        error: "addressesToMerge must be a non-empty array"
      });
    }

    const mergeResult = await accountConsolidationService.mergeBeneficiaryAddresses(
      primaryAddress,
      addressesToMerge,
      adminAddress
    );

    res.json({
      success: true,
      data: mergeResult
    });
  } catch (error) {
    console.error("Error consolidating accounts:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

// Sentry error handler must be before any other error middleware and after all controllers
if (process.env.SENTRY_DSN && Sentry.Handlers) {
  app.use(Sentry.Handlers.errorHandler());
}

const startServer = async () => {
  try {
    // Initialize secrets service first
    try {
      await secretsService.initialize();
      console.log('Secrets service initialized successfully.');
    } catch (secretsError) {
      console.error('Failed to initialize secrets service:', secretsError);
      console.log('Continuing with environment variables...');
    }

    // Get database connection with dynamic credentials
    const sequelize = await getSequelize();
    await sequelize.authenticate();
    console.log("Database connection established successfully.");

    // Attach the connection pool monitor (metrics + adaptive sizing — issue #8)
    try {
      const connectionPoolMonitor = require("./database/connectionPoolMonitor");
      connectionPoolMonitor.attach(sequelize);
      connectionPoolMonitor.start();
      console.log("Database connection pool monitor started.");
    } catch (poolMonitorError) {
      console.error("Failed to start DB pool monitor:", poolMonitorError.message);
    }

    // In test/CI the database is an ephemeral in-memory SQLite. Some models use
    // Postgres-only column types (ARRAY / JSONB) that SQLite cannot represent, so
    // a full sync can fail there. Tolerate sync errors in test mode so the server
    // can still boot for smoke tests; production (Postgres) syncs strictly.
    const isTestEnv = process.env.NODE_ENV === 'test';
    try {
      await sequelize.sync(isTestEnv ? { force: true } : {});
      console.log("Database synchronized successfully.");
    } catch (syncError) {
      if (isTestEnv) {
        console.warn("Database sync issue in test mode; continuing:", syncError.parent?.message || syncError.message);
      } else {
        throw syncError;
      }
    }

    // Initialize SEP-12 KYC Module
    try {
      const sep12Module = new SEP12Module({ sequelize });
      await sep12Module.initialize();
      sep12Module.registerRoutes(app);
      console.log('SEP-12 KYC Module initialized successfully.');
    } catch (sep12Error) {
      console.error('Failed to initialize SEP-12 KYC Module:', sep12Error);
      console.log('Continuing without SEP-12 KYC functionality...');
    }

    // Initialize Vesting Update WebSocket Server AFTER database is ready
    try {
      const VestingUpdateWebSocket = require('./websocket/vesting-update.websocket');
      const vestingUpdateWebSocket = new VestingUpdateWebSocket(httpServer);
      console.log('WebSocket server initialized successfully.');
    } catch (wsError) {
      console.error('Failed to initialize WebSocket:', wsError);
      console.log('Continuing with REST API only...');
    }

    // Initialize Dashboard Gateway for enhanced real-time updates
    try {
      const DashboardGateway = require('./websocket/dashboard-gateway.gateway');
      const dashboardGateway = new DashboardGateway(httpServer);
      console.log('Dashboard Gateway initialized successfully.');
    } catch (gatewayError) {
      console.error('Failed to initialize Dashboard Gateway:', gatewayError);
      console.log('Continuing without enhanced dashboard features...');
    }

    // Initialize Redis Cache
    try {
      await cacheService.connect();
      if (cacheService.isReady()) {
        console.log("Redis cache connected successfully.");
      } else {
        console.log("Redis cache not available, continuing without caching...");
      }
    } catch (cacheError) {
      console.error("Failed to connect to Redis:", cacheError);
      console.log("Continuing without Redis cache...");
    }

    // Initialize GraphQL Server
    let graphQLServer = null;
    try {
      const { GraphQLServer } = require("./graphql/server");
      graphQLServer = new GraphQLServer(app, httpServer);
      await graphQLServer.start();
      await graphQLServer.applyMiddleware(app);
      console.log("GraphQL Server initialized successfully.");

      const serverInfo = graphQLServer.getServerInfo();
      console.log(
        `GraphQL Playground available at: ${serverInfo.playgroundUrl}`,
      );
      console.log(
        `GraphQL Subscriptions available at: ${serverInfo.subscriptionEndpoint}`,
      );
    } catch (graphqlError) {
      console.error("Failed to initialize GraphQL Server:", graphqlError);
      console.log("Continuing with REST API only...");
    }

    // Initialize Discord Bot
    try {
      await discordBotService.start();
    } catch (discordError) {
      console.error("Failed to initialize Discord Bot:", discordError);
      console.log("Continuing without Discord bot...");
    }

    // Initialize Monthly Report Job
    try {
      monthlyReportJob.start();
    } catch (jobError) {
      console.error("Failed to initialize Monthly Report Job:", jobError);
    }

    // Initialize Vault Reconciliation Job
    const vaultReconciliationJob = new VaultReconciliationJob();
    try {
      vaultReconciliationJob.start();
      console.log("Vault Reconciliation Job started successfully.");
    } catch (jobError) {
      console.error("Failed to initialize Vault Reconciliation Job:", jobError);
    }

    // Initialize Notification Service
    try {
      notificationService.start();
      console.log("Notification service started successfully.");
    } catch (notificationError) {
      console.error(
        "Failed to initialize Notification Service:",
        notificationError,
      );
    }

    // Initialize Vault Registry Indexing Job
    try {
      vaultRegistryIndexingJob.start();
      console.log("Vault Registry Indexing Job started successfully.");
    } catch (jobError) {
      console.error("Failed to initialize Vault Registry Indexing Job:", jobError);
    }

    // Initialize Vault Balance Monitoring Job
    try {
      vaultBalanceMonitoringJob.start();
      console.log("Vault Balance Monitoring Job started successfully.");
    } catch (jobError) {
      console.error("Failed to initialize Vault Balance Monitoring Job:", jobError);
    }

    // Initialize Vesting State Reconciliation Job
    try {
      const vestingStateReconciliationJob = new VestingStateReconciliationJob();
      vestingStateReconciliationJob.start();
      console.log("Vesting State Reconciliation Job started successfully.");
    } catch (jobError) {
      console.error("Failed to initialize Vesting State Reconciliation Job:", jobError);
    }

    // Initialize claim webhook listener
    try {
      claimWebhookListenerService.start();
      console.log("Claim Webhook Listener started successfully.");
    } catch (listenerError) {
      console.error("Failed to initialize Claim Webhook Listener:", listenerError);
    }

    // Initialize Stellar Path Payment Listener
    try {
      stellarPathPaymentListener.start();
      console.log("Stellar Path Payment Listener started successfully.");
    } catch (listenerError) {
      console.error("Failed to initialize Stellar Path Payment Listener:", listenerError);
    }

    // Start background metrics collection
    setInterval(async () => {
      try {
        const { activeDbConnections, totalIndexedBlocks } = metricsService;
        const { writeSequelize } = require('./database/connection');
        if (writeSequelize && writeSequelize.connectionManager && writeSequelize.connectionManager.pool) {
          const activeConnections = writeSequelize.connectionManager.pool.size - writeSequelize.connectionManager.pool.available;
          activeDbConnections.set(activeConnections);
        }

        const { ClaimsHistory } = require('./models');
        const maxBlock = await ClaimsHistory.max('block_number');
        if (maxBlock) {
          totalIndexedBlocks.set(parseInt(maxBlock));
        }
      } catch (error) {
        console.error('Error updating metrics:', error);
      }
    }, 15000);

    // Start the HTTP server early so health checks respond immediately, without
    // waiting on network-dependent background services (Soroban RPC, etc.) that
    // may be slow or unavailable in some environments.
    httpServer.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`REST API available at: http://localhost:${PORT}`);
      if (graphQLServer) {
        console.log(`GraphQL API available at: http://localhost:${PORT}/graphql`);
      }
    });

    // Initialize Soroban Event Poller Service (after listen; it polls an RPC
    // endpoint and must not block the HTTP server from coming up).
    try {
      const SorobanEventPollerService = require('./services/sorobanEventPollerService');
      const SorobanEventProcessor = require('./services/sorobanEventProcessor');

      const sorobanEventPoller = new SorobanEventPollerService({
        pollInterval: parseInt(process.env.SOROBAN_POLL_INTERVAL) || 30000,
        batchSize: parseInt(process.env.SOROBAN_BATCH_SIZE) || 100,
        contractAddresses: process.env.SOROBAN_CONTRACT_ADDRESSES ?
          process.env.SOROBAN_CONTRACT_ADDRESSES.split(',') : []
      });

      const sorobanEventProcessor = new SorobanEventProcessor({
        batchSize: parseInt(process.env.SOROBAN_PROCESSOR_BATCH_SIZE) || 50,
        processingDelay: parseInt(process.env.SOROBAN_PROCESSOR_DELAY) || 1000
      });

      // Start both services
      await sorobanEventPoller.start();
      await sorobanEventProcessor.startProcessing();

      console.log("Soroban Event Poller and Processor services started successfully.");

      // Store services globally for access in routes
      global.sorobanEventPoller = sorobanEventPoller;
      global.sorobanEventProcessor = sorobanEventProcessor;

    } catch (sorobanError) {
      console.error("Failed to initialize Soroban Event services:", sorobanError);
      console.log("Continuing without Soroban event indexing...");
    }
  } catch (error) {
    console.error('Unable to start server:', error);
    process.exit(1);
  }
};

// ✅ Only start the server when run directly (not when imported by tests).
if (require.main === module) {
  // Start KYC expiration worker
  console.log('🔍 Starting KYC expiration monitoring worker...');
  kycExpirationWorker.start();

  // Start GDPR compliance job
  console.log('🔒 Starting GDPR compliance monitoring job...');
  const gdprJob = new gdprComplianceJob();
  gdprJob.start();

  // Start Historical Price Tracking Job (SEP-40)
  console.log('📊 Starting Historical Price Tracking Job...');
  historicalPriceTrackingJob.start();

  startServer();
}

module.exports = { app, startServer };
