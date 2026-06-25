import { Module } from '@nestjs/common';
import { PrometheusModule, makeGaugeProvider, makeCounterProvider, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { MetricsService } from './metrics.service';

@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      defaultMetrics: {
        enabled: true,
      },
    }),
  ],
  providers: [
    MetricsService,
    makeGaugeProvider({
      name: 'active_database_connections',
      help: 'Number of active database connections',
      labelNames: ['type'],
    }),
    makeGaugeProvider({
      name: 'total_indexed_ledger_blocks',
      help: 'Total number of indexed ledger blocks',
    }),
    makeCounterProvider({
      name: 'cache_operations_total',
      help: 'Total number of cache operations (hits/misses/sets/invalidations)',
      labelNames: ['operation', 'key_prefix', 'status'],
    }),
    makeHistogramProvider({
      name: 'cache_operation_duration_seconds',
      help: 'Duration of cache operations in seconds',
      labelNames: ['operation', 'key_prefix'],
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
    }),
  ],
})
export class MetricsModule {}
