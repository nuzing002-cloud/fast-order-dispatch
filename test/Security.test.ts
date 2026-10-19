import { Server } from 'http';
import { AddressInfo } from 'net';
import { createServer } from 'http';
import { io as createClient, Socket } from 'socket.io-client';
import { createDispatchApp, DispatchAppOptions } from '../src/index';
import { attachRealtime } from '../src/realtime';
import { BatchProcessingService } from '../src/services/BatchProcessingService';

async function start(options: DispatchAppOptions = {}): Promise<{
  server: Server;
  baseUrl: string;
  service: BatchProcessingService;
}> {
  const service = options.service ?? new BatchProcessingService();
  const app = createDispatchApp({ ...options, service });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, service };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

test('requires the API key on protected routes', async () => {
  const { server, baseUrl } = await start({ apiKey: 'test-key' });
  try {
    const unauthorized = await fetch(`${baseUrl}/drivers`);
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json()).error).toBe('Unauthorized');

    const viaHeader = await fetch(`${baseUrl}/drivers`, {
      headers: { 'x-api-key': 'test-key' }
    });
    expect(viaHeader.status).toBe(200);

    const viaBearer = await fetch(`${baseUrl}/drivers`, {
      headers: { Authorization: 'Bearer test-key' }
    });
    expect(viaBearer.status).toBe(200);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  } finally {
    await stop(server);
  }
});

test('rate limits clients and exposes limit headers', async () => {
  const { server, baseUrl } = await start({
    rateLimit: { windowMs: 60_000, max: 2 }
  });
  try {
    const first = await fetch(`${baseUrl}/drivers`);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit')).toBe('2');
    expect(first.headers.get('x-ratelimit-remaining')).toBe('1');

    expect((await fetch(`${baseUrl}/drivers`)).status).toBe(200);

    const limited = await fetch(`${baseUrl}/drivers`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeDefined();

    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  } finally {
    await stop(server);
  }
});

test('adds security and request id headers', async () => {
  const { server, baseUrl } = await start();
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { 'x-request-id': 'request-123' }
    });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-request-id')).toBe('request-123');
  } finally {
    await stop(server);
  }
});

async function waitFor(socket: Socket, event: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
    socket.once(event, (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

test('authenticates Socket.IO connections', async () => {
  const service = new BatchProcessingService();
  const app = createDispatchApp({ service, apiKey: 'socket-key' });
  const server = createServer(app);
  const ioServer = attachRealtime(server, service, { apiKey: 'socket-key', redisUrl: null });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  const rejected = createClient(url, {
    auth: {},
    transports: ['websocket'],
    reconnection: false
  });
  const rejection = await waitFor(rejected, 'connect_error');
  expect(String((rejection as Error).message)).toContain('Unauthorized');
  rejected.close();

  const accepted = createClient(url, {
    auth: { token: 'socket-key' },
    transports: ['websocket'],
    reconnection: false
  });
  await waitFor(accepted, 'connect');
  accepted.close();

  await new Promise<void>((resolve) => ioServer.close(() => resolve()));
});
