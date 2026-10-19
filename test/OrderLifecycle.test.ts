import { BatchProcessingService, DISPATCH_DRIVER_ID } from '../src/services/BatchProcessingService';
import { DriverStatus, OrderStatus, PaymentStatus } from '../src/types/order';
import { makeDriver, makeOrder } from './helpers';

describe('order lifecycle', () => {
  test('moves an order through pickup, delivery, and frees the driver', async () => {
    const service = new BatchProcessingService();
    service.registerDriver(makeDriver());
    const order = makeOrder('o1');
    service.addOrder(order);
    const batch = await service.processBatch();

    expect(service.updateOrderStatus('o1', OrderStatus.PICKED_UP).pickedUpAt).toBeInstanceOf(Date);
    expect(service.updateOrderStatus('o1', OrderStatus.IN_DELIVERY).status).toBe(OrderStatus.IN_DELIVERY);
    const delivered = service.updateOrderStatus('o1', OrderStatus.DELIVERED);

    expect(delivered.status).toBe(OrderStatus.DELIVERED);
    expect(delivered.deliveredAt).toBeInstanceOf(Date);

    const [driver] = service.getDrivers();
    expect(driver?.status).toBe(DriverStatus.AVAILABLE);
    expect(driver?.isAvailable).toBe(true);
    expect(driver?.assignedOrders).toEqual([]);
    expect(driver?.totalDeliveries).toBe(1);

    const [storedBatch] = service.getBatches();
    expect(storedBatch?.id).toBe(batch?.id);
    expect(storedBatch?.completedAt).toBeInstanceOf(Date);
  });

  test('rejects invalid transitions and transitions from terminal states', async () => {
    const service = new BatchProcessingService();
    service.registerDriver(makeDriver());
    service.addOrder(makeOrder('o1'));
    await service.processBatch();

    expect(() => service.updateOrderStatus('o1', OrderStatus.DELIVERED)).toThrow(
      'cannot transition from ASSIGNED to DELIVERED'
    );
    expect(() => service.updateOrderStatus('o1', OrderStatus.PENDING)).toThrow(
      'cannot transition from ASSIGNED to PENDING'
    );

    service.updateOrderStatus('o1', OrderStatus.CANCELLED);
    expect(() => service.updateOrderStatus('o1', OrderStatus.PICKED_UP)).toThrow(
      'cannot transition from CANCELLED to PICKED_UP'
    );
  });

  test('cancelling a pending order removes it from the queue', () => {
    const service = new BatchProcessingService();
    service.addOrder(makeOrder('o1'));

    service.updateOrderStatus('o1', OrderStatus.CANCELLED);

    expect(service.getQueueSize()).toBe(0);
    expect(service.getPendingOrders()).toEqual([]);
  });

  test('cancelling an assigned order frees the driver', async () => {
    const service = new BatchProcessingService();
    service.registerDriver(makeDriver());
    service.addOrder(makeOrder('o1'));
    await service.processBatch();

    service.updateOrderStatus('o1', OrderStatus.CANCELLED);

    const [driver] = service.getDrivers();
    expect(driver?.status).toBe(DriverStatus.AVAILABLE);
    expect(driver?.totalDeliveries).toBe(0);
  });

  test('keeps the driver busy until every assigned order is terminal', async () => {
    const service = new BatchProcessingService();
    service.registerDriver(makeDriver());
    service.addOrder(makeOrder('o1'));
    service.addOrder(makeOrder('o2'));
    await service.processBatch();

    const deliver = (orderId: string): void => {
      service.updateOrderStatus(orderId, OrderStatus.PICKED_UP);
      service.updateOrderStatus(orderId, OrderStatus.IN_DELIVERY);
      service.updateOrderStatus(orderId, OrderStatus.DELIVERED);
    };

    deliver('o1');
    expect(service.getDrivers()[0]?.status).toBe(DriverStatus.BUSY);

    deliver('o2');
    expect(service.getDrivers()[0]?.status).toBe(DriverStatus.AVAILABLE);

    service.addOrder(makeOrder('o3'));
    expect(await service.processBatch()).not.toBeNull();
    expect(service.getBatches()).toHaveLength(2);
  });

  test('adds restaurant preparation time to the delivery estimate', async () => {
    const service = new BatchProcessingService();
    service.registerDriver(makeDriver());
    service.addOrder(makeOrder('o1', 13.7563, 100.5018, 100, 20));
    service.addOrder(makeOrder('o2', 13.7563, 100.5018, 100, 35));

    const batch = await service.processBatch();

    expect(batch?.totalDistanceKm).toBe(0);
    expect(batch?.totalPreparationMinutes).toBe(35);
    expect(batch?.estimatedDurationMinutes).toBe(35);
  });

  test('throws for unknown orders and drivers', () => {
    const service = new BatchProcessingService();

    expect(service.getOrder('missing')).toBeUndefined();
    expect(() => service.updateOrderStatus('missing', OrderStatus.CANCELLED)).toThrow(
      'Order missing was not found'
    );
    expect(() =>
      service.updateDriver({ ...makeDriver('missing'), name: 'Nobody' })
    ).toThrow('Driver missing was not found');
  });

  test('supports failed then retried payments', async () => {
    const service = new BatchProcessingService();
    service.registerDriver(makeDriver());
    const order = makeOrder('o1');
    order.paymentStatus = PaymentStatus.FAILED;
    service.addOrder(order, false);

    expect(service.getQueueSize()).toBe(0);
    expect(service.getOrder('o1')?.paymentStatus).toBe(PaymentStatus.FAILED);

    service.updatePaymentStatus('o1', PaymentStatus.COMPLETED);
    service.enqueueOrder('o1');
    const batch = await service.processBatch();

    expect(batch?.orderIds).toEqual(['o1']);
    expect(service.getOrder('o1')?.paymentStatus).toBe(PaymentStatus.COMPLETED);
    expect(service.getOrder('o1')?.assignedDriverId).toBe(DISPATCH_DRIVER_ID);
  });

  test('reports metrics for processed and delivered orders', async () => {
    const service = new BatchProcessingService();
    service.registerDriver(makeDriver());
    service.addOrder(makeOrder('o1', 13.76, 100.51, 100));
    service.addOrder(makeOrder('o2', 13.77, 100.52, 50));
    await service.processBatch();
    service.updateOrderStatus('o1', OrderStatus.PICKED_UP);
    service.updateOrderStatus('o1', OrderStatus.IN_DELIVERY);
    service.updateOrderStatus('o1', OrderStatus.DELIVERED);
    service.updateOrderStatus('o2', OrderStatus.FAILED);

    const metrics = service.getMetrics();

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

  test('skips duplicate order ids across stored and queued orders', () => {
    const service = new BatchProcessingService();
    service.addOrder(makeOrder('o1'));
    expect(() => service.addOrder(makeOrder('o1'))).toThrow('already exists');

    const stored = makeOrder('o2');
    service.addOrder(stored, false);
    expect(() => service.addOrder(makeOrder('o2'))).toThrow('already exists');
  });

  test('dispatches automatically when auto processing is enabled', async () => {
    const service = new BatchProcessingService();
    service.registerDriver(makeDriver());
    const assigned = new Promise<import('../src/types/order').BatchAssignment>((resolve) => {
      service.once('batch:assigned', resolve);
    });
    service.startAutoProcessing(120);
    try {
      service.addOrder(makeOrder('o1'));
      const batch = await assigned;
      expect(batch.orderIds).toEqual(['o1']);
      expect(service.getQueueSize()).toBe(0);
    } finally {
      service.stopAutoProcessing();
    }
  });
});
