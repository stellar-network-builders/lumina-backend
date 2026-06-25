const { Worker } = require('bullmq');
const ioredis = require('ioredis');
const { context: otelContext } = require('@opentelemetry/api');
const TracingUtils = require('../tracing/tracingUtils');

const connection = new ioredis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const worker = new Worker('heavy-computation', async (job) => {
  // Extract trace context from job data for distributed tracing
  const parentContext = TracingUtils.extractTraceContext(job.data);

  // Execute within the extracted trace context to link spans to the originating request
  const executeInContext = parentContext
    ? () => {
        return otelContext.with(parentContext, async () => {
          return TracingUtils.traceBullMQJob(
            job.name || 'heavy-computation',
            'processing',
            async () => {
              console.log(`Processing heavy computation job ${job.id}`);
              // TODO: Implement actual computation logic
              return { success: true };
            },
            { 'messaging.message_id': job.id }
          );
        });
      }
    : () => TracingUtils.traceBullMQJob(
        job.name || 'heavy-computation',
        'processing',
        async () => {
          console.log(`Processing heavy computation job ${job.id}`);
          // TODO: Implement actual computation logic
          return { success: true };
        },
        { 'messaging.message_id': job.id }
      );

  return executeInContext();
}, { connection });

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed successfully`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed with error: ${err.message}`);
});

module.exports = worker;
