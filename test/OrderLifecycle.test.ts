import { BatchProcessingService, DISPATCH_DRIVER_ID } from '../src/services/BatchProcessingService';
import { DriverStatus, OrderStatus, PaymentStatus } from '../src/types/order';
import { makeDriver, makeOrder } from './helpers';

describe('order lifecycle', () => {
  test('moves an order through pickup, delivery, and frees the driver', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());
    await service.addOrder(makeOrder('o1'));
    const batch = await service.processBatch();

    expect((await service.updateOrderStatus('o1', OrderStatus.PICKED_UP)).pickedUpAt).toBeInstanceOf(
      Date
    );
    expect((await service.updateOrderStatus('o1', OrderStatus.IN_DELIVERY)).status).toBe(
      OrderStatus.IN_DELIVERY
    );
    const delivered = await service.updateOrderStatus('o1', OrderStatus.DELIVERED);

    expect(delivered.status).toBe(OrderStatus.DELIVERED);
    expect(delivered.deliveredAt).toBeInstanceOf(Date);

    const [driver] = await service.getDrivers();
    expect(driver?.status).toBe(DriverStatus.AVAILABLE);
    expect(driver?.isAvailable).toBe(true);
    expect(driver?.assignedOrders).toEqual([]);
    expect(driver?.totalDeliveries).toBe(1);

    const [storedBatch] = await service.getBatches();
    expect(storedBatch?.id).toBe(batch?.id);
    expect(storedBatch?.completedAt).toBeInstanceOf(Date);
  });

  test('rejects invalid transitions and transitions from terminal states', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());
    await service.addOrder(makeOrder('o1'));
    await service.processBatch();

    await expect(service.updateOrderStatus('o1', OrderStatus.DELIVERED)).rejects.toThrow(
      'cannot transition from ASSIGNED to DELIVERED'
    );
    await expect(service.updateOrderStatus('o1', OrderStatus.PENDING)).rejects.toThrow(
      'cannot transition from ASSIGNED to PENDING'
    );

    await service.updateOrderStatus('o1', OrderStatus.CANCELLED);
    await expect(service.updateOrderStatus('o1', OrderStatus.PICKED_UP)).rejects.toThrow(
      'cannot transition from CANCELLED to PICKED_UP'
    );
  });

  test('cancelling a pending order removes it from the queue', async () => {
    const service = new BatchProcessingService();
    await service.addOrder(makeOrder('o1'));

    await service.updateOrderStatus('o1', OrderStatus.CANCELLED);

    expect(await service.getQueueSize()).toBe(0);
    expect(await service.getPendingOrders()).toEqual([]);
  });

  test('cancelling an assigned order frees the driver', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());
    await service.addOrder(makeOrder('o1'));
    await service.processBatch();

    await service.updateOrderStatus('o1', OrderStatus.CANCELLED);

    const [driver] = await service.getDrivers();
    expect(driver?.status).toBe(DriverStatus.AVAILABLE);
    expect(driver?.totalDeliveries).toBe(0);
  });

  test('keeps the driver busy until every assigned order is terminal', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());
    await service.addOrder(makeOrder('o1'));
    await service.addOrder(makeOrder('o2'));
    await service.processBatch();

    const deliver = async (orderId: string): Promise<void> => {
      await service.updateOrderStatus(orderId, OrderStatus.PICKED_UP);
      await service.updateOrderStatus(orderId, OrderStatus.IN_DELIVERY);
      await service.updateOrderStatus(orderId, OrderStatus.DELIVERED);
    };

    await deliver('o1');
    expect((await service.getDrivers())[0]?.status).toBe(DriverStatus.BUSY);

    await deliver('o2');
    expect((await service.getDrivers())[0]?.status).toBe(DriverStatus.AVAILABLE);

    await service.addOrder(makeOrder('o3'));
    expect(await service.processBatch()).not.toBeNull();
    expect(await service.getBatches()).toHaveLength(2);
  });

  test('adds restaurant preparation time to the delivery estimate', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());
    await service.addOrder(makeOrder('o1', 13.7563, 100.5018, 100, 20));
    await service.addOrder(makeOrder('o2', 13.7563, 100.5018, 100, 35));

    const batch = await service.processBatch();

    expect(batch?.totalDistanceKm).toBe(0);
    expect(batch?.totalPreparationMinutes).toBe(35);
    expect(batch?.estimatedDurationMinutes).toBe(35);
  });

  test('throws for unknown orders and drivers', async () => {
    const service = new BatchProcessingService();

    expect(await service.getOrder('missing')).toBeUndefined();
    await expect(
      service.updateOrderStatus('missing', OrderStatus.CANCELLED)
    ).rejects.toThrow('Order missing was not found');
    await expect(
      service.updateDriver({ ...makeDriver('missing'), name: 'Nobody' })
    ).rejects.toThrow('Driver missing was not found');
  });

  test('supports failed then retried payments', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());
    const order = makeOrder('o1');
    order.paymentStatus = PaymentStatus.FAILED;
    await service.addOrder(order, false);

    expect(await service.getQueueSize()).toBe(0);
    expect((await service.getOrder('o1'))?.paymentStatus).toBe(PaymentStatus.FAILED);

    await service.updatePaymentStatus('o1', PaymentStatus.COMPLETED);
    await service.enqueueOrder('o1');
    const batch = await service.processBatch();

    expect(batch?.orderIds).toEqual(['o1']);
    expect((await service.getOrder('o1'))?.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect((await service.getOrder('o1'))?.assignedDriverId).toBe(DISPATCH_DRIVER_ID);
  });

  test('reports metrics for processed and delivered orders', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());
    await service.addOrder(makeOrder('o1', 13.76, 100.51, 100));
    await service.addOrder(makeOrder('o2', 13.77, 100.52, 50));
    await service.processBatch();
    await service.updateOrderStatus('o1', OrderStatus.PICKED_UP);
    await service.updateOrderStatus('o1', OrderStatus.IN_DELIVERY);
    await service.updateOrderStatus('o1', OrderStatus.DELIVERED);
    await service.updateOrderStatus('o2', OrderStatus.FAILED);

    const metrics = await service.getMetrics();

    expect(metrics.totalOrdersProcessed).toBe(2);
    expect(metrics.totalBatchesCreated).toBe(1);
    expect(metrics.pendingOrders).toBe(0);
    expect(metrics.successRate).toBeCloseTo(0.5);
    expect(metrics.totalRevenue).toBe(100);
    expect(metrics.activeDrivers).toBe(1);
    expect(metrics.averageProcessingTime).toBeGreaterThanOrEqual(0);
    expect(metrics.averageDeliveryTime).toBeGreaterThanOrEqual(0);
    expect(metrics.timestamp).toBeInstanceOf(Date);
  });

  test('skips duplicate order ids across stored and queued orders', async () => {
    const service = new BatchProcessingService();
    await service.addOrder(makeOrder('o1'));
    await expect(service.addOrder(makeOrder('o1'))).rejects.toThrow('already exists');

    const stored = makeOrder('o2');
    await service.addOrder(stored, false);
    await expect(service.addOrder(makeOrder('o2'))).rejects.toThrow('already exists');
  });

  test('dispatches automatically when auto processing is enabled', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());
    const assigned = new Promise<import('../src/types/order').BatchAssignment>((resolve) => {
      service.once('batch:assigned', resolve);
    });
    service.startAutoProcessing(120);
    try {
      await service.addOrder(makeOrder('o1'));
      const batch = await assigned;
      expect(batch.orderIds).toEqual(['o1']);
      expect(await service.getQueueSize()).toBe(0);
    } finally {
      service.stopAutoProcessing();
    }
  });
});
