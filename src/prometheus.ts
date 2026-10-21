import { SystemMetrics } from './types/order';

export interface ProcessMetrics {
  uptimeSeconds: number;
  memoryRssBytes: number;
  memoryHeapUsedBytes: number;
}

function value(input: number): string {
  return Number.isFinite(input) ? String(input) : '0';
}

function metric(name: string, type: 'counter' | 'gauge', help: string, sample: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value(sample)}\n`;
}

export function renderPrometheusMetrics(
  metrics: SystemMetrics,
  processMetrics: ProcessMetrics
): string {
  const timestampSeconds = metrics.timestamp.getTime() / 1000;
  return [
    metric(
      'dispatch_orders_processed_total',
      'counter',
      'Orders that have been assigned to a driver',
      metrics.totalOrdersProcessed
    ),
    metric(
      'dispatch_batches_created_total',
      'counter',
      'Batch assignments created',
      metrics.totalBatchesCreated
    ),
    metric(
      'dispatch_orders_pending',
      'gauge',
      'Orders currently waiting for a driver',
      metrics.pendingOrders
    ),
    metric(
      'dispatch_drivers_available',
      'gauge',
      'Drivers currently available for dispatch',
      metrics.activeDrivers
    ),
    metric(
      'dispatch_success_rate',
      'gauge',
      'Delivered orders divided by terminal orders',
      metrics.successRate
    ),
    metric(
      'dispatch_revenue_thb',
      'gauge',
      'Delivered order revenue in THB excluding refunds',
      metrics.totalRevenue
    ),
    metric(
      'dispatch_processing_time_ms',
      'gauge',
      'Average milliseconds from order creation to assignment',
      metrics.averageProcessingTime
    ),
    metric(
      'dispatch_delivery_time_ms',
      'gauge',
      'Average milliseconds from assignment to delivery',
      metrics.averageDeliveryTime
    ),
    metric(
      'process_uptime_seconds',
      'gauge',
      'Process uptime in seconds',
      processMetrics.uptimeSeconds
    ),
    metric(
      'process_resident_memory_bytes',
      'gauge',
      'Resident set size in bytes',
      processMetrics.memoryRssBytes
    ),
    metric(
      'process_heap_used_bytes',
      'gauge',
      'V8 heap used in bytes',
      processMetrics.memoryHeapUsedBytes
    ),
    `# HELP dispatch_metrics_timestamp_seconds Unix timestamp of the metrics snapshot\n# TYPE dispatch_metrics_timestamp_seconds gauge\ndispatch_metrics_timestamp_seconds ${timestampSeconds.toFixed(3)}\n`
  ].join('');
}
