import { Server } from 'http';
import { AddressInfo } from 'net';
import { app, dispatchService } from '../src/index';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
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

const driverPayload = {
  id: '1388246780',
  name: 'Target Driver',
  phone: '0000000000',
  vehicle: 'motorcycle',
  licensePlate: 'TARGET',
  currentLatitude: 13.7563,
  currentLongitude: 100.5018,
  maxOrdersPerBatch: 3
};

const orderPayload = {
  totalAmount: 100,
  deliveryFee: 10,
  restaurant: {
    id: 'r1',
    name: 'R1',
    address: 'A',
    latitude: 13.75,
    longitude: 100.5,
    phone: '0000000000',
    preparationTime: 5
  },
  customer: {
    id: 'c1',
    name: 'C1',
    phone: '0000000000',
    address: 'B',
    latitude: 13.76,
    longitude: 100.51
  },
  items: [{ id: 'i1', name: 'X', quantity: 1, price: 100 }]
};

test('GET /health reports service state', async () => {
  const response = await fetch(`${baseUrl}/health`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.status).toBe('ok');
  expect(body.dispatchDriverId).toBe('1388246780');
});

test('registered driver receives submitted orders', async () => {
  const registration = await fetch(`${baseUrl}/drivers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(driverPayload)
  });
  expect(registration.status).toBe(201);

  const response = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orderPayload)
  });
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.assignedToTargetDriver).toBe(true);
  expect(body.batch.driverId).toBe('1388246780');
  expect(body.queueSize).toBe(0);

  const pending = await fetch(`${baseUrl}/orders/pending`);
  const pendingBody = await pending.json();
  expect(pendingBody.orders).toEqual([]);
});

test('invalid order payloads are rejected with 400', async () => {
  const response = await fetch(`${baseUrl}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ totalAmount: 'free' })
  });
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error).toContain('restaurant');
});

test('driver registration requires a unique id', async () => {
  const response = await fetch(`${baseUrl}/drivers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(driverPayload)
  });
  expect(response.status).toBe(400);
  expect(dispatchService.getDrivers().length).toBeGreaterThan(0);
});
