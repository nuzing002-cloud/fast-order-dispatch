import { Order, OrderStatus, Driver, BatchAssignment, DriverStatus } from '../types/order';
import { DistanceCalculator } from '../utils/DistanceCalculator';
import { v4 as uuidv4 } from 'uuid';

export const DISPATCH_DRIVER_ID = '1388246780';

/**
 * Batch Processing Service
 * Processes orders in configured batches, optimizes routing, and assigns to the configured driver
 */
export class BatchProcessingService {
  private readonly batchSize: number;
  private orderQueue: Order[] = [];
  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;
  private readonly drivers = new Map<string, Driver>();

  constructor(batchSize: number = 3) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
      throw new Error('Batch size must be an integer between 1 and 50');
    }
    this.batchSize = batchSize;
  }

  /**
   * Add order to processing queue
   */
  addOrder(order: Order): void {
    if (this.orderQueue.some((queuedOrder) => queuedOrder.id === order.id)) {
      throw new Error(`Order ${order.id} is already queued`);
    }
    order.status = OrderStatus.PENDING;
    order.updatedAt = new Date();
    this.orderQueue.push(order);
  }

  /**
   * Process orders in a configured batch size.
   */
  async processBatch(): Promise<BatchAssignment | null> {
    if (this.isProcessing || this.orderQueue.length === 0) {
      return null;
    }

    this.isProcessing = true;

    try {
      const queuedOrders = this.orderQueue.slice(0, this.batchSize);
      let batchOrders = queuedOrders;
      let driver = this.selectDriver(batchOrders);

      if (!driver) {
        const availableCapacity = this.getAvailableDispatchDrivers()
          .reduce(
            (capacity, availableDriver) =>
              Math.max(capacity, availableDriver.maxOrdersPerBatch - availableDriver.assignedOrders.length),
            0
          );

        if (availableCapacity > 0) {
          batchOrders = queuedOrders.slice(0, Math.min(this.batchSize, availableCapacity));
          driver = this.selectDriver(batchOrders);
        }
      }

      if (!driver) {
        return null;
      }

      const optimizedSequence = this.optimizeDeliverySequence(batchOrders, driver);
      const totalDistanceKm = this.calculateRouteDistance(batchOrders, optimizedSequence, driver);
      const estimatedDurationMinutes = DistanceCalculator.estimateMinutes(totalDistanceKm);
      const now = new Date();
      const driverId = driver.id;
      
      const batchAssignment: BatchAssignment = {
        id: `batch_${uuidv4()}`,
        driverId,
        orderIds: batchOrders.map(o => o.id),
        createdAt: now,
        startedAt: now,
        totalRevenue: batchOrders.reduce((sum, o) => sum + o.totalAmount, 0),
        deliverySequence: optimizedSequence,
        totalDistanceKm: Number(totalDistanceKm.toFixed(3)),
        estimatedDurationMinutes
      };

      const updatedDriver: Driver = {
        ...driver,
        status: DriverStatus.BUSY,
        isAvailable: false,
        assignedOrders: [
          ...driver.assignedOrders,
          ...batchOrders.map((order) => order.id)
        ],
        lastLocationUpdate: now
      };
      this.updateDriver(updatedDriver);

      for (const order of batchOrders) {
        order.status = OrderStatus.ASSIGNED;
        order.assignedDriverId = driver.id;
        order.assignedAt = now;
        order.estimatedDeliveryTime = new Date(now.getTime() + estimatedDurationMinutes * 60_000);
        order.updatedAt = now;
      }

      this.orderQueue.splice(0, batchOrders.length);

      return batchAssignment;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Optimize delivery sequence using nearest neighbor algorithm
   */
  private optimizeDeliverySequence(orders: Order[], driver?: Driver): string[] {
    if (orders.length <= 1) {
      return orders.map(o => o.id);
    }

    const sequence: string[] = [];
    const remaining = new Set(orders.map((_, i) => i));
    let currentIndex = -1;

    if (driver) {
      let nearestDistance = Infinity;
      for (const index of remaining) {
        const order = orders[index];
        if (!order) continue;
        const distance = DistanceCalculator.calculate(
          driver.currentLatitude,
          driver.currentLongitude,
          order.customer.latitude,
          order.customer.longitude
        );
        if (distance < nearestDistance) {
          nearestDistance = distance;
          currentIndex = index;
        }
      }
    }

    if (currentIndex === -1) currentIndex = 0;
    sequence.push(orders[currentIndex]?.id ?? '');
    remaining.delete(currentIndex);

    while (remaining.size > 0) {
      let nearestIndex = -1;
      let minDistance = Infinity;
      const currentOrder = orders[currentIndex];
      if (!currentOrder) break;

      for (const idx of remaining) {
        const nextOrder = orders[idx];
        if (!nextOrder) continue;
        const distance = DistanceCalculator.calculate(
          currentOrder.customer.latitude,
          currentOrder.customer.longitude,
          nextOrder.customer.latitude,
          nextOrder.customer.longitude
        );

        if (distance < minDistance) {
          minDistance = distance;
          nearestIndex = idx;
        }
      }

      if (nearestIndex !== -1) {
        sequence.push(orders[nearestIndex]?.id ?? '');
        currentIndex = nearestIndex;
        remaining.delete(nearestIndex);
      }
    }

    return sequence;
  }

  getQueueSize(): number {
    return this.orderQueue.length;
  }

  getPendingOrders(): Order[] {
    return [...this.orderQueue];
  }

  registerDriver(driver: Driver): void {
    if (this.drivers.has(driver.id)) {
      throw new Error(`Driver ${driver.id} already exists`);
    }
    this.drivers.set(driver.id, this.cloneDriver(driver));
  }

  /**
   * Save the driver's current state as a defensive snapshot.
   */
  updateDriver(driver: Driver): void {
    if (!this.drivers.has(driver.id)) {
      throw new Error(`Driver ${driver.id} was not found`);
    }
    this.drivers.set(driver.id, this.cloneDriver(driver));
  }

  getDrivers(): Driver[] {
    return [...this.drivers.values()].map((driver) => this.cloneDriver(driver));
  }

  getAvailableDrivers(): Driver[] {
    return this.getDrivers().filter(
      (driver) => driver.isAvailable && driver.status === DriverStatus.AVAILABLE
    );
  }

  startAutoProcessing(intervalMs: number, onBatch?: (batch: BatchAssignment) => void): void {
    if (!Number.isInteger(intervalMs) || intervalMs < 100) {
      throw new Error('Processing interval must be at least 100 milliseconds');
    }
    this.stopAutoProcessing();
    this.processingInterval = setInterval(async () => {
      const batch = await this.processBatch();
      if (batch && onBatch) onBatch(batch);
    }, intervalMs);
  }

  stopAutoProcessing(): void {
    if (this.processingInterval) clearInterval(this.processingInterval);
    this.processingInterval = null;
  }

  private selectDriver(orders: Order[]): Driver | undefined {
    const availableDrivers = this.getAvailableDispatchDrivers().filter(
      (driver) =>
        driver.assignedOrders.length + orders.length <= driver.maxOrdersPerBatch
    );
    if (availableDrivers.length === 0) return undefined;

    const firstOrder = orders[0];
    if (!firstOrder) return availableDrivers[0];
    return availableDrivers.sort((left, right) => {
      const leftDistance = DistanceCalculator.calculate(
        left.currentLatitude,
        left.currentLongitude,
        firstOrder.customer.latitude,
        firstOrder.customer.longitude
      );
      const rightDistance = DistanceCalculator.calculate(
        right.currentLatitude,
        right.currentLongitude,
        firstOrder.customer.latitude,
        firstOrder.customer.longitude
      );
      return leftDistance - rightDistance;
    })[0];
  }

  private getAvailableDispatchDrivers(): Driver[] {
    return [...this.drivers.values()]
      .filter(
        (driver) =>
          driver.id === DISPATCH_DRIVER_ID &&
          driver.isAvailable &&
          driver.status === DriverStatus.AVAILABLE
      )
      .map((driver) => this.cloneDriver(driver));
  }

  private cloneDriver(driver: Driver): Driver {
    return {
      ...driver,
      assignedOrders: [...driver.assignedOrders],
      lastLocationUpdate: driver.lastLocationUpdate
        ? new Date(driver.lastLocationUpdate)
        : undefined
    };
  }

  private calculateRouteDistance(
    orders: Order[],
    sequence: string[],
    driver?: Driver
  ): number {
    const orderById = new Map(orders.map((order) => [order.id, order]));
    let totalDistance = 0;
    let previous = driver
      ? { latitude: driver.currentLatitude, longitude: driver.currentLongitude }
      : undefined;

    for (const orderId of sequence) {
      const order = orderById.get(orderId);
      if (!order) continue;
      if (previous) {
        totalDistance += DistanceCalculator.calculate(
          previous.latitude,
          previous.longitude,
          order.customer.latitude,
          order.customer.longitude
        );
      }
      previous = {
        latitude: order.customer.latitude,
        longitude: order.customer.longitude
      };
    }
    return totalDistance;
  }
}
