import { BatchProcessingService } from '../src/services/BatchProcessingService';
import { PostgresDispatchStore } from '../src/store/PostgresDispatchStore';
import { PostgresSqlDatabase } from '../src/store/sql';
import { OrderStatus } from '../src/types/order';
import { makeDriver, makeOrder } from './helpers';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

// Destructive: truncates every dispatch table. Never point this at production.
describePostgres('PostgreSQL integration', () => {
  jest.setTimeout(60_000);

  let first: PostgresSqlDatabase;
  let second: PostgresSqlDatabase;
  let storeA: PostgresDispatchStore;
  let storeB: PostgresDispatchStore;

  beforeAll(async () => {
    first = new PostgresSqlDatabase({ connectionString: databaseUrl!, max: 4 });
    second = new PostgresSqlDatabase({ connectionString: databaseUrl!, max: 4 });
    storeA = new PostgresDispatchStore(first, 'postgres');
    storeB = new PostgresDispatchStore(second, 'postgres');
    await storeA.initialize();
    await storeB.initialize();
  });

  beforeEach(async () => {
    await first.exec(
      'TRUNCATE TABLE batch_orders, payments, audits, batches, orders, drivers, idempotency, driver_earnings, payouts, push_subscriptions RESTART IDENTITY CASCADE'
    );
  });

  afterAll(async () => {
    await first.close();
    await second.close();
  });

  test('reports readiness and rolls back failed transactions', async () => {
    expect(await first.ping()).toBe(true);

    const driver = makeDriver();
    await expect(
      storeA.transaction(async (tx) => {
        await tx.insertDriver(driver);
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');
    expect(await storeA.getDriver(driver.id)).toBeUndefined();

    await storeA.transaction(async (tx) => {
      await tx.insertDriver(driver);
    });
    expect((await storeA.getDriver(driver.id))?.id).toBe(driver.id);
  });

  test('assigns each order once across concurrent service instances', async () => {
    const serviceA = new BatchProcessingService(3, storeA, {
      dispatchDriverIds: ['d1', 'd2']
    });
    const serviceB = new BatchProcessingService(3, storeB, {
      dispatchDriverIds: ['d1', 'd2']
    });
    await serviceA.registerDriver(makeDriver('d1', 3));
    await serviceA.registerDriver(makeDriver('d2', 3));
    for (let index = 1; index <= 12; index += 1) {
      await serviceA.addOrder(makeOrder(`o${index}`));
    }

    for (let wave = 0; wave < 6; wave += 1) {
      const results = await Promise.all([
        serviceA.processBatch(),
        serviceB.processBatch()
      ]);
      if (results.every((batch) => batch === null)) break;
    }

    const orders = await serviceA.getOrders();
    const assigned = orders.filter((order) => order.status === OrderStatus.ASSIGNED);
    expect(assigned).toHaveLength(6);
    expect(new Set(assigned.map((order) => order.id)).size).toBe(6);
    expect(await serviceA.getQueueSize()).toBe(6);

    const firstDriver = await serviceA.getDriver('d1');
    const secondDriver = await serviceA.getDriver('d2');
    const assignedIds = [
      ...(firstDriver?.assignedOrders ?? []),
      ...(secondDriver?.assignedOrders ?? [])
    ];
    expect(firstDriver?.assignedOrders.length).toBeLessThanOrEqual(3);
    expect(secondDriver?.assignedOrders.length).toBeLessThanOrEqual(3);
    expect(assignedIds.sort()).toEqual(assigned.map((order) => order.id).sort());
  });

  test('allows exactly one cross-instance idempotency claim', async () => {
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? storeA : storeB).claimIdempotency(
          'checkout-key',
          'fingerprint',
          now,
          now + 60_000
        )
      )
    );
    expect(results.filter((result) => result.claimed)).toHaveLength(1);

    const claim = results.find((result) => result.claimed)!.record;
    await storeA.completeIdempotency({
      ...claim,
      status: 201,
      body: { id: 'o1' },
      createdAt: now,
      expiresAt: now + 60_000
    });
    expect((await storeB.getIdempotency('checkout-key'))?.body).toEqual({ id: 'o1' });

    await first.query(
      `INSERT INTO idempotency (key, fingerprint, status, body, created_at, expires_at)
       VALUES ($1, $2, 0, NULL, $3, $4)`,
      ['stale-key', 'fingerprint', now - 120_000, now + 60_000]
    );
    const reclaimed = await storeB.claimIdempotency(
      'stale-key',
      'fingerprint',
      now,
      now + 60_000
    );
    expect(reclaimed.claimed).toBe(true);
  });

  test('persists earnings, payouts, declines, and push subscriptions', async () => {
    const driverId = 'earn-driver';
    const service = new BatchProcessingService(3, storeA, {
      dispatchDriverIds: [driverId],
      driverSharePercent: 80
    });
    await service.registerDriver(makeDriver(driverId));

    await service.addOrder(makeOrder('earn-order'));
    expect((await service.processBatch())?.orderIds).toContain('earn-order');
    for (const status of [
      OrderStatus.PICKED_UP,
      OrderStatus.IN_DELIVERY,
      OrderStatus.DELIVERED
    ]) {
      await service.updateOrderStatus('earn-order', status);
    }

    const before = await service.getDriverEarnings(driverId);
    expect(before.pendingAmount).toBe(8);
    expect(before.earnings).toHaveLength(1);

    const payout = await service.createPayout({ driverId, method: 'promptpay' });
    expect(payout.amount).toBe(8);
    const after = await service.getDriverEarnings(driverId);
    expect(after.pendingAmount).toBe(0);
    expect(after.paidAmount).toBe(8);
    expect(after.earnings[0]?.status).toBe('PAID');
    await expect(service.createPayout({ driverId })).rejects.toThrow('no pending earnings');

    const second = makeOrder('decline-order');
    await service.addOrder(second);
    expect((await service.processBatch())?.orderIds).toContain('decline-order');
    const declined = await service.declineOrder('decline-order', driverId);
    expect(declined.order.status).toBe(OrderStatus.PENDING);
    expect(declined.order.assignedDriverId).toBeUndefined();
    expect(declined.order.declinedDriverIds).toContain(driverId);

    const endpoint = 'https://push.example.com/postgres';
    await storeA.savePushSubscription({
      endpoint,
      driverId,
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
      createdAt: new Date()
    });
    expect(await storeB.getPushSubscriptions(driverId)).toHaveLength(1);
    expect(await storeA.deletePushSubscription(endpoint)).toBe(true);
    expect(await storeB.getPushSubscriptions(driverId)).toHaveLength(0);
  });
});
