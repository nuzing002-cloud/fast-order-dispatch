import { Server } from 'http';
import { AddressInfo } from 'net';
import { createDispatchApp } from '../src/index';
import { BatchProcessingService } from '../src/services/BatchProcessingService';
import { MemoryDispatchStore } from '../src/store/DispatchStore';
import { DriverEarning, Order, OrderStatus, PaymentStatus } from '../src/types/order';
import { makeOrder } from './helpers';

let server: Server;
let baseUrl: string;
let store: MemoryDispatchStore;

const adminKey = 'kpi-admin';
const viewerKey = 'kpi-viewer';
const operatorKey = 'kpi-operator';
const from = '2025-01-01T00:00:00.000Z';
const to = '2025-01-03T16:59:59.999Z';

function reportOrder(id: string, overrides: Partial<Order>): Order {
  return { ...makeOrder(id), ...overrides };
}

function request(path: string, key?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: key ? { 'x-api-key': key } : undefined
  });
}

beforeAll(async () => {
  store = new MemoryDispatchStore();
  const service = new BatchProcessingService(3, store);
  const app = createDispatchApp({
    service,
    apiKeys: [
      { key: adminKey, role: 'admin', label: 'admin' },
      { key: viewerKey, role: 'viewer', label: 'viewer' },
      { key: operatorKey, role: 'operator', label: 'operator' }
    ],
    apiKey: undefined
  });
  const orders = [
    reportOrder('delivered-on-time', {
      createdAt: new Date('2025-01-01T03:00:00.000Z'),
      queuedAt: new Date('2025-01-01T03:10:00.000Z'),
      assignedAt: new Date('2025-01-01T03:20:00.000Z'),
      pickedUpAt: new Date('2025-01-01T04:00:00.000Z'),
      deliveredAt: new Date('2025-01-01T05:00:00.000Z'),
      estimatedDeliveryTime: new Date('2025-01-01T05:30:00.000Z'),
      assignedDriverId: 'driver-1',
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.COMPLETED
    }),
    reportOrder('delivered-late-refunded', {
      createdAt: new Date('2025-01-02T03:00:00.000Z'),
      queuedAt: new Date('2025-01-02T03:30:00.000Z'),
      assignedAt: new Date('2025-01-02T03:40:00.000Z'),
      pickedUpAt: new Date('2025-01-02T05:00:00.000Z'),
      deliveredAt: new Date('2025-01-02T06:00:00.000Z'),
      estimatedDeliveryTime: new Date('2025-01-02T05:30:00.000Z'),
      assignedDriverId: 'driver-1',
      deliveryFee: 35,
      totalAmount: 200,
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.REFUNDED
    }),
    reportOrder('delivered-missing-times-refunded', {
      createdAt: new Date('2025-01-02T04:00:00.000Z'),
      deliveredAt: new Date('2025-01-02T05:00:00.000Z'),
      assignedDriverId: 'driver-2',
      deliveryFee: 10,
      status: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.REFUNDED
    }),
    reportOrder('cancelled', {
      createdAt: new Date('2025-01-02T02:00:00.000Z'),
      status: OrderStatus.CANCELLED
    }),
    reportOrder('failed', {
      createdAt: new Date('2025-01-03T02:00:00.000Z'),
      status: OrderStatus.FAILED
    }),
    reportOrder('in-progress', {
      createdAt: new Date('2025-01-03T03:00:00.000Z'),
      status: OrderStatus.IN_DELIVERY
    }),
    reportOrder('outside-range', {
      createdAt: new Date('2024-12-31T16:59:59.000Z'),
      status: OrderStatus.DELIVERED
    })
  ];
  await store.transaction(async (tx) => {
    for (const order of orders) await tx.insertOrder(order);
    const earnings: DriverEarning[] = [
      {
        id: 'earning-1',
        orderId: 'delivered-on-time',
        driverId: 'driver-1',
        amount: 22.4,
        currency: 'THB',
        status: 'PENDING',
        createdAt: new Date('2025-01-01T05:00:00.000Z')
      },
      {
        id: 'earning-2',
        orderId: 'delivered-late-refunded',
        driverId: 'driver-1',
        amount: 28,
        currency: 'THB',
        status: 'PENDING',
        createdAt: new Date('2025-01-02T06:00:00.000Z')
      },
      {
        id: 'earning-3',
        orderId: 'delivered-missing-times-refunded',
        driverId: 'driver-2',
        amount: 8,
        currency: 'THB',
        status: 'PENDING',
        createdAt: new Date('2025-01-02T05:00:00.000Z')
      }
    ];
    for (const earning of earnings) await tx.insertEarning(earning);
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

test('restricts KPI reports to admin keys', async () => {
  expect((await request('/metrics/kpi')).status).toBe(401);
  expect((await request('/metrics/kpi', viewerKey)).status).toBe(403);
  expect((await request('/metrics/kpi', operatorKey)).status).toBe(403);
  expect((await request('/metrics/kpi', adminKey)).status).toBe(200);
});

test('validates date range input and defaults to seven Bangkok calendar days', async () => {
  const cases = [
    '/metrics/kpi?from=2025-01-01T00%3A00%3A00.000Z',
    '/metrics/kpi?from=not-a-date&to=2025-01-03T00%3A00%3A00.000Z',
    '/metrics/kpi?from=2025-02-30T00%3A00%3A00Z&to=2025-03-01T00%3A00%3A00Z',
    '/metrics/kpi?from=2025-01-02T00%3A00%3A00.000Z&to=2025-01-01T00%3A00%3A00.000Z',
    '/metrics/kpi?from=2025-01-01T00%3A00%3A00.000Z&to=2025-04-02T00%3A00%3A00.000Z'
  ];
  for (const path of cases) {
    expect((await request(path, adminKey)).status).toBe(400);
  }

  expect(
    (
      await request(
        '/metrics/kpi?from=2025-01-01T00%3A00%3A00.000Z&to=2025-04-01T00%3A00%3A00.000Z',
        adminKey
      )
    ).status
  ).toBe(200);

  const response = await request('/metrics/kpi', adminKey);
  const report = await response.json();
  const start = new Date(report.range.from);
  const end = new Date(report.range.to);
  expect(start.toISOString()).toMatch(/T17:00:00\.000Z$/);
  expect(end.getTime()).toBeGreaterThanOrEqual(Date.now() - 5_000);
  expect(end.getTime() - start.getTime()).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
});

test('aggregates totals, durations, on-time rate, revenue, and daily/driver rows', async () => {
  const response = await request(
    `/metrics/kpi?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    adminKey
  );
  expect(response.status).toBe(200);
  const report = await response.json();
  expect(report.range).toEqual({
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString()
  });
  expect(report.totals).toEqual({
    ordersCreated: 6,
    delivered: 3,
    cancelled: 1,
    failed: 1,
    inProgress: 1,
    successRate: 0.6,
    onTimeRate: 0.5,
    avgQueueWaitMs: 600_000,
    avgPickupMs: 3_600_000,
    avgDeliveryMs: 3_600_000,
    revenue: 100,
    deliveryFees: 73,
    avgOrderValue: 100
  });
  expect(report.perDay).toEqual([
    { date: '2025-01-01', ordersCreated: 1, delivered: 1, revenue: 100 },
    { date: '2025-01-02', ordersCreated: 3, delivered: 2, revenue: 0 },
    { date: '2025-01-03', ordersCreated: 2, delivered: 0, revenue: 0 }
  ]);
  expect(report.perDriver).toEqual([
    {
      driverId: 'driver-1',
      delivered: 2,
      avgDeliveryMs: 3_600_000,
      deliveryFees: 63,
      earnings: 50.4
    },
    {
      driverId: 'driver-2',
      delivered: 1,
      avgDeliveryMs: 0,
      deliveryFees: 10,
      earnings: 8
    }
  ]);
});

test('serves KPI controls and breakdown tables on the admin page', async () => {
  const response = await request('/admin.html', adminKey);
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain('id="kpiReport"');
  expect(html).toContain('data-kpi-days="1">วันนี้');
  expect(html).toContain('data-kpi-days="7">7 วัน');
  expect(html).toContain('data-kpi-days="30">30 วัน');
  expect(html).toContain('id="kpiPerDay"');
  expect(html).toContain('id="kpiPerDriver"');
});
