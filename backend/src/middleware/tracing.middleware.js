'use strict';

const { context, propagation, trace, SpanStatusCode } = require('@opentelemetry/api');
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions');
const { v4: uuidv4 } = require('uuid');

/**
 * OpenTelemetry Tracing Middleware for Express
 * 
 * This middleware:
 * 1. Extracts trace context from incoming requests
 * 2. Creates a new span for each request with a unique TraceID
 * 3. Propagates the trace context through the application
 * 4. Records errors and status codes
 */

// Add UUID dependency check
let uuid;
try {
  uuid = require('uuid').v4;
} catch (error) {
  const logger = require('../utils/logger');
  logger.warn('UUID package not found, falling back to crypto.randomUUID');
  uuid = () => require('crypto').randomUUID();
}

const tracer = require('../services/telemetryService').getTracer('express-middleware');

/**
 * Generate or extract TraceID from request
 */
function getOrCreateTraceId(req) {
  // Check for existing trace ID in headers
  const traceparent = req.headers['traceparent'];
  if (traceparent && typeof traceparent === 'string') {
    // traceparent format: version-trace_id-parent_id-trace_flags
    const parts = traceparent.split('-');
    if (parts.length >= 2) {
      return parts[1];
    }
  }

  // Check for custom trace ID header
  const customTraceId = req.headers['x-trace-id'] || req.headers['x-request-id'];
  if (customTraceId) {
    return customTraceId;
  }

  // Generate new trace ID
  return uuid();
}

/**
 * OpenTelemetry tracing middleware
 */
const tracingMiddleware = (req, res, next) => {
  const traceId = getOrCreateTraceId(req);
  
  // Set trace ID in response headers for client reference
  res.setHeader('X-Trace-ID', traceId);
  
  // Extract context from incoming headers
  const extractedContext = propagation.extract(context.active(), req.headers);
  
  // Create a new span for this request
  const span = tracer.startSpan(`${req.method} ${req.path}`, {
    attributes: {
      [SemanticAttributes.HTTP_METHOD]: req.method,
      [SemanticAttributes.HTTP_TARGET]: req.path,
      [SemanticAttributes.HTTP_URL]: req.url,
      [SemanticAttributes.HTTP_ROUTE]: req.route?.path || req.path,
      'http.request_id': traceId,
      'http.user_agent': req.headers['user-agent'],
      'http.client_ip': req.ip || req.connection.remoteAddress,
    },
  }, extractedContext);

  // Record request body size if available
  if (req.headers['content-length']) {
    span.setAttribute('http.request_content_length', parseInt(req.headers['content-length']));
  }

  // Track response finish
  res.on('finish', () => {
    span.setAttribute(SemanticAttributes.HTTP_STATUS_CODE, res.statusCode);
    
    // Record response size
    if (res.getHeader('content-length')) {
      span.setAttribute('http.response_content_length', parseInt(res.getHeader('content-length')));
    }

    // Mark span as error if status code >= 400
    if (res.statusCode >= 400) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `HTTP ${res.statusCode}`,
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end();
  });

  // Track response errors
  res.on('error', (error) => {
    span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error.message,
    });
    span.end();
  });

  // Set trace context for the rest of the request lifecycle
  context.with(trace.setSpan(extractedContext, span), () => {
    // Make trace ID available in request object
    req.traceId = traceId;
    req.span = span;
    
    next();
  });
};

/**
 * Helper function to wrap async service calls with tracing
 * @param {string} operationName - Name of the operation
 * @param {Function} fn - Async function to wrap
 * @param {Object} attributes - Additional span attributes
 */
function traceOperation(operationName, fn, attributes = {}) {
  return async function (...args) {
    const span = tracer.startSpan(operationName, {
      attributes: {
        ...attributes,
        'operation.type': operationName,
      },
    });

    try {
      const result = await fn(...args);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
      throw error;
    } finally {
      span.end();
    }
  };
}

/**
 * Helper function to add trace context to outgoing HTTP requests
 * @param {Object} headers - Existing headers object
 */
function injectTraceHeaders(headers = {}) {
  return propagation.inject(context.active(), headers);
}

module.exports = {
  tracingMiddleware,
  traceOperation,
  injectTraceHeaders,
};
