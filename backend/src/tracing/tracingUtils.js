const { trace, SpanStatusCode, SpanKind, context, propagation } = require('@opentelemetry/api');

const tracer = trace.getTracer('vesting-vault-backend');

class TracingUtils {
  /**
   * Trace an async operation with automatic success/error status
   */
  static async traceAsyncOperation(name, operation, attributes = {}) {
    const span = tracer.startSpan(name, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'service.name': 'vesting-vault-backend',
        ...attributes,
      },
    });

    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Trace a database query with PostgreSQL-specific attributes
   */
  static traceDatabaseQuery(queryType, tableName, queryFn) {
    return this.traceAsyncOperation(
      `database.query.${queryType}`,
      queryFn,
      {
        'db.type': 'postgresql',
        'db.table': tableName,
        'db.operation': queryType,
      }
    );
  }

  /**
   * Trace a Redis operation
   */
  static traceRedisOperation(operationType, keyPattern, operationFn) {
    return this.traceAsyncOperation(
      `redis.${operationType}`,
      operationFn,
      {
        'cache.type': 'redis',
        'cache.operation': operationType,
        'cache.key_pattern': keyPattern,
      }
    );
  }

  /**
   * Trace an external API call (includes Soroban RPC)
   */
  static traceExternalAPICall(serviceName, endpoint, method, operationFn) {
    return this.traceAsyncOperation(
      `external_api.${serviceName}.${method}`,
      operationFn,
      {
        'http.method': method,
        'http.url': endpoint,
        'external_service.name': serviceName,
      }
    );
  }

  /**
   * Trace a Soroban RPC call with method and params attributes
   * Links to parent request context automatically.
   */
  static traceSorobanRpcCall(rpcMethod, params, operationFn) {
    return this.traceAsyncOperation(
      `soroban_rpc.${rpcMethod}`,
      operationFn,
      {
        'rpc.method': rpcMethod,
        'rpc.system': 'stellar_soroban',
        'rpc.params_summary': JSON.stringify(params).substring(0, 256),
      }
    );
  }

  /**
   * Trace a business logic operation
   */
  static traceBusinessOperation(operationName, operationFn, attributes = {}) {
    return this.traceAsyncOperation(
      `business.${operationName}`,
      operationFn,
      {
        'operation.type': 'business_logic',
        ...attributes,
      }
    );
  }

  /**
   * Add attributes to the currently active span
   */
  static addSpanAttributes(attributes) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      Object.entries(attributes).forEach(([key, value]) => {
        activeSpan.setAttribute(key, value);
      });
    }
  }

  /**
   * Add a named event to the currently active span
   */
  static addSpanEvent(name, attributes = {}) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.addEvent(name, attributes);
    }
  }

  /**
   * Record a circuit breaker state change as a span event.
   * Call this from circuit breaker onStateChange handlers.
   */
  static recordCircuitBreakerEvent(eventName, details = {}) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.addEvent(`circuit_breaker.${eventName}`, {
        'circuit_breaker.state': details.state || 'unknown',
        'circuit_breaker.failures': details.failureCount || 0,
        'circuit_breaker.reason': details.reason || '',
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Extract trace context from job/carrier for worker propagation.
   * Use this when starting a BullMQ worker to link the job to the originating request.
   *
   * @param {Object} carrier - Object containing trace context (e.g., job data with traceparent)
   * @returns {Object} OpenTelemetry context object, or undefined if no context found
   */
  static extractTraceContext(carrier) {
    if (!carrier) return undefined;
    try {
      return propagation.extract(context.active(), carrier);
    } catch (err) {
      // If extraction fails (e.g., malformed traceparent), return undefined
      return undefined;
    }
  }

  /**
   * Inject trace context into a carrier for propagation to workers.
   * Use this when enqueuing a job to propagate the current trace context.
   *
   * @param {Object} carrier - Object to inject trace context into (e.g., job data)
   */
  static injectTraceContext(carrier) {
    if (!carrier) return;
    try {
      propagation.inject(context.active(), carrier);
    } catch (err) {
      // If injection fails, continue without tracing
    }
  }

  /**
   * Create a span for a worker job with trace context propagated from the producer.
   *
   * @param {string} jobName - Name of the worker job
   * @param {Object} jobData - Job data from BullMQ (may contain trace context)
   * @param {Function} jobFn - The worker's processing function
   * @returns {Promise<any>} Result of the job function
   */
  static async traceWorkerJob(jobName, jobData, jobFn) {
    // Extract trace context from job data if present
    const parentContext = this.extractTraceContext(jobData);
    const spanOptions = {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'bullmq',
        'messaging.operation': 'process',
        'messaging.destination': jobName,
        'worker.job_name': jobName,
      },
    };

    // If we have parent context, link the span
    const span = parentContext
      ? tracer.startSpan(`worker.${jobName}`, spanOptions, parentContext)
      : tracer.startSpan(`worker.${jobName}`, spanOptions);

    try {
      const result = await jobFn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message,
      });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }
}

module.exports = TracingUtils;
