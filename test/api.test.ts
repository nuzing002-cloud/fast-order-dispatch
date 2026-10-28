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
  const app = createDispatchApp({ service });
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

test('exposes navigation-only Shopee Driver deep links', async () => {
  const links = await fetch(`${baseUrl}/integrations/shopee-driver/links`);
  expect(links.status).toBe(200);
  const linksBody = await links.json();
  expect(linksBody.targetPackage).toBe('com.shopee.foody.driver.th');
  expect(linksBody.capability).toBe('navigation-only');
  expect(linksBody.links).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        destination: 'home',
        url: 'foody://driver/n/driver/home'
      }),
      expect.objectContaining({
        destination: 'notification',
        url: 'foody://driver/n/driver/notification'
      })
    ])
  );

  const selected = await fetch(
    `${baseUrl}/integrations/shopee-driver/deep-link?destination=transactions`
  );
  expect(selected.status).toBe(200);
  expect(await selected.json()).toEqual({
    destination: 'transactions',
    url: 'foody://driver/rn/@shopee-rn/main/TRANSACTIONS',
    targetPackage: 'com.shopee.foody.driver.th',
    capability: 'navigation-only'
  });

  const fallback = await fetch(`${baseUrl}/integrations/shopee-driver/deep-link`);
  expect(fallback.status).toBe(200);
  expect(await fallback.json()).toEqual({
    destination: 'home',
    url: 'foody://driver/n/driver/home',
    targetPackage: 'com.shopee.foody.driver.th',
    capability: 'navigation-only'
  });

  const page = await fetch(`${baseUrl}/shopee-driver.html`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('foody://driver/n/driver/home');

  const invalid = await fetch(
    `${baseUrl}/integrations/shopee-driver/deep-link?destination=private-api`
  );
  expect(invalid.status).toBe(400);
});

test('serves the web console', async () => {
  const response = await fetch(`${baseUrl}/`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(await response.text()).toContain('fast-order-dispatch');
});

test('serves all console pages and assets', async () => {
  for (const asset of [
    '/customer.html',
    '/driver.html',
    '/admin.html',
    '/shopee-driver.html',
    '/styles.css',
    '/common.js',
    '/customer.js',
    '/driver.js',
    '/admin.js'
  ]) {
    const response = await fetch(`${baseUrl}${asset}`);
    expect(response.status).toBe(200);
  }
});

test('serves PWA manifest, service worker, and icons', async () => {
  const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
  expect(manifest.status).toBe(200);
  expect(manifest.headers.get('content-type')).toContain('manifest');
  const manifestBody = JSON.parse(await manifest.text());
  expect(manifestBody.name).toBe('fast-order-dispatch');
  expect(manifestBody.icons.length).toBeGreaterThanOrEqual(2);

  const sw = await fetch(`${baseUrl}/sw.js`);
  expect(sw.status).toBe(200);
  expect(sw.headers.get('content-type')).toContain('javascript');
  expect(await sw.text()).toContain('fod-v6');

  const admin = await fetch(`${baseUrl}/admin.html`);
  expect(admin.status).toBe(200);
  const adminHtml = await admin.text();
  expect(adminHtml).toContain('ออเดอร์และการแจ้งเตือนล่าสุด');
  expect(adminHtml).toContain('id="bridgeActivity"');
  expect(adminHtml).not.toContain('id="bridgeOrders"');
  expect(adminHtml).not.toContain('id="bridgeEvents"');

  for (const icon of [
    '/favicon.svg',
    '/favicon-32.png',
    '/apple-touch-icon.png',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-maskable-512.png'
  ]) {
    const response = await fetch(`${baseUrl}${icon}`);
    expect(response.status).toBe(200);
  }

  const home = await fetch(`${baseUrl}/`);
  const html = await home.text();
  expect(html).toContain('/manifest.webmanifest');
  expect(html).toContain('theme-color');

  const common = await fetch(`${baseUrl}/common.js`);
  expect(await common.text()).toContain('serviceWorker');
});

test('serves self-hosted Swagger UI assets', async () => {
  const docs = await fetch(`${baseUrl}/docs`);
  expect(docs.status).toBe(200);
  const html = await docs.text();
  expect(html).toContain('/swagger-ui/swagger-ui.css');
  expect(html).not.toContain('unpkg.com');

  const css = await fetch(`${baseUrl}/swagger-ui/swagger-ui.css`);
  expect(css.status).toBe(200);
  expect(css.headers.get('content-type')).toContain('text/css');

  const bundle = await fetch(`${baseUrl}/swagger-ui/swagger-ui-bundle.js`);
  expect(bundle.status).toBe(200);
  expect(bundle.headers.get('content-type')).toContain('javascript');
});

test('exposes Prometheus metrics', async () => {
  const response = await fetch(`${baseUrl}/metrics/prometheus`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  const body = await response.text();
  expect(body).toContain('# TYPE dispatch_orders_processed_total counter');
  expect(body).toContain('dispatch_orders_pending');
  expect(body).toContain('process_uptime_seconds');
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

  const lowFee = await post('/orders', {
    ...makeOrder('low-fee'),
    deliveryFee: 27
  });
  expect(lowFee.status).toBe(400);
  expect((await lowFee.json()).error).toContain('deliveryFee must be at least 28');
});

test('runs the full order lifecycle over HTTP', async () => {
  const order = makeOrder('o1');
  const created = await post('/orders', order);
  expect(created.status).toBe(201);
  const createdBody = await created.json();
  expect(createdBody.transaction.status).toBe('COMPLETED');
  expect(createdBody.assignedToTargetDriver).toBe(false);
  expect(createdBody.batch).toBeNull();
  expect(createdBody.queueSize).toBe(0);

  const fetched = await fetch(`${baseUrl}/orders/o1`);
  expect(fetched.status).toBe(200);
  const fetchedBody = await fetched.json();
  expect(fetchedBody.order.paymentStatus).toBe('COMPLETED');
  expect(fetchedBody.order.status).toBe('PENDING');

  const ready = await patch('/orders/o1/status', { status: 'READY' });
  expect(ready.status).toBe(200);
  expect((await ready.json()).order.status).toBe('ASSIGNED');

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

test('paginates and filters orders and batches', async () => {
  const page = await (await fetch(`${baseUrl}/orders?limit=1&offset=0`)).json();
  expect(page.orders).toHaveLength(1);
  expect(page.total).toBeGreaterThanOrEqual(2);
  expect(page.limit).toBe(1);
  expect(page.offset).toBe(0);

  const delivered = await (await fetch(`${baseUrl}/orders?status=DELIVERED`)).json();
  expect(delivered.orders.length).toBeGreaterThanOrEqual(1);
  expect(delivered.orders.every((order: { status: string }) => order.status === 'DELIVERED')).toBe(true);

  const batches = await (await fetch(`${baseUrl}/batches?limit=1`)).json();
  expect(batches.batches).toHaveLength(1);
  expect(batches.total).toBe(1);

  expect((await fetch(`${baseUrl}/orders?limit=0`)).status).toBe(400);
  expect((await fetch(`${baseUrl}/orders?offset=-1`)).status).toBe(400);
  expect((await fetch(`${baseUrl}/orders?status=NOPE`)).status).toBe(400);
});
