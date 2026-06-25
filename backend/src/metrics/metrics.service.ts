import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Gauge, Counter, Histogram } from 'prom-client';
import * as connection from '../database/connection';
const indexingService = require('../services/indexingService');

@Injectable()
export class MetricsService implements OnModuleInit {
  constructor(
    @InjectMetric('active_database_connections') public readonly dbConnections: Gauge<string>,
    @InjectMetric('total_indexed_ledger_blocks') public readonly indexedBlocks: Gauge<string>,
    @InjectMetric('cache_operations_total') public readonly cacheOperations: Counter<string>,
    @InjectMetric('cache_operation_duration_seconds') public readonly cacheDuration: Histogram<string>,
  ) {}

  onModuleInit() {
    // Start interval to update metrics
    setInterval(() => {
      this.updateMetrics();
    }, 15000); // Update every 15 seconds
  }

  async updateMetrics() {
    try {
      // Update Database Connections
      const writeConn = connection.writeSequelize;
      const readConn = connection.readSequelize;

      if (writeConn && writeConn.connectionManager && writeConn.connectionManager.pool) {
          this.dbConnections.set({ type: 'write' }, writeConn.connectionManager.pool.size);
      }
      if (readConn && readConn.connectionManager && readConn.connectionManager.pool) {
          this.dbConnections.set({ type: 'read' }, readConn.connectionManager.pool.size);
      }

      // Update Indexed Blocks
      // We'll query the database for the max block number in ClaimsHistory as a proxy for indexed blocks
      const { ClaimsHistory } = require('../models');
      const maxBlock = await ClaimsHistory.max('block_number');
      if (maxBlock) {
        this.indexedBlocks.set(maxBlock);
      }
    } catch (error) {
      console.error('Error updating prometheus metrics:', error);
    }
  }
}
