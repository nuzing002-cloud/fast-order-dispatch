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
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

test('registers, reads, and updates a driver', async () => {
  expect((await post('/drivers', makeDriver())).status).toBe(201);

  const stored = await fetch(`${baseUrl}/drivers/1388246780`);
  expect(stored.status).toBe(200);
  expect((await stored.json()).driver.status).toBe('AVAILABLE');

  const moved = await patch('/drivers/1388246780', {
    currentLatitude: 13.8,
    currentLongitude: 100.6
  });
  expect(moved.status).toBe(200);
  const movedDriver = (await moved.json()).driver;
  expect(movedDriver.currentLatitude).toBe(13.8);
  expect(movedDriver.currentLongitude).toBe(100.6);
  expect(movedDriver.lastLocationUpdate).toBeDefined();

  const onBreak = await patch('/drivers/1388246780', { status: 'ON_BREAK' });
  expect(onBreak.status).toBe(200);
  expect((await onBreak.json()).driver.isAvailable).toBe(false);

  const back = await patch('/drivers/1388246780', { status: 'AVAILABLE' });
  expect((await back.json()).driver.isAvailable).toBe(true);
});

test('validates driver updates', async () => {
  expect((await patch('/drivers/1388246780', {})).status).toBe(400);
  expect((await patch('/drivers/1388246780', { currentLatitude: 999 })).status).toBe(400);
  expect((await patch('/drivers/1388246780', { status: 'BUSY' })).status).toBe(400);
  expect((await patch('/drivers/missing', { status: 'OFFLINE' })).status).toBe(404);
});

test('blocks manual status changes while the driver has active orders', async () => {
  expect((await post('/orders', makeOrder('o1'))).status).toBe(201);
  expect((await patch('/orders/o1/status', { status: 'READY' })).status).toBe(200);

  const blocked = await patch('/drivers/1388246780', { status: 'OFFLINE' });
  expect(blocked.status).toBe(409);

  const locationUpdate = await patch('/drivers/1388246780', {
    currentLatitude: 13.79,
    currentLongitude: 100.55
  });
  expect(locationUpdate.status).toBe(200);
});

describe('multi-driver dispatch', () => {
  test('selects the nearest allowed driver when several are configured', async () => {
    const multiService = new BatchProcessingService(3, undefined, {
      dispatchDriverIds: ['1388246780', 'driver-2']
    });
    await registerMultiDrivers(multiService);
    const app = createDispatchApp({ service: multiService });
    const multiServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => multiServer.once('listening', resolve));
    const url = `http://127.0.0.1:${(multiServer.address() as AddressInfo).port}`;

    const order = makeOrder('near-driver-2', 13.9, 100.9);
    const response = await fetch(`${url}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order)
    });
    expect(response.status).toBe(201);
    expect((await response.json()).order.status).toBe('PENDING');

    const ready = await fetch(`${url}/orders/near-driver-2/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'READY' })
    });
    expect(ready.status).toBe(200);
    const body = await ready.json();
    expect(body.order.assignedDriverId).toBe('driver-2');

    await new Promise<void>((resolve, reject) =>
      multiServer.close((error) => (error ? reject(error) : resolve()))
    );
  });

  test('ignores drivers outside the allowed list', async () => {
    const restricted = new BatchProcessingService();
    await restricted.registerDriver({
      ...makeDriver('outsider'),
      currentLatitude: 13.76,
      currentLongitude: 100.51
    });
    await restricted.addOrder(makeOrder('o1'));

    expect(await restricted.processBatch()).toBeNull();
    expect(await restricted.getQueueSize()).toBe(1);
  });
});

async function registerMultiDrivers(target: BatchProcessingService): Promise<void> {
  await target.registerDriver({
    ...makeDriver(),
    currentLatitude: 13.4,
    currentLongitude: 100.4
  });
  await target.registerDriver({
    ...makeDriver('driver-2'),
    currentLatitude: 13.9,
    currentLongitude: 100.9
  });
}
