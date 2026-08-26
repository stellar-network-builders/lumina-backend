// Initialize OpenTelemetry tracing.
//
// Dependencies are required lazily inside the function and guarded by try/catch
// so that a missing/optional OpenTelemetry package can never break module load
// (which previously failed the entire test suite when an exporter package was
// absent). If tracing can't be initialized it degrades to a no-op.
function initializeTracing() {
  let NodeSDK, getNodeAutoInstrumentations, OTLPTraceExporter, JaegerExporter, Resource, SemanticResourceAttributes;
  let TraceIdRatioBasedSampler, ParentBasedSampler;
  let logger;
  try {
    ({ NodeSDK } = require('@opentelemetry/sdk-node'));
    ({ getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node'));
    // Modern package name (the legacy "@opentelemetry/exporter-otlp-grpc" is deprecated).
    ({ OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc'));
    ({ JaegerExporter } = require('@opentelemetry/exporter-jaeger'));
    ({ Resource } = require('@opentelemetry/resources'));
    ({ SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions'));
    ({ TraceIdRatioBasedSampler, ParentBasedSampler } = require('@opentelemetry/sdk-trace-base'));
    logger = require('../utils/logger');
  } catch (err) {
    try { logger = require('../utils/logger'); } catch (_) {}
    if (logger) logger.warn('OpenTelemetry tracing disabled (dependency unavailable):', err.message);
    else logger.warn('OpenTelemetry tracing disabled (dependency unavailable):', err.message);
    return null;
  }

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
    // Default to console exporter for development
    traceExporter = new OTLPTraceExporter({
      url: 'http://localhost:4317',
    });
  }

  try {
    const sdk = new NodeSDK({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || '1.0.0',
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
      }),
      traceExporter,
      instrumentations: [getNodeAutoInstrumentations({
        // Disable some instrumentations if not needed
        '@opentelemetry/instrumentation-fs': {
          enabled: false,
        },
      })],
      // Sampling configuration — must be a Sampler instance (a plain
      // { type, ratio } object has no shouldSample() and crashes span creation).
      // 10% sampling in production, 100% in development; respect parent decisions.
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(isProduction ? 0.1 : 1.0),
      }),
    });

    // Initialize the SDK
    sdk.start();

    logger.info('OpenTelemetry tracing initialized');

    // Graceful shutdown
    process.on('SIGTERM', () => {
      sdk.shutdown()
        .then(() => logger.info('OpenTelemetry tracing shut down'))
        .catch((error) => logger.error('Error shutting down OpenTelemetry', error))
        .finally(() => process.exit(0));
    });

    return sdk;
  } catch (err) {
    logger.warn('OpenTelemetry tracing failed to start, continuing without it:', err.message);
    return null;
  }
}

module.exports = {
  initializeTracing,
};
