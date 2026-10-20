import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { io as createClient, Socket } from 'socket.io-client';
import { createDispatchApp } from '../src/index';
import { attachRealtime, connectRedisAdapter } from '../src/realtime';
import { BatchProcessingService } from '../src/services/BatchProcessingService';
import { makeDriver, makeOrder } from './helpers';

const redisUrl = process.env.REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload: T): void => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

describeRedis('redis adapter', () => {
  jest.setTimeout(20_000);

  test('fans out events between two service instances', async () => {
    const serviceA = new BatchProcessingService();
    const serviceB = new BatchProcessingService();

    const serverA: HttpServer = createServer(createDispatchApp({ service: serviceA }));
    const serverB: HttpServer = createServer(createDispatchApp({ service: serviceB }));
    const ioA = attachRealtime(serverA, serviceA, { redisUrl: null });
    const ioB = attachRealtime(serverB, serviceB, { redisUrl: null });

    await Promise.all([
      new Promise<void>((resolve) => serverA.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => serverB.listen(0, '127.0.0.1', resolve))
    ]);

    const urlA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}`;
    const urlB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`;

    expect(await connectRedisAdapter(ioA, redisUrl as string)).toBe(true);
    expect(await connectRedisAdapter(ioB, redisUrl as string)).toBe(true);

    const client = createClient(urlB, { transports: ['websocket'] });
    try {
      await waitForEvent(client, 'connect');
      await fetch(`${urlA}/drivers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeDriver())
      });

      const event = waitForEvent<{ id: string }>(client, 'order:created');
      const response = await fetch(`${urlA}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeOrder('redis-o1'))
      });
      expect(response.status).toBe(201);

      expect((await event).id).toBe('redis-o1');
    } finally {
      client.close();
      await Promise.all([
        new Promise<void>((resolve) => ioA.close(() => resolve())),
        new Promise<void>((resolve) => ioB.close(() => resolve()))
      ]);
    }
  });

  test('shares rate limit counters across instances', async () => {
    const options = {
      rateLimit: { windowMs: 60_000, max: 2 },
      redisUrl: redisUrl as string
    };
    const appA = createDispatchApp(options);
    const appB = createDispatchApp(options);
    const serverA = appA.listen(0, '127.0.0.1');
    const serverB = appB.listen(0, '127.0.0.1');
    await Promise.all([
      new Promise<void>((resolve) => serverA.once('listening', resolve)),
      new Promise<void>((resolve) => serverB.once('listening', resolve))
    ]);
    const urlA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}/drivers`;
    const urlB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}/drivers`;

    try {
      const first = await fetch(urlA);
      expect(first.status).toBe(200);
      expect(first.headers.get('x-ratelimit-remaining')).toBe('1');

      const second = await fetch(urlB);
      expect(second.status).toBe(200);
      expect(second.headers.get('x-ratelimit-remaining')).toBe('0');

      const third = await fetch(urlA);
      expect(third.status).toBe(429);
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => serverA.close(() => resolve())),
        new Promise<void>((resolve) => serverB.close(() => resolve()))
      ]);
      await Promise.all([
        appA.locals.rateLimiter.close(),
        appB.locals.rateLimiter.close()
      ]);
    }
  });
});
