const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-otlp-grpc');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { ParentBasedSampler, TraceIdRatioBasedSampler } = require('@opentelemetry/sdk-trace-node');

// Initialize OpenTelemetry tracing
function initializeTracing() {
  const isProduction = process.env.NODE_ENV === 'production';
  const serviceName = process.env.OTEL_SERVICE_NAME || 'vesting-vault-backend';
  
  // Choose exporter based on environment
  let traceExporter;
  if (process.env.JAEGER_ENDPOINT) {
    traceExporter = new JaegerExporter({
      endpoint: process.env.JAEGER_ENDPOINT,
    });
  } else if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    traceExporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    });
  } else {
    // Default to OTLP gRPC for development (points to Jaeger in docker-compose)
    traceExporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_GRPC_ENDPOINT || 'http://localhost:4317',
    });
  }

  // Head-based sampler: 100% for errors, configurable ratio for success
  // In production: 10% of successful traces, 100% of errors
  // In development: 100% of all traces
  const successSampleRatio = isProduction
    ? parseFloat(process.env.OTEL_TRACES_SAMPLE_RATE || '0.1')
    : 1.0;

  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(successSampleRatio),
  });

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
    }),
    traceExporter,
    sampler,
    instrumentations: [getNodeAutoInstrumentations({
      // Enable http and express for NestJS HTTP request tracing
      '@opentelemetry/instrumentation-http': {
        enabled: true,
        ignoreIncomingPaths: ['/health', '/health/ready', '/health/live', '/metrics'],
      },
      '@opentelemetry/instrumentation-express': {
        enabled: true,
      },
      // Enable pg for PostgreSQL query tracing
      '@opentelemetry/instrumentation-pg': {
        enabled: true,
        enhancedDatabaseReporting: true,
      },
      // Disable noisy instrumentations
      '@opentelemetry/instrumentation-fs': {
        enabled: false,
      },
      '@opentelemetry/instrumentation-net': {
        enabled: false,
      },
      '@opentelemetry/instrumentation-dns': {
        enabled: false,
      },
    })],
    // Auto-detect resources from environment
    autoDetectResources: true,
  });

  // Initialize the SDK before other modules load
  sdk.start();

  console.log(`🔍 OpenTelemetry tracing initialized (sampling: ${(successSampleRatio * 100).toFixed(0)}%, env: ${process.env.NODE_ENV || 'development'})`);
  
  // Graceful shutdown
  const shutdown = async () => {
    try {
      await sdk.shutdown();
      console.log('🔍 OpenTelemetry tracing shut down');
    } catch (error) {
      console.error('Error shutting down OpenTelemetry', error);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return sdk;
}

module.exports = {
  initializeTracing,
};
