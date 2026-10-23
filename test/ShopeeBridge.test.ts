import { createHmac } from 'crypto';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { createDispatchApp } from '../src/index';
import { ShopeeBridgeClient } from '../src/integrations/ShopeeBridgeClient';
import { ShopeeBridgeService } from '../src/integrations/ShopeeBridgeService';
import { BatchProcessingService } from '../src/services/BatchProcessingService';

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('shopee-bridge-test')
]);

let bridgeServer: Server;
let appServer: Server;
let baseUrl: string;
let bridgeService: ShopeeBridgeService;
let service: BatchProcessingService;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

beforeAll(async () => {
  bridgeServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/health') {
      response.end(
        JSON.stringify({
          ok: true,
          adb: { serial: 'test-serial', ok: true, error: null },
          autoAccept: true,
          autoOpen: false,
          orders: 1,
          events: 2,
          lastPollAt: '2026-10-23T10:00:00.000Z'
        })
      );
      return;
    }
    if (url.pathname === '/events') {
      response.end(
        JSON.stringify({
          events: [
            {
              type: 'notification',
              id: 'bridge-evt-1',
              time: '2026-10-23T10:00:00.000Z',
              title: 'งานใหม่',
              text: 'ออเดอร์ใหม่ ฿58'
            }
          ]
        })
      );
      return;
    }
    if (url.pathname === '/orders') {
      response.end(
        JSON.stringify({
          orders: [
            {
              id: 'order-1',
              orderNo: 'TEST12345',
              status: 'new',
              price: '58',
              distance: '3.2',
              duration: '18',
              createdAt: '2026-10-23T10:00:00.000Z',
              updatedAt: '2026-10-23T10:00:00.000Z'
            }
          ]
        })
      );
      return;
    }
    if (url.pathname === '/area/latest.png') {
      response.setHeader('Content-Type', 'image/png');
      response.end(PNG);
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  const bridgePort = await listen(bridgeServer);

  service = new BatchProcessingService();
  bridgeService = new ShopeeBridgeService({
    client: new ShopeeBridgeClient({ baseUrl: `http://127.0.0.1:${bridgePort}` }),
    syncIntervalMs: 60_000
  });
  const app = createDispatchApp({ service, shopeeBridge: bridgeService });
  appServer = app.listen(0);
  await new Promise<void>((resolve) => appServer.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  bridgeService.stop();
  await close(appServer);
  await close(bridgeServer);
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('reports a configured but unsynced read-only bridge', async () => {
  const response = await fetch(`${baseUrl}/integrations/shopee-bridge/status`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.configured).toBe(true);
  expect(body.capability).toBe('read-only');
  expect(body.reachable).toBe(false);
  expect(body.events).toEqual([]);
  expect(body.safety.commandsExposed).toBe(false);
  expect(body.safety.autoAcceptOwner).toBe('shopee-bridge');
});

test('syncs health, events, orders, and the area screenshot', async () => {
  const sync = await post('/integrations/shopee-bridge/sync', {});
  expect(sync.status).toBe(200);
  const status = await sync.json();
  expect(status.reachable).toBe(true);
  expect(status.health.adb).toEqual({ serial: 'test-serial', ok: true, error: null });
  expect(status.health.autoAccept).toBe(true);
  expect(status.events).toHaveLength(1);
  expect(status.orders).toHaveLength(1);
  expect(status.orders[0].orderNo).toBe('TEST12345');
  expect(status.screenshot.available).toBe(true);
  expect(status.screenshot.bytes).toBe(PNG.length);

  const image = await fetch(`${baseUrl}/integrations/shopee-bridge/screenshot`);
  expect(image.status).toBe(200);
  expect(image.headers.get('content-type')).toContain('image/png');
  expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
});

test('accepts a loopback webhook and deduplicates repeated events', async () => {
  const event = {
    type: 'notification',
    id: 'webhook-evt-1',
    time: '2026-10-23T10:01:00.000Z',
    title: 'งานใหม่',
    text: 'ออเดอร์ใหม่ ฿60'
  };
  const first = await post('/webhooks/shopee-bridge', event);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, received: 1, duplicates: 0 });

  const duplicate = await post('/webhooks/shopee-bridge', event);
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toEqual({ ok: true, received: 1, duplicates: 1 });

  const status = await (await fetch(`${baseUrl}/integrations/shopee-bridge/status`)).json();
  expect(status.events.filter((entry: { id?: string }) => entry.id === 'webhook-evt-1')).toHaveLength(
    1
  );
  expect(status.lastEventAt).toBe('2026-10-23T10:01:00.000Z');
});

test('rejects malformed webhook events', async () => {
  const response = await post('/webhooks/shopee-bridge', { id: 'missing-type' });
  expect(response.status).toBe(400);
});

test('does not expose open or accept command routes', async () => {
  for (const path of ['/integrations/shopee-bridge/open', '/integrations/shopee-bridge/accept']) {
    const response = await post(path, {});
    expect(response.status).toBe(404);
  }
});

test('requires a valid HMAC when a webhook secret is configured', async () => {
  const signedService = new ShopeeBridgeService({
    client: new ShopeeBridgeClient({ baseUrl: bridgeService.status().baseUrl }),
    syncIntervalMs: 60_000
  });
  const signedApp = createDispatchApp({
    service,
    shopeeBridge: signedService,
    shopeeBridgeWebhookSecret: 'test-bridge-secret'
  });
  const signedServer = signedApp.listen(0);
  await new Promise<void>((resolve) => signedServer.once('listening', resolve));
  const signedUrl = `http://127.0.0.1:${(signedServer.address() as AddressInfo).port}`;
  const raw = JSON.stringify({
    type: 'notification',
    id: 'signed-evt-1',
    time: '2026-10-23T10:02:00.000Z'
  });

  try {
    const unsigned = await fetch(`${signedUrl}/webhooks/shopee-bridge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw
    });
    expect(unsigned.status).toBe(401);

    const signature = createHmac('sha256', 'test-bridge-secret').update(raw).digest('hex');
    const signed = await fetch(`${signedUrl}/webhooks/shopee-bridge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-shopee-bridge-signature': `sha256=${signature}`
      },
      body: raw
    });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ ok: true, received: 1, duplicates: 0 });
  } finally {
    await close(signedServer);
  }
});

