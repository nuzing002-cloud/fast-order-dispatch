import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BatchProcessingService } from '../src/services/BatchProcessingService';
import { PostgresDispatchStore } from '../src/store/PostgresDispatchStore';
import { PgliteSqlDatabase } from '../src/store/pglite';
import { DriverStatus, OrderStatus, PaymentStatus, PaymentTransaction } from '../src/types/order';
import { makeDriver, makeOrder } from './helpers';

jest.setTimeout(120_000);

async function createStore(dataDir?: string): Promise<{
  database: PgliteSqlDatabase;
  store: PostgresDispatchStore;
}> {
  const database = new PgliteSqlDatabase(dataDir);
  const store = new PostgresDispatchStore(database, 'pglite');
  await store.initialize();
  return { database, store };
}

describe('PostgreSQL dispatch store', () => {
  test('persists the full dispatch lifecycle', async () => {
    const { database, store } = await createStore();
    try {
      const service = new BatchProcessingService(2, store);
      await service.registerDriver(makeDriver());
      await service.addOrder(makeOrder('o1', 13.76, 100.51, 100));
      await service.addOrder(makeOrder('o2', 13.77, 100.52, 50));
      await service.addOrder(makeOrder('o3', 13.9, 100.7));

      const batch = await service.processBatch();
      expect(batch?.orderIds).toHaveLength(2);
      expect(await service.getQueueSize()).toBe(1);
      expect((await service.getOrder('o1'))?.status).toBe(OrderStatus.ASSIGNED);
      expect((await service.getDriver(makeDriver().id))?.status).toBe(DriverStatus.BUSY);

      const pending = await service.getPendingOrders();
      expect(pending.map((order) => order.id)).toEqual(['o3']);

      const page = await service.getOrdersPage({ limit: 10, offset: 0 });
      expect(page.total).toBe(3);
      expect(page.orders.map((order) => order.id)).toEqual(['o1', 'o2', 'o3']);

      const filtered = await service.getOrdersPage({
        status: OrderStatus.ASSIGNED,
        limit: 10,
        offset: 0
      });
      expect(filtered.orders.map((order) => order.id)).toEqual(['o1', 'o2']);

      await service.updateOrderStatus('o1', OrderStatus.PICKED_UP);
      await service.updateOrderStatus('o1', OrderStatus.IN_DELIVERY);
      await service.updateOrderStatus('o1', OrderStatus.DELIVERED);
      expect((await service.getDriver(makeDriver().id))?.status).toBe(DriverStatus.BUSY);

      await service.updateOrderStatus('o2', OrderStatus.CANCELLED);
      const driver = await service.getDriver(makeDriver().id);
      expect(driver?.status).toBe(DriverStatus.AVAILABLE);
      expect(driver?.totalDeliveries).toBe(1);
      expect(driver?.assignedOrders).toEqual([]);

      const batches = await service.getBatches();
      expect(batches).toHaveLength(1);
      expect(batches[0]?.completedAt).toBeInstanceOf(Date);

      const metrics = await service.getMetrics();
      expect(metrics.totalOrdersProcessed).toBe(2);
      expect(metrics.totalBatchesCreated).toBe(1);
      expect(metrics.pendingOrders).toBe(1);
      expect(metrics.successRate).toBe(0.5);
      expect(metrics.totalRevenue).toBe(100);
      expect(metrics.activeDrivers).toBe(1);

      const payment: PaymentTransaction = {
        id: 'tx1',
        orderId: 'o1',
        amount: 100,
        method: 'card',
        kind: 'charge',
        status: PaymentStatus.COMPLETED,
        providerTransactionId: 'prov-1',
        createdAt: new Date(),
        processedAt: new Date()
      };
      await service.recordPayment(payment);
      expect((await service.findPaymentByProviderTransactionId('prov-1'))?.id).toBe('tx1');
      expect((await service.getPayments('o1'))).toHaveLength(1);

      const audit = await service.recordAudit({
        actor: 'tester',
        role: 'admin',
        action: 'test.action',
        entityType: 'order',
        entityId: 'o1'
      });
      const auditLog = await service.getAuditLog(10, 0);
      expect(auditLog.total).toBe(1);
      expect(auditLog.entries[0]?.id).toBe(audit.id);

      expect(await service.isReady()).toBe(true);
    } finally {
      await database.close();
    }
  });

  test('keeps data across store restarts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fast-order-dispatch-'));
    const first = await createStore(directory);
    let assignedOrderIds: string[] = [];
    try {
      const service = new BatchProcessingService(3, first.store);
      await service.registerDriver(makeDriver());
      await service.addOrder(makeOrder('o1', 13.76, 100.51, 120));
      await service.addOrder(makeOrder('o2', 13.77, 100.52, 80));
      const batch = await service.processBatch();
      assignedOrderIds = batch?.orderIds ?? [];
      await service.addOrder(makeOrder('o3'));
      await service.recordPayment({
        id: 'tx1',
        orderId: 'o1',
        amount: 120,
        method: 'card',
        kind: 'charge',
        status: PaymentStatus.COMPLETED,
        createdAt: new Date(),
        processedAt: new Date()
      });
      expect(batch).not.toBeNull();
    } finally {
      await first.database.close();
    }

    const second = await createStore(directory);
    try {
      const restored = new BatchProcessingService(3, second.store);
      expect((await restored.getOrders()).map((order) => order.id)).toEqual(['o1', 'o2', 'o3']);
      expect((await restored.getOrder('o1'))?.status).toBe(OrderStatus.ASSIGNED);
      expect((await restored.getOrder('o1'))?.createdAt).toBeInstanceOf(Date);
      expect((await restored.getOrder('o1'))?.assignedAt).toBeInstanceOf(Date);
      expect((await restored.getOrder('o3'))?.status).toBe(OrderStatus.READY);
      expect(await restored.getQueueSize()).toBe(1);
      const [driver] = await restored.getDrivers();
      expect(driver?.assignedOrders).toEqual(assignedOrderIds);
      const [storedBatch] = await restored.getBatches();
      expect(storedBatch?.createdAt).toBeInstanceOf(Date);
      expect(storedBatch?.deliverySequence).toHaveLength(2);
      expect(await restored.getPayments('o1')).toHaveLength(1);
    } finally {
      await second.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('serializes dispatch across two service instances sharing a database', async () => {
    const { database, store } = await createStore();
    const other = new PostgresDispatchStore(database, 'pglite');
    try {
      const serviceA = new BatchProcessingService(3, store);
      const serviceB = new BatchProcessingService(3, other);
      await serviceA.registerDriver(makeDriver());
      for (let index = 1; index <= 6; index += 1) {
        await serviceA.addOrder(makeOrder(`o${index}`));
      }

      const [first, second] = await Promise.all([
        serviceA.processBatch(),
        serviceB.processBatch()
      ]);
      const assigned = [first, second].filter((batch) => batch !== null);
      const orderIds = assigned.flatMap((batch) => batch!.orderIds);
      expect(new Set(orderIds).size).toBe(orderIds.length);
      expect(orderIds).toHaveLength(3);
      expect(await serviceA.getQueueSize()).toBe(3);
      expect((await serviceA.getDriver(makeDriver().id))?.assignedOrders).toHaveLength(3);
    } finally {
      await database.close();
    }
  });

  test('coordinates idempotency claims across instances', async () => {
    const { database, store } = await createStore();
    const other = new PostgresDispatchStore(database, 'pglite');
    try {
      const now = Date.now();
      const first = await store.claimIdempotency('key', 'fingerprint', now, now + 60_000);
      expect(first.claimed).toBe(true);
      expect(first.record.status).toBe(0);

      const second = await other.claimIdempotency('key', 'fingerprint', now, now + 60_000);
      expect(second.claimed).toBe(false);
      expect(second.record.status).toBe(0);

      await store.completeIdempotency({
        ...first.record,
        status: 201,
        body: { ok: true },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000
      });
      const replay = await other.getIdempotency('key');
      expect(replay?.status).toBe(201);
      expect(replay?.body).toEqual({ ok: true });

      const claimed = await other.claimIdempotency('key', 'fingerprint', Date.now(), Date.now() + 1);
      expect(claimed.claimed).toBe(false);
      expect(claimed.record.status).toBe(201);

      const expired = await other.claimIdempotency('key', 'new-fingerprint', Date.now() + 120_000, Date.now() + 180_000);
      expect(expired.claimed).toBe(true);
      expect(expired.record.fingerprint).toBe('new-fingerprint');
      await other.releaseIdempotency('key');
      expect(await store.getIdempotency('key')).toBeUndefined();
    } finally {
      await database.close();
    }
  });

  test('reclaims stale claims without letting stale completions overwrite', async () => {
    const { database, store } = await createStore();
    const other = new PostgresDispatchStore(database, 'pglite');
    try {
      const now = Date.now();
      const first = await store.claimIdempotency('stale', 'fingerprint', now, now + 60_000);
      await database.query('UPDATE idempotency SET created_at = $1 WHERE key = $2', [
        now - 120_000,
        'stale'
      ]);

      const second = await other.claimIdempotency('stale', 'fingerprint', now, now + 60_000);
      expect(second.claimed).toBe(true);
      expect(second.record.claimToken).not.toBe(first.record.claimToken);

      await store.completeIdempotency({
        ...first.record,
        status: 500,
        body: { stale: true },
        createdAt: now,
        expiresAt: now + 60_000
      });
      expect((await other.getIdempotency('stale'))?.status).toBe(0);

      await store.releaseIdempotency('stale', first.record.claimToken);
      expect(await other.getIdempotency('stale')).toBeDefined();

      await other.completeIdempotency({
        ...second.record,
        status: 201,
        body: { fresh: true },
        createdAt: now,
        expiresAt: now + 60_000
      });
      expect((await store.getIdempotency('stale'))?.body).toEqual({ fresh: true });
    } finally {
      await database.close();
    }
  });

  test('validates driver updates and order transitions in SQL', async () => {
    const { database, store } = await createStore();
    try {
      const service = new BatchProcessingService(3, store);
      await service.registerDriver(makeDriver());
      await service.addOrder(makeOrder('o1'));

      await expect(
        service.updateOrderStatus('o1', OrderStatus.DELIVERED)
      ).rejects.toThrow('cannot transition from READY to DELIVERED');
      await expect(
        service.updateDriverDetails(makeDriver().id, { rating: 4.5 })
      ).resolves.toBeDefined();

      await service.processBatch();
      await expect(
        service.updateDriverDetails(makeDriver().id, { status: DriverStatus.OFFLINE })
      ).rejects.toThrow('has active orders');

      await service.updateOrderStatus('o1', OrderStatus.CANCELLED);
      await expect(service.enqueueOrder('o1')).rejects.toThrow('cannot be queued');
    } finally {
      await database.close();
    }
  });
});

