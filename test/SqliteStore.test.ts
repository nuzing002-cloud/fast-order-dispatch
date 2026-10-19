import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function sqliteAvailable(): boolean {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

const describeSqlite = sqliteAvailable() ? describe : describe.skip;

describeSqlite('SqliteStore persistence', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'fast-order-dispatch-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test('restores drivers, batches, and orders from disk', async () => {
    const { BatchProcessingService } = require('../src/services/BatchProcessingService');
    const { SqliteStore } = require('../src/store/SqliteStore');
    const { makeDriver, makeOrder } = require('./helpers');
    const dbPath = join(directory, 'dispatch.sqlite3');

    const firstStore = new SqliteStore(dbPath);
    const first = new BatchProcessingService(3, firstStore);
    first.registerDriver(makeDriver());
    first.addOrder(makeOrder('o1', 13.76, 100.51, 120));
    first.addOrder(makeOrder('o2', 13.77, 100.52, 80));
    const batch = await first.processBatch();
    first.addOrder(makeOrder('o3'));
    firstStore.close();

    const secondStore = new SqliteStore(dbPath);
    const restored = new BatchProcessingService(3, secondStore);
    const orders = restored.getOrders();
    const drivers = restored.getDrivers();
    const batches = restored.getBatches();

    expect(orders).toHaveLength(3);
    expect(restored.getOrder('o1')?.status).toBe('ASSIGNED');
    expect(restored.getOrder('o1')?.createdAt).toBeInstanceOf(Date);
    expect(restored.getOrder('o1')?.assignedAt).toBeInstanceOf(Date);
    expect(restored.getOrder('o3')?.status).toBe('PENDING');
    expect(restored.getQueueSize()).toBe(1);
    expect(drivers).toHaveLength(1);
    expect(drivers[0].assignedOrders).toEqual(batch.orderIds);
    expect(batches).toHaveLength(1);
    expect(batches[0].createdAt).toBeInstanceOf(Date);
    expect(batches[0].deliverySequence).toHaveLength(2);
    secondStore.close();
  });

  test('keeps state isolated per database file', async () => {
    const { BatchProcessingService } = require('../src/services/BatchProcessingService');
    const { SqliteStore } = require('../src/store/SqliteStore');
    const { makeOrder } = require('./helpers');

    const storeA = new SqliteStore(join(directory, 'a.sqlite3'));
    const serviceA = new BatchProcessingService(3, storeA);
    serviceA.addOrder(makeOrder('o1'));
    storeA.close();

    const storeB = new SqliteStore(join(directory, 'b.sqlite3'));
    const serviceB = new BatchProcessingService(3, storeB);
    expect(serviceB.getOrders()).toEqual([]);
    storeB.close();
  });
});
