import { Server } from 'http';
import { AddressInfo } from 'net';
import { createDispatchApp } from '../src/index';
import { BatchProcessingService } from '../src/services/BatchProcessingService';
import { makeDriver, makeOrder } from './helpers';

let server: Server;
let baseUrl: string;
let service: BatchProcessingService;

beforeAll(async () => {
  service = new BatchProcessingService();
  const app = createDispatchApp(service);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function patch(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('GET /health reports service state', async () => {
  const response = await fetch(`${baseUrl}/health`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.status).toBe('ok');
  expect(body.dispatchDriverId).toBe('1388246780');
  expect(body.storage).toBe('memory');
});

test('registers the target driver once', async () => {
  const registration = await post('/drivers', makeDriver());
  expect(registration.status).toBe(201);

  const duplicate = await post('/drivers', makeDriver());
  expect(duplicate.status).toBe(409);
  expect((await duplicate.json()).error).toContain('already exists');
});

test('rejects invalid order payloads', async () => {
  const response = await post('/orders', { totalAmount: 'free' });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('restaurant');

  const emptyItems = await post('/orders', {
    ...makeOrder('bad'),
    items: []
  });
  expect(emptyItems.status).toBe(400);
  expect((await emptyItems.json()).error).toContain('items must not be empty');
});

test('runs the full order lifecycle over HTTP', async () => {
  const order = makeOrder('o1');
  const created = await post('/orders', order);
  expect(created.status).toBe(201);
  const createdBody = await created.json();
  expect(createdBody.transaction.status).toBe('COMPLETED');
  expect(createdBody.assignedToTargetDriver).toBe(true);
  expect(createdBody.batch.driverId).toBe('1388246780');
  expect(createdBody.batch.totalPreparationMinutes).toBe(5);
  expect(createdBody.queueSize).toBe(0);

  const fetched = await fetch(`${baseUrl}/orders/o1`);
  expect(fetched.status).toBe(200);
  expect((await fetched.json()).order.paymentStatus).toBe('COMPLETED');

  for (const status of ['PICKED_UP', 'IN_DELIVERY', 'DELIVERED']) {
    const response = await patch('/orders/o1/status', { status });
    expect(response.status).toBe(200);
    expect((await response.json()).order.status).toBe(status);
  }

  const drivers = await (await fetch(`${baseUrl}/drivers`)).json();
  expect(drivers.drivers[0].status).toBe('AVAILABLE');
  expect(drivers.drivers[0].totalDeliveries).toBe(1);

  const batches = await (await fetch(`${baseUrl}/batches`)).json();
  expect(batches.batches).toHaveLength(1);
  expect(batches.batches[0].completedAt).toBeDefined();

  const metrics = await (await fetch(`${baseUrl}/metrics`)).json();
  expect(metrics.totalOrdersProcessed).toBe(1);
  expect(metrics.totalBatchesCreated).toBe(1);
  expect(metrics.totalRevenue).toBe(100);
  expect(metrics.activeDrivers).toBe(1);
  expect(metrics.pendingOrders).toBe(0);
});

test('rejects invalid lifecycle transitions', async () => {
  const response = await patch('/orders/o1/status', { status: 'PICKED_UP' });
  expect(response.status).toBe(409);

  const invalid = await patch('/orders/o1/status', { status: 'TELEPORTED' });
  expect(invalid.status).toBe(400);
});

test('handles failed payments and retries', async () => {
  const order = { ...makeOrder('o2'), totalAmount: 0 };
  const failed = await post('/orders', order);
  expect(failed.status).toBe(402);
  const failedBody = await failed.json();
  expect(failedBody.order.paymentStatus).toBe('FAILED');
  expect(failedBody.order.status).toBe('PENDING');

  const pending = await (await fetch(`${baseUrl}/orders/pending`)).json();
  expect(pending.orders.map((entry: { id: string }) => entry.id)).not.toContain('o2');

  const retry = await post('/orders/o2/pay', {});
  expect(retry.status).toBe(402);

  const alreadyPaid = await post('/orders/o1/pay', {});
  expect(alreadyPaid.status).toBe(409);
});

test('returns 404 for unknown orders', async () => {
  const fetched = await fetch(`${baseUrl}/orders/missing`);
  expect(fetched.status).toBe(404);
  expect((await fetched.json()).error).toContain('was not found');

  const statusUpdate = await patch('/orders/missing/status', { status: 'CANCELLED' });
  expect(statusUpdate.status).toBe(404);
});
