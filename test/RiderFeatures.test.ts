import { Server } from 'http';
import { AddressInfo } from 'net';
import { createDispatchApp } from '../src/index';
import { BatchProcessingService } from '../src/services/BatchProcessingService';
import { PushNotifier, PushPayload, PushSender } from '../src/push';
import { MemoryDispatchStore } from '../src/store/DispatchStore';
import { PushSubscriptionRecord } from '../src/types/order';
import { makeDriver, makeOrder } from './helpers';

let server: Server;
let baseUrl: string;
let store: MemoryDispatchStore;
let service: BatchProcessingService;
const pushes: Array<{ subscription: PushSubscriptionRecord; payload: PushPayload }> = [];
const driverId = '1388246780';

beforeAll(async () => {
  store = new MemoryDispatchStore();
  service = new BatchProcessingService(3, store, { driverSharePercent: 80 });
  const sender: PushSender = async (subscription, payload) => {
    pushes.push({ subscription, payload });
    return 'ok';
  };
  const app = createDispatchApp({
    service,
    push: new PushNotifier(store, {
      publicKey: 'test-public-key',
      privateKey: 'test-private-key',
      subject: 'mailto:test@example.com',
      sender
    })
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

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  });
}

function post(path: string, body?: unknown): Promise<Response> {
  return call(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

function patch(path: string, body: unknown): Promise<Response> {
  return call(path, { method: 'PATCH', body: JSON.stringify(body) });
}

async function deliver(orderId: string): Promise<void> {
  for (const status of ['PICKED_UP', 'IN_DELIVERY', 'DELIVERED']) {
    const response = await patch(`/orders/${orderId}/status`, { status });
    expect(response.status).toBe(200);
  }
}

async function markReady(orderId: string): Promise<{ status: string; assignedDriverId?: string }> {
  const response = await patch(`/orders/${orderId}/status`, { status: 'READY' });
  expect(response.status).toBe(200);
  return (await response.json()).order;
}

beforeAll(async () => {
  const registration = await post('/drivers', makeDriver());
  expect(registration.status).toBe(201);
});

test('accrues earnings on delivery and pays them out once', async () => {
  const created = await post('/orders', makeOrder('earn-order'));
  expect(created.status).toBe(201);
  expect((await created.json()).order.status).toBe('PENDING');
  expect((await markReady('earn-order')).assignedDriverId).toBe(driverId);

  await deliver('earn-order');

  const earnings = await (await call(`/drivers/${driverId}/earnings`)).json();
  expect(earnings.currency).toBe('THB');
  expect(earnings.pendingAmount).toBe(22.4);
  expect(earnings.paidAmount).toBe(0);
  expect(earnings.earnings).toHaveLength(1);
  expect(earnings.earnings[0]).toMatchObject({
    driverId,
    orderId: 'earn-order',
    amount: 22.4,
    status: 'PENDING'
  });

  const payout = await post('/payouts', { driverId, method: 'promptpay' });
  expect(payout.status).toBe(201);
  const payoutBody = await payout.json();
  expect(payoutBody.payout.amount).toBe(22.4);
  expect(payoutBody.payout.earningIds).toHaveLength(1);
  expect(payoutBody.payout.status).toBe('PAID');

  const after = await (await call(`/drivers/${driverId}/earnings`)).json();
  expect(after.pendingAmount).toBe(0);
  expect(after.paidAmount).toBe(22.4);
  expect(after.payouts).toHaveLength(1);
  expect(after.earnings[0].status).toBe('PAID');

  const list = await (await call(`/payouts?driverId=${driverId}`)).json();
  expect(list.total).toBe(1);

  const duplicate = await post('/payouts', { driverId });
  expect(duplicate.status).toBe(409);
});

test('registers push subscriptions and notifies the driver on assignment', async () => {
  const key = await (await call('/push/public-key')).json();
  expect(key.publicKey).toBe('test-public-key');

  const subscription = {
    endpoint: 'https://push.example.com/subscriptions/driver-1',
    keys: { p256dh: 'p256dh-key-value', auth: 'auth-value' }
  };
  const subscribed = await post('/push/subscribe', { driverId, subscription });
  expect(subscribed.status).toBe(201);

  const created = await post('/orders', makeOrder('push-order'));
  expect(created.status).toBe(201);
  expect((await created.json()).order.status).toBe('PENDING');
  expect((await markReady('push-order')).assignedDriverId).toBe(driverId);

  for (let attempt = 0; attempt < 50 && pushes.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(pushes).toHaveLength(1);
  expect(pushes[0]?.subscription.endpoint).toBe(subscription.endpoint);
  expect(pushes[0]?.payload.title).toContain('งานใหม่');
  expect(pushes[0]?.payload.body).toContain('1 ออเดอร์');

  await deliver('push-order');

  const removed = await post('/push/unsubscribe', { endpoint: subscription.endpoint });
  expect(removed.status).toBe(200);
  expect((await removed.json()).removed).toBe(true);
});

test('declines an assigned order and returns it to the queue', async () => {
  const created = await post('/orders', makeOrder('decline-order'));
  expect((await created.json()).order.status).toBe('PENDING');
  await markReady('decline-order');

  const declined = await post('/orders/decline-order/decline', { driverId });
  expect(declined.status).toBe(200);
  const body = await declined.json();
  expect(body.order.status).toBe('READY');
  expect(body.order.assignedDriverId).toBeUndefined();
  expect(body.order.declinedDriverIds).toContain(driverId);
  expect(body.driver.isAvailable).toBe(true);

  const again = await post('/orders/decline-order/decline', { driverId });
  expect(again.status).toBe(409);

  const batches = await (await call('/batches')).json();
  const activeForOrder = batches.batches.filter(
    (batch: { orderIds: string[]; completedAt?: string }) =>
      !batch.completedAt && batch.orderIds.includes('decline-order')
  );
  expect(activeForOrder).toHaveLength(0);
});

test('pauses new assignments until the driver opts back in', async () => {
  const paused = await patch(`/drivers/${driverId}`, { acceptsNewOrders: false });
  expect(paused.status).toBe(200);
  expect((await paused.json()).driver.acceptsNewOrders).toBe(false);

  const queued = await post('/orders', makeOrder('paused-order'));
  const queuedBody = await queued.json();
  expect(queuedBody.assignedToTargetDriver).toBe(false);
  expect(queuedBody.order.status).toBe('PENDING');
  expect((await markReady('paused-order')).status).toBe('READY');

  const resumed = await patch(`/drivers/${driverId}`, { acceptsNewOrders: true });
  expect((await resumed.json()).driver.acceptsNewOrders).toBe(true);

  const processed = await post('/dispatch/process');
  expect(processed.status).toBe(200);
  const batch = (await processed.json()).batch;
  expect(batch.driverId).toBe(driverId);
  expect(batch.orderIds).toContain('paused-order');
});
