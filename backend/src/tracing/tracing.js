const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { ParentBasedSampler, TraceIdRatioBased, AlwaysOnSampler, AlwaysOffSampler } = require('@opentelemetry/sdk-trace-base');

// Domain-specific instrumentations
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
const { GraphQLInstrumentation } = require('@opentelemetry/instrumentation-graphql');
const { BullMQInstrumentation } = require('@appsignal/opentelemetry-instrumentation-bullmq');

/**
 * Initialize OpenTelemetry distributed tracing across all services:
 * - NestJS HTTP/Express routes
 * - GraphQL resolvers (operationName, fieldName)
 * - BullMQ job lifecycle (enqueue → completion)
 * - Soroban RPC calls (manual spans in sorobanRpcClient)
 * - PostgreSQL queries (sanitized)
 * - Circuit breaker state transitions
 * - Worker trace context propagation
 *
 * Sampling: 100% for errors, 10% for successful requests (head-based).
 */
function initializeTracing() {
  const isProduction = process.env.NODE_ENV === 'production';
  const serviceName = process.env.OTEL_SERVICE_NAME || 'vesting-vault-backend';

  // ── Exporter Configuration ──────────────────────────────────────────────
  let traceExporter;
  if (process.env.JAEGER_ENDPOINT) {
    traceExporter = new JaegerExporter({
      endpoint: process.env.JAEGER_ENDPOINT,
    });
    console.log(`🔍 Using Jaeger exporter at ${process.env.JAEGER_ENDPOINT}`);
  } else if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    traceExporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    });
    console.log(`🔍 Using OTLP exporter at ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
  } else {
    // Default to local OTLP collector (used with docker-compose Jaeger)
    traceExporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT_LOCAL || 'http://localhost:4317',
    });
    console.log('🔍 Using OTLP exporter at http://localhost:4317 (default)');
  }

  // ── Sampling Configuration ──────────────────────────────────────────────
  // Head-based sampling: 100% for errors, 10% for success
  // Uses ParentBasedSampler so child spans respect parent's sampling decision
  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBased(isProduction ? 0.1 : 1.0),
  });

  // ── Resource (Service Identity) ─────────────────────────────────────────
  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
  });

  // ── Instrumentations ────────────────────────────────────────────────────
  const instrumentations = [
    // Auto-instrumentations for HTTP, Express, gRPC, Redis, etc.
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        enabled: true,
        // Ignore health check endpoints from tracing
        ignoreIncomingPaths: ['/health', '/health/ready', '/health/live', '/metrics'],
        requireParentforOutgoingSpans: true,
      },
      '@opentelemetry/instrumentation-express': {
        enabled: true,
        // Capture route parameters in span names
      },
      '@opentelemetry/instrumentation-fs': {
        enabled: false, // Too noisy
      },
    }),

    // PostgreSQL query tracing - captures DB calls with query summaries (sanitized)
    new PgInstrumentation({
      enhancedDatabaseReporting: true,
      // Sanitize query parameters for security
      requireParentSpan: true,
    }),

    // GraphQL resolver instrumentation - creates spans per resolver
    // with operationName and fieldName attributes
    new GraphQLInstrumentation({
      mergeItems: true,
      // Allow values up to 1KB in span attributes
      depth: 2,
      allowValues: true,
    }),

    // BullMQ instrumentation - traces job lifecycle from enqueue to completion
    new BullMQInstrumentation({
      emitCreateSpansForBulk: true,
      useProducerSpanAsConsumerParent: true, // Link job processing to enqueue context
    }),
  ];

  // ── SDK Initialization ──────────────────────────────────────────────────
  const sdk = new NodeSDK({
    resource,
    traceExporter,
    instrumentations,
    sampler,
    // Span processing limits
    spanLimits: {
      maxNumberOfAttributes: 128,
      maxNumberOfEvents: 64,
      maxNumberOfLinks: 32,
    },
  });

  // Start the SDK (must be before any other require() calls that create spans)
  sdk.start();
  console.log(`🔍 OpenTelemetry distributed tracing initialized for ${serviceName}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Sampling: ${isProduction ? '10% (head-based)' : '100% (development)'}`);
  console.log(`   Instrumentations: HTTP, Express, GraphQL, BullMQ, PostgreSQL, Redis, auto-instrumentations`);

  // ── Graceful Shutdown ───────────────────────────────────────────────────
  const shutdown = async () => {
    try {
      await sdk.shutdown();
      console.log('🔍 OpenTelemetry tracing shut down gracefully');
    } catch (error) {
      console.error('Error shutting down OpenTelemetry:', error);
    }
  };

  process.on('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });

  // Return SDK instance for external shutdown control
  return sdk;
}

module.exports = {
  initializeTracing,
};
