import { createHmac } from 'crypto';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createDispatchApp } from '../src/index';
import { verifyStripeSignature } from '../src/services/PaymentGateways';
import { BatchProcessingService } from '../src/services/BatchProcessingService';
import { MemoryDispatchStore } from '../src/store/DispatchStore';
import { OrderStatus, PaymentStatus } from '../src/types/order';
import { makeDriver, makeOrder } from './helpers';

let server: Server;
let baseUrl: string;
let store: MemoryDispatchStore;
let service: BatchProcessingService;

const adminKey = 'admin-key';
const viewerKey = 'viewer-key';

beforeAll(async () => {
  store = new MemoryDispatchStore();
  service = new BatchProcessingService(3, store);
  const app = createDispatchApp({
    service,
    apiKeys: [
      { key: adminKey, role: 'admin', label: 'admin' },
      { key: viewerKey, role: 'viewer', label: 'viewer' },
      { key: 'quota-key', role: 'admin', label: 'quota', limit: 1 }
    ],
    apiKey: undefined,
    rateLimit: { windowMs: 60_000, max: 100 },
    idempotencyStore: store,
    paymentWebhook: { provider: 'http', secret: 'webhook-secret' }
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

function call(
  path: string,
  init: RequestInit = {},
  key: string = adminKey
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      ...(init.headers ?? {})
    }
  });
}

test('replays idempotent order creation and rejects key reuse', async () => {
  const order = makeOrder('idem');
  const headers = { 'Idempotency-Key': 'order-idem-1' };

  const first = await call('/orders', {
    method: 'POST',
    headers,
    body: JSON.stringify(order)
  });
  expect(first.status).toBe(201);
  const firstBody = await first.json();

  const second = await call('/orders', {
    method: 'POST',
    headers,
    body: JSON.stringify(order)
  });
  expect(second.status).toBe(201);
  expect(second.headers.get('idempotent-replayed')).toBe('true');
  const secondBody = await second.json();
  expect(secondBody.order.id).toBe(firstBody.order.id);

  const reused = await call('/orders', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'order-idem-1' },
    body: JSON.stringify({ ...order, totalAmount: 500 })
  });
  expect(reused.status).toBe(409);
});

test('does not persist server errors for idempotency keys', async () => {
  const order = makeOrder('idem-500');
  const original = service.addOrder;
  let fail = true;
  service.addOrder = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error('simulated database failure');
    }
    return original.apply(service, args);
  };

  try {
    const headers = { 'Idempotency-Key': 'order-500-1' };
    const first = await call('/orders', {
      method: 'POST',
      headers,
      body: JSON.stringify(order)
    });
    expect(first.status).toBe(500);

    const second = await call('/orders', {
      method: 'POST',
      headers,
      body: JSON.stringify(order)
    });
    expect(second.status).toBe(201);
  } finally {
    service.addOrder = original;
  }
});

test('enforces roles and per-key quotas', async () => {
  const viewerRead = await call('/drivers', {}, viewerKey);
  expect(viewerRead.status).toBe(200);

  const viewerWrite = await call('/drivers', {
    method: 'POST',
    body: JSON.stringify(makeDriver('viewer-driver'))
  }, viewerKey);
  expect(viewerWrite.status).toBe(403);

  const auditAsViewer = await call('/audit', {}, viewerKey);
  expect(auditAsViewer.status).toBe(403);

  const first = await call('/drivers', {}, 'quota-key');
  expect(first.status).toBe(200);
  expect(first.headers.get('x-ratelimit-limit')).toBe('1');
  const second = await call('/drivers', {}, 'quota-key');
  expect(second.status).toBe(429);
});

test('records audit entries and exposes them to admins', async () => {
  const response = await call('/audit?limit=100');
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.total).toBeGreaterThanOrEqual(2);
  expect(body.entries.some((entry: { action: string }) => entry.action === 'order.created')).toBe(true);
  expect(body.entries.some((entry: { action: string }) => entry.action === 'payment.charge')).toBe(true);
});

test('verifies payment webhook signatures', async () => {
  const payload = JSON.stringify({ transactionId: 'missing', status: 'succeeded' });
  const signature = createHmac('sha256', 'webhook-secret').update(payload).digest('hex');

  const accepted = await fetch(`${baseUrl}/webhooks/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-signature': signature
    },
    body: payload
  });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ received: true, matched: false });

  const rejected = await fetch(`${baseUrl}/webhooks/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-signature': 'deadbeef'
    },
    body: payload
  });
  expect(rejected.status).toBe(400);
});

test('records a late payment but waits for the restaurant to mark the order READY', async () => {
  const order = makeOrder('webhook-late');
  await service.addOrder(order, false);
  await service.recordPayment({
    id: 'tx_late',
    orderId: order.id,
    amount: order.totalAmount,
    method: 'card',
    kind: 'charge',
    status: PaymentStatus.FAILED,
    providerTransactionId: 'late-provider-1',
    createdAt: new Date(),
    processedAt: new Date()
  });

  const payload = JSON.stringify({
    transactionId: 'late-provider-1',
    status: 'succeeded'
  });
  const signature = createHmac('sha256', 'webhook-secret').update(payload).digest('hex');
  const response = await fetch(`${baseUrl}/webhooks/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-signature': signature
    },
    body: payload
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ received: true, matched: true });
  const stored = await service.getOrder(order.id);
  expect(stored?.paymentStatus).toBe('COMPLETED');
  expect(stored?.status).toBe(OrderStatus.PENDING);
  expect(stored?.queuedAt).toBeUndefined();
  expect(await service.getQueueSize()).toBe(0);

  await service.updateOrderStatus(order.id, OrderStatus.READY);
  expect(await service.getQueueSize()).toBe(1);
  expect((await service.getOrder(order.id))?.queuedAt).toBeInstanceOf(Date);
});

test('validates Stripe webhook signatures', () => {
  const secret = 'whsec_test';
  const payload = JSON.stringify({ type: 'payment_intent.succeeded' });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');

  expect(
    verifyStripeSignature(payload, `t=${timestamp},v1=${signature}`, secret)
  ).toBe(true);
  expect(
    verifyStripeSignature(payload, `t=${timestamp},v1=deadbeef`, secret)
  ).toBe(false);
  expect(
    verifyStripeSignature(payload, `t=${timestamp + 1000},v1=${signature}`, secret)
  ).toBe(false);
});
