// src/services/telemetryService.js
const logger = require('../utils/logger');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

let tracer = null;
let sdk = null;

const initTelemetry = () => {
  if (tracer) return tracer;

  // Configuration for OpenTelemetry
  const OTEL_CONFIG = {
    serviceName: process.env.OTEL_SERVICE_NAME || 'vesting-vault-backend',
    enableConsoleExport: process.env.OTEL_CONSOLE_EXPORT === 'true',
  };

  sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: OTEL_CONFIG.serviceName,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  try {
    sdk.start();
    logger.info(`✅ OpenTelemetry SDK started successfully for service: ${OTEL_CONFIG.serviceName}`);
  } catch (error) {
    logger.error('❌ Failed to initialize OpenTelemetry SDK:', error);
  }

  tracer = require('@opentelemetry/api').trace.getTracer('vesting-vault-api');
  return tracer;
};

const getTracer = (name = 'vesting-vault-api') => {
  if (!tracer) initTelemetry();
  return require('@opentelemetry/api').trace.getTracer(name);
};

module.exports = {
  getTracer,
  initTelemetry,
};
