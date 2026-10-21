import { BatchProcessingService, DISPATCH_DRIVER_ID } from '../src/services/BatchProcessingService';
import { Driver, DriverStatus, Order, OrderStatus, PaymentStatus } from '../src/types/order';

function makeOrder(id: string, latitude = 13.76, longitude = 100.51, totalAmount = 100): Order {
  return {
    id,
    orderId: id,
    restaurant: {
      id: 'r1',
      name: 'Restaurant',
      address: 'Somewhere',
      latitude: 13.75,
      longitude: 100.5,
      phone: '0000000000',
      preparationTime: 5
    },
    customer: {
      id: `c_${id}`,
      name: 'Customer',
      phone: '0000000000',
      address: 'Elsewhere',
      latitude,
      longitude
    },
    items: [{ id: 'i1', name: 'Item', quantity: 1, price: totalAmount }],
    totalAmount,
    deliveryFee: 10,
    status: OrderStatus.PENDING,
    paymentStatus: PaymentStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

function makeDriver(id = DISPATCH_DRIVER_ID, maxOrdersPerBatch = 3): Driver {
  return {
    id,
    name: 'Target Driver',
    phone: '0000000000',
    vehicle: 'motorcycle',
    licensePlate: 'TARGET',
    status: DriverStatus.AVAILABLE,
    currentLatitude: 13.7563,
    currentLongitude: 100.5018,
    assignedOrders: [],
    totalDeliveries: 0,
    rating: 0,
    isAvailable: true,
    maxOrdersPerBatch
  };
}

describe('BatchProcessingService', () => {
  test('assigns a batch only to the configured dispatch driver', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver('other-driver'));
    await service.registerDriver(makeDriver());
    await service.addOrder(makeOrder('o1'));
    await service.addOrder(makeOrder('o2', 13.77, 100.52, 250));

    const batch = await service.processBatch();

    expect(batch).not.toBeNull();
    expect(batch?.driverId).toBe(DISPATCH_DRIVER_ID);
    expect(batch?.orderIds).toEqual(['o1', 'o2']);
    expect(batch?.totalRevenue).toBe(350);
    expect(batch?.deliverySequence).toHaveLength(2);
    expect(batch?.totalDistanceKm).toBeGreaterThan(0);
    expect(batch?.estimatedDurationMinutes).toBeGreaterThanOrEqual(1);
    expect(await service.getQueueSize()).toBe(0);
  });

  test('processes at most batchSize orders and leaves the rest pending', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());
    for (let index = 1; index <= 5; index += 1) {
      await service.addOrder(makeOrder(`o${index}`));
    }

    const batch = await service.processBatch();

    expect(batch?.orderIds).toHaveLength(3);
    expect(await service.getQueueSize()).toBe(2);
    expect(await service.processBatch()).toBeNull();

    const driver = (await service.getDrivers()).find(
      (candidate) => candidate.id === DISPATCH_DRIVER_ID
    );
    expect(driver?.status).toBe(DriverStatus.BUSY);
    expect(driver?.assignedOrders).toEqual(batch?.orderIds);
  });

  test('marks assigned orders with driver and delivery estimate', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());
    await service.addOrder(makeOrder('o1'));

    const batch = await service.processBatch();
    const order = await service.getOrder('o1');

    expect(batch?.deliverySequence).toEqual(['o1']);
    expect(order?.status).toBe(OrderStatus.ASSIGNED);
    expect(order?.assignedDriverId).toBe(DISPATCH_DRIVER_ID);
    expect(order?.assignedAt).toBeInstanceOf(Date);
    expect(order?.estimatedDeliveryTime).toBeInstanceOf(Date);
  });

  test('returns null and keeps orders queued when no driver is available', async () => {
    const service = new BatchProcessingService();
    await service.addOrder(makeOrder('o1'));

    expect(await service.processBatch()).toBeNull();
    expect(await service.getQueueSize()).toBe(1);
    expect((await service.getPendingOrders()).map((order) => order.id)).toEqual(['o1']);
  });

  test('rejects duplicate queued orders', async () => {
    const service = new BatchProcessingService();
    await service.addOrder(makeOrder('o1'));
    await expect(service.addOrder(makeOrder('o1'))).rejects.toThrow('already exists');
  });

  test('rejects duplicate driver registration', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());
    await expect(service.registerDriver(makeDriver())).rejects.toThrow('already exists');
  });

  test('returns defensive driver copies', async () => {
    const service = new BatchProcessingService();
    await service.registerDriver(makeDriver());

    const [driver] = await service.getDrivers();
    driver?.assignedOrders.push('injected');
    if (driver) driver.status = DriverStatus.OFFLINE;

    const [stored] = await service.getDrivers();
    expect(stored?.assignedOrders).toEqual([]);
    expect(stored?.status).toBe(DriverStatus.AVAILABLE);
  });

  test('validates batch size bounds', () => {
    expect(() => new BatchProcessingService(0)).toThrow();
    expect(() => new BatchProcessingService(51)).toThrow();
  });
});
