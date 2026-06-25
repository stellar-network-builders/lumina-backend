const { trace, SpanStatusCode, SpanKind, propagation, context } = require('@opentelemetry/api');

const tracer = trace.getTracer('vesting-vault-backend');

class TracingUtils {
  static async traceAsyncOperation(name, operation, attributes = {}) {
    const span = tracer.startSpan(name, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'service.name': 'vesting-vault-backend',
        ...attributes
      }
    });

    try {
      const result = await operation();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error.message
      });
      span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  }

  static traceDatabaseQuery(queryType, tableName, queryFn) {
    return this.traceAsyncOperation(
      `database.query.${queryType}`,
      queryFn,
      {
        'db.type': 'postgresql',
        'db.table': tableName,
        'db.operation': queryType
      }
    );
  }

  static traceRedisOperation(operationType, keyPattern, operationFn) {
    return this.traceAsyncOperation(
      `redis.${operationType}`,
      operationFn,
      {
        'cache.type': 'redis',
        'cache.operation': operationType,
        'cache.key_pattern': keyPattern
      }
    );
  }

  static traceExternalAPICall(serviceName, endpoint, method, operationFn) {
    return this.traceAsyncOperation(
      `external_api.${serviceName}.${method}`,
      operationFn,
      {
        'http.method': method,
        'http.url': endpoint,
        'external_service.name': serviceName
      }
    );
  }

  static traceBusinessOperation(operationName, operationFn, attributes = {}) {
    return this.traceAsyncOperation(
      `business.${operationName}`,
      operationFn,
      {
        'operation.type': 'business_logic',
        ...attributes
      }
    );
  }

  /**
   * Trace a GraphQL resolver execution with operation and field name attributes.
   * @param {string} operationName - GraphQL operation name (query/mutation)
   * @param {string} fieldName - GraphQL field name being resolved
   * @param {Function} resolverFn - The resolver function to wrap
   * @param {Object} args - Resolver arguments for attributes
   * @returns {Promise<any>} Resolver result
   */
  static async traceGraphQLResolver(operationName, fieldName, resolverFn, args = {}) {
    return this.traceAsyncOperation(
      `graphql.${operationName}.${fieldName}`,
      resolverFn,
      {
        'graphql.operation.name': operationName,
        'graphql.field.name': fieldName,
        'graphql.operation.type': 'graphql',
        ...(args.userAddress ? { 'user.address': args.userAddress } : {}),
        ...(args.vaultId ? { 'vault.id': args.vaultId } : {}),
      }
    );
  }

  /**
   * Trace a Soroban RPC call with method and params context.
   * Links to the parent request context for end-to-end tracing.
   * @param {string} method - RPC method name
   * @param {Object} params - RPC parameters
   * @param {string} endpoint - RPC endpoint URL
   * @param {Function} operationFn - The RPC call function
   * @returns {Promise<any>} RPC response
   */
  static async traceSorobanRPCCall(method, params, endpoint, operationFn) {
    return this.traceAsyncOperation(
      `soroban_rpc.${method}`,
      operationFn,
      {
        'rpc.method': method,
        'rpc.endpoint': endpoint,
        'rpc.service': 'soroban',
        'rpc.params_keys': Object.keys(params).join(','),
      }
    );
  }

  /**
   * Trace a circuit breaker state transition as a span event.
   * Records state changes to aid debugging of resilience behavior.
   * @param {string} fromState - Previous circuit breaker state
   * @param {string} toState - New circuit breaker state
   * @param {string} reason - Reason for the transition
   * @param {Object} extra - Additional attributes
   */
  static recordCircuitBreakerTransition(fromState, toState, reason, extra = {}) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.addEvent('circuit_breaker.state_change', {
        'circuit_breaker.from_state': fromState,
        'circuit_breaker.to_state': toState,
        'circuit_breaker.reason': reason,
        ...extra,
      });
    }
  }

  /**
   * Trace a BullMQ job lifecycle event.
   * @param {string} jobName - Name of the job/queue
   * @param {string} eventType - Event type (enqueued, processing, completed, failed)
   * @param {Function} operationFn - The job processing function
   * @param {Object} attributes - Additional span attributes
   * @returns {Promise<any>} Job result
   */
  static async traceBullMQJob(jobName, eventType, operationFn, attributes = {}) {
    return this.traceAsyncOperation(
      `bullmq.${jobName}.${eventType}`,
      operationFn,
      {
        'messaging.system': 'bullmq',
        'messaging.destination': jobName,
        'messaging.operation': eventType,
        ...attributes,
      }
    );
  }

  /**
   * Extract trace context from incoming message/job data for propagation.
   * Used by workers to create child spans linked to originating requests.
   * @param {Object} jobData - Job data that may contain traceparent header
   * @returns {import('@opentelemetry/api').Context|null} Extracted context or null
   */
  static extractTraceContext(jobData) {
    if (!jobData || !jobData._traceContext) {
      return null;
    }
    try {
      return propagation.extract(context.active(), jobData._traceContext);
    } catch (err) {
      return null;
    }
  }

  /**
   * Inject trace context into job data for propagation to workers.
   * Used when enqueuing jobs to pass trace context downstream.
   * @param {Object} jobData - Job data to inject trace context into
   * @returns {Object} Job data with injected trace context
   */
  static injectTraceContext(jobData) {
    const carrier = {};
    propagation.inject(context.active(), carrier);
    return {
      ...jobData,
      _traceContext: carrier,
    };
  }

  static addSpanAttributes(attributes) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      Object.entries(attributes).forEach(([key, value]) => {
        activeSpan.setAttribute(key, value);
      });
    }
  }

  static addSpanEvent(name, attributes = {}) {
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      activeSpan.addEvent(name, attributes);
    }
  }
}

module.exports = TracingUtils;