test('reports unreachable bridges without throwing', async () => {
  const offlineService = new ShopeeBridgeService({
    client: new ShopeeBridgeClient({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 250
    }),
    syncIntervalMs: 60_000
  });
  const status = await offlineService.refresh();
  expect(status.reachable).toBe(false);
  expect(status.lastError).toContain('unreachable');
});

test('marks an otherwise reachable bridge stale when its health timestamp is old', async () => {
  const staleHealth = {
    ok: true,
    lastPollAt: '2020-01-01T00:00:00.000Z'
  };
  const staleClient = new ShopeeBridgeClient({
    baseUrl: 'http://bridge.test',
    fetchImpl: (async (input) => {
      const path = new URL(String(input)).pathname;
      const body = path === '/health'
        ? staleHealth
        : path === '/events'
          ? { events: [] }
          : path === '/orders'
            ? { orders: [] }
            : undefined;
      if (path === '/area/latest.png') {
        return new Response(null, { status: 404 });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch
  });
  const staleService = new ShopeeBridgeService({
    client: staleClient,
    syncIntervalMs: 60_000,
    staleAfterMs: 1_000
  });

  const status = await staleService.refresh();
  expect(status.reachable).toBe(true);
  expect(status.dataFreshness.state).toBe('stale');
  expect(status.dataFreshness.stale).toBe(true);
  expect(status.dataFreshness.source).toBe('health');
});

test('does not report cached data as reachable after a refresh failure', async () => {
  let online = true;
  const client = new ShopeeBridgeClient({
    baseUrl: 'http://bridge.test',
    fetchImpl: (async (input) => {
      if (!online) throw new Error('bridge stopped');
      const path = new URL(String(input)).pathname;
      const body = path === '/health'
        ? { ok: true, lastPollAt: new Date().toISOString() }
        : path === '/events'
          ? { events: [] }
          : path === '/orders'
            ? { orders: [] }
            : undefined;
      if (path === '/area/latest.png') {
        return new Response(null, { status: 404 });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }) as typeof fetch
  });
  const service = new ShopeeBridgeService({
    client,
    syncIntervalMs: 60_000
  });

  const onlineStatus = await service.refresh();
  expect(onlineStatus.reachable).toBe(true);
  expect(onlineStatus.dataFreshness.state).toBe('fresh');

  online = false;
  const offlineStatus = await service.refresh();
  expect(offlineStatus.reachable).toBe(false);
  expect(offlineStatus.lastRefreshSucceeded).toBe(false);
  expect(offlineStatus.dataFreshness.state).toBe('offline');
  expect(offlineStatus.orders).toEqual([]);
});
