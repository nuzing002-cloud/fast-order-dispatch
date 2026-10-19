import { Server } from 'http';
import { AddressInfo } from 'net';
import { createDispatchApp } from '../src/index';
import { BatchProcessingService } from '../src/services/BatchProcessingService';
import { makeDriver, makeOrder } from './helpers';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const service = new BatchProcessingService();
  const app = createDispatchApp({ service });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await fetch(`${baseUrl}/drivers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeDriver())
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

function post(path: string, body: unknown = {}): Promise<Response> {
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

test('stores charges, refunds delivered orders, and excludes them from revenue', async () => {
  const created = await post('/orders', makeOrder('pay1', 13.76, 100.51, 100));
  expect(created.status).toBe(201);

  const payments = await (await fetch(`${baseUrl}/orders/pay1/payments`)).json();
  expect(payments.payments).toHaveLength(1);
  expect(payments.payments[0].kind).toBe('charge');
  expect(payments.payments[0].status).toBe('COMPLETED');
  expect(payments.payments[0].amount).toBe(100);

  for (const status of ['PICKED_UP', 'IN_DELIVERY', 'DELIVERED']) {
    expect((await patch('/orders/pay1/status', { status })).status).toBe(200);
  }

  const beforeRefund = await (await fetch(`${baseUrl}/metrics`)).json();
  expect(beforeRefund.totalRevenue).toBe(100);

  const refunded = await post('/orders/pay1/refund');
  expect(refunded.status).toBe(200);
  const refundBody = await refunded.json();
  expect(refundBody.order.paymentStatus).toBe('REFUNDED');
  expect(refundBody.transaction.kind).toBe('refund');
  expect(refundBody.transaction.amount).toBe(-100);

  const ledger = await (await fetch(`${baseUrl}/orders/pay1/payments`)).json();
  expect(ledger.payments).toHaveLength(2);
  expect(ledger.payments[1].kind).toBe('refund');

  const afterRefund = await (await fetch(`${baseUrl}/metrics`)).json();
  expect(afterRefund.totalRevenue).toBe(0);

  const duplicate = await post('/orders/pay1/refund');
  expect(duplicate.status).toBe(409);
});

test('does not refund orders without a completed payment', async () => {
  const failed = await post('/orders', makeOrder('pay2', 13.76, 100.51, 0));
  expect(failed.status).toBe(402);

  const ledger = await (await fetch(`${baseUrl}/orders/pay2/payments`)).json();
  expect(ledger.payments).toHaveLength(1);
  expect(ledger.payments[0].status).toBe('FAILED');

  expect((await post('/orders/pay2/refund')).status).toBe(409);
  expect((await fetch(`${baseUrl}/orders/missing/payments`)).status).toBe(404);
});
