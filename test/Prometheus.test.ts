import { renderPrometheusMetrics } from '../src/prometheus';

test('renders metrics in Prometheus text format', () => {
  const output = renderPrometheusMetrics(
    {
      totalOrdersProcessed: 12,
      totalBatchesCreated: 4,
      averageProcessingTime: 150.5,
      averageDeliveryTime: 240000,
      successRate: 0.75,
      totalRevenue: 1250,
      activeDrivers: 2,
      pendingOrders: 3,
      timestamp: new Date('2026-10-20T12:00:00.000Z')
    },
    {
      uptimeSeconds: 60,
      memoryRssBytes: 50_000_000,
      memoryHeapUsedBytes: 20_000_000
    }
  );

  expect(output).toContain('# TYPE dispatch_orders_processed_total counter');
  expect(output).toContain('dispatch_orders_processed_total 12');
  expect(output).toContain('dispatch_orders_pending 3');
  expect(output).toContain('dispatch_success_rate 0.75');
  expect(output).toContain('dispatch_revenue_thb 1250');
  expect(output).toContain('process_uptime_seconds 60');
  expect(output).toContain('process_resident_memory_bytes 50000000');
  expect(output).toContain('dispatch_metrics_timestamp_seconds 1792497600.000');
});

test('replaces non-finite values with zero', () => {
  const output = renderPrometheusMetrics(
    {
      totalOrdersProcessed: Number.NaN,
      totalBatchesCreated: Number.POSITIVE_INFINITY,
      averageProcessingTime: 0,
      averageDeliveryTime: 0,
      successRate: 0,
      totalRevenue: 0,
      activeDrivers: 0,
      pendingOrders: 0,
      timestamp: new Date('2026-10-20T12:00:00.000Z')
    },
    { uptimeSeconds: 0, memoryRssBytes: 0, memoryHeapUsedBytes: 0 }
  );

  expect(output).toContain('dispatch_orders_processed_total 0');
  expect(output).toContain('dispatch_batches_created_total 0');
});
