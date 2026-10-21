import { createServer, Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { io as createClient, Socket } from 'socket.io-client';
import { createDispatchApp } from '../src/index';
import { attachRealtime } from '../src/realtime';
import { BatchProcessingService } from '../src/services/BatchProcessingService';
import { makeDriver, makeOrder } from './helpers';

function waitForEvent<T>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
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

describe('realtime events', () => {
  let server: HttpServer;
  let ioServer: Awaited<ReturnType<typeof attachRealtime>>;
  let client: Socket;
  let baseUrl: string;
  let service: BatchProcessingService;

  beforeAll(async () => {
    service = new BatchProcessingService();
    const app = createDispatchApp({ service });
    server = createServer(app);
    ioServer = await attachRealtime(server, service, { redisUrl: null });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = createClient(baseUrl, { transports: ['websocket'] });
    await waitForEvent(client, 'connect');
  });

  afterAll(async () => {
    client.close();
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
  });

  test('sends the initial state on connect', async () => {
    const state = await new Promise<{ queueSize: number; drivers: unknown[] }>((resolve) => {
      const freshClient = createClient(baseUrl, { transports: ['websocket'] });
      freshClient.on('state', (payload) => {
        freshClient.close();
        resolve(payload);
      });
    });

    expect(state.queueSize).toBe(0);
    expect(state.drivers).toEqual([]);
  });

  test('broadcasts order and batch events', async () => {
    const assignedEvent = waitForEvent<{ driverId: string; orderIds: string[] }>(
      client,
      'batch:assigned'
    );
    const createdEvent = waitForEvent<{ id: string }>(client, 'order:created');

    await fetch(`${baseUrl}/drivers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeDriver())
    });

    const order = makeOrder('o1');
    const response = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
    expect(response.status).toBe(201);

    const ready = await fetch(`${baseUrl}/orders/o1/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'READY' })
    });
    expect(ready.status).toBe(200);

    const created = await createdEvent;
    const assigned = await assignedEvent;

    expect(created.id).toBe('o1');
    expect(assigned.orderIds).toEqual(['o1']);
    expect(assigned.driverId).toBe('1388246780');
  });

  test('broadcasts status changes and completions', async () => {
    const statuses: string[] = [];
    const statusesSeen = new Promise<void>((resolve) => {
      client.on('order:status', (payload: { order: { status: string } }) => {
        statuses.push(payload.order.status);
        if (statuses.length === 3) resolve();
      });
    });
    const completedEvent = waitForEvent<{ completedAt: string }>(client, 'batch:completed');

    for (const status of ['PICKED_UP', 'IN_DELIVERY', 'DELIVERED']) {
      const response = await fetch(`${baseUrl}/orders/o1/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      expect(response.status).toBe(200);
    }

    await statusesSeen;
    expect(statuses).toEqual(['PICKED_UP', 'IN_DELIVERY', 'DELIVERED']);

    const completed = await completedEvent;
    expect(completed.completedAt).toBeDefined();
  });
});
