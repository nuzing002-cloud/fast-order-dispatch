import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { logger } from '../logger';
import {
  DispatchStore,
  MemoryDispatchStore,
  OrderPage,
  OrderPageOptions
} from '../store/DispatchStore';
import { cloneBatch, cloneDriver, cloneOrder, clonePayment } from '../store/clone';
import {
  AuditLogEntry,
  BatchAssignment,
  Driver,
  DriverStatus,
  Order,
  OrderStatus,
  PaymentStatus,
  PaymentTransaction,
  SystemMetrics
} from '../types/order';
import { DistanceCalculator } from '../utils/DistanceCalculator';

export const DISPATCH_DRIVER_ID = '1388246780';

export interface BatchProcessingOptions {
  dispatchDriverIds?: string[];
}

export interface DriverPatch {
  currentLatitude?: number;
  currentLongitude?: number;
  status?: DriverStatus;
  isAvailable?: boolean;
  maxOrdersPerBatch?: number;
  rating?: number;
}

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.FAILED
]);

const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.CANCELLED, OrderStatus.FAILED],
  [OrderStatus.ASSIGNED]: [OrderStatus.PICKED_UP, OrderStatus.CANCELLED, OrderStatus.FAILED],
  [OrderStatus.PICKED_UP]: [OrderStatus.IN_DELIVERY, OrderStatus.CANCELLED, OrderStatus.FAILED],
  [OrderStatus.IN_DELIVERY]: [OrderStatus.DELIVERED, OrderStatus.FAILED],
  [OrderStatus.DELIVERED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.FAILED]: []
};

interface BatchPlan {
  batch: BatchAssignment;
  driver: Driver;
  batchOrders: Order[];
}

interface StatusPlan {
  order: Order;
  previousStatus: OrderStatus;
  driver?: Driver;
  completedBatches: BatchAssignment[];
}

export class BatchProcessingService extends EventEmitter {
  private readonly batchSize: number;
  private readonly store: DispatchStore;
  private readonly dispatchDriverIds: Set<string>;
  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    batchSize: number = 3,
    store: DispatchStore = new MemoryDispatchStore(),
    options: BatchProcessingOptions = {}
  ) {
    super();
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
      throw new ValidationError('Batch size must be an integer between 1 and 50');
    }
    this.batchSize = batchSize;
    this.store = store;
    this.dispatchDriverIds = new Set(
      options.dispatchDriverIds && options.dispatchDriverIds.length > 0
        ? options.dispatchDriverIds
        : [DISPATCH_DRIVER_ID]
    );
  }

  getStorageKind(): DispatchStore['kind'] {
    return this.store.kind;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async close(): Promise<void> {
    this.stopAutoProcessing();
    await this.store.close();
  }

  async addOrder(order: Order, enqueue: boolean = true): Promise<Order> {
    const now = new Date();
    const stored = cloneOrder({
      ...order,
      status: OrderStatus.PENDING,
      queuedAt: enqueue ? now : undefined,
      updatedAt: now
    });
    await this.store.transaction((tx) => tx.insertOrder(stored));
    this.emit('order:created', cloneOrder(stored));
    return cloneOrder(stored);
  }

  async enqueueOrder(orderId: string): Promise<Order> {
    const result = await this.store.transaction(async (tx) => {
      const order = await tx.getOrder(orderId, true);
      if (!order) throw new NotFoundError(`Order ${orderId} was not found`);
      if (order.status !== OrderStatus.PENDING) {
        throw new ConflictError(`Order ${orderId} is ${order.status} and cannot be queued`);
      }
      if (order.queuedAt) return { changed: false, order };
      const updated = cloneOrder({ ...order, queuedAt: new Date(), updatedAt: new Date() });
      await tx.updateOrder(updated);
      return { changed: true, order: updated };
    });

    if (result.changed) this.emit('order:queued', cloneOrder(result.order));
    return cloneOrder(result.order);
  }

  async processBatch(): Promise<BatchAssignment | null> {
    if (this.isProcessing) return null;
    this.isProcessing = true;

    try {
      const plan = await this.store.transaction<BatchPlan | null>(async (tx) => {
        const queuedOrders = await tx.lockQueuedOrders(this.batchSize);
        if (queuedOrders.length === 0) return null;

        const drivers = await tx.lockAvailableDrivers([...this.dispatchDriverIds]);
        if (drivers.length === 0) return null;

        let batchOrders = queuedOrders;
        let driver = this.selectDriver(drivers, batchOrders);

        if (!driver) {
          const availableCapacity = drivers.reduce(
            (capacity, candidate) =>
              Math.max(
                capacity,
                candidate.maxOrdersPerBatch - candidate.assignedOrders.length
              ),
            0
          );
          if (availableCapacity > 0) {
            batchOrders = queuedOrders.slice(
              0,
              Math.min(this.batchSize, availableCapacity)
            );
            driver = this.selectDriver(drivers, batchOrders);
          }
        }

        if (!driver) return null;

        const optimizedSequence = this.optimizeDeliverySequence(batchOrders, driver);
        const totalDistanceKm = this.calculateRouteDistance(
          batchOrders,
          optimizedSequence,
          driver
        );
        const travelMinutes = DistanceCalculator.estimateMinutes(totalDistanceKm);
        const totalPreparationMinutes = this.calculatePreparationMinutes(batchOrders);
        const estimatedDurationMinutes = travelMinutes + totalPreparationMinutes;
        const now = new Date();
        const driverId = driver.id;

        const batchAssignment: BatchAssignment = {
          id: `batch_${uuidv4()}`,
          driverId,
          orderIds: batchOrders.map((order) => order.id),
          createdAt: now,
          startedAt: now,
          totalRevenue: batchOrders.reduce((sum, order) => sum + order.totalAmount, 0),
          deliverySequence: optimizedSequence,
          totalDistanceKm: Number(totalDistanceKm.toFixed(3)),
          totalPreparationMinutes,
          estimatedDurationMinutes
        };

        const updatedDriver = cloneDriver({
          ...driver,
          status: DriverStatus.BUSY,
          isAvailable: false,
          assignedOrders: [
            ...driver.assignedOrders,
            ...batchOrders.map((order) => order.id)
          ],
          lastLocationUpdate: now
        });

        const updatedOrders = batchOrders.map((order) =>
          cloneOrder({
            ...order,
            status: OrderStatus.ASSIGNED,
            assignedDriverId: driverId,
            assignedAt: now,
            queuedAt: undefined,
            estimatedDeliveryTime: new Date(
              now.getTime() + estimatedDurationMinutes * 60_000
            ),
            updatedAt: now
          })
        );

        for (const order of updatedOrders) await tx.updateOrder(order);
        await tx.updateDriver(updatedDriver);
        await tx.insertBatch(batchAssignment);

        return { batch: batchAssignment, driver: updatedDriver, batchOrders: updatedOrders };
      });

      if (!plan) return null;

      this.emit('batch:assigned', cloneBatch(plan.batch));
      this.emit('driver:updated', cloneDriver(plan.driver));
      return cloneBatch(plan.batch);
    } finally {
      this.isProcessing = false;
    }
  }

  async updateOrderStatus(orderId: string, nextStatus: OrderStatus): Promise<Order> {
    const now = new Date();
    const plan = await this.store.transaction<StatusPlan>(async (tx) => {
      const current = await tx.getOrder(orderId, true);
      if (!current) throw new NotFoundError(`Order ${orderId} was not found`);

      const previousStatus = current.status;
      if (previousStatus === nextStatus) {
        return { order: current, previousStatus, completedBatches: [] };
      }
      if (!ALLOWED_TRANSITIONS[previousStatus].includes(nextStatus)) {
        throw new ConflictError(
          `Order ${orderId} cannot transition from ${previousStatus} to ${nextStatus}`
        );
      }

      const order = cloneOrder({
        ...current,
        status: nextStatus,
        updatedAt: now,
        queuedAt: previousStatus === OrderStatus.PENDING ? undefined : current.queuedAt,
        pickedUpAt:
          nextStatus === OrderStatus.PICKED_UP ? now : current.pickedUpAt,
        deliveredAt:
          nextStatus === OrderStatus.DELIVERED ? now : current.deliveredAt
      });

      await tx.updateOrder(order);

      let driver: Driver | undefined;
      const completedBatches: BatchAssignment[] = [];

      if (TERMINAL_STATUSES.has(nextStatus) && order.assignedDriverId) {
        const storedDriver = await tx.getDriver(order.assignedDriverId, true);
        if (storedDriver) {
          driver = cloneDriver({
            ...storedDriver,
            assignedOrders: storedDriver.assignedOrders.filter(
              (candidate) => candidate !== order.id
            ),
            totalDeliveries:
              storedDriver.totalDeliveries +
              (order.status === OrderStatus.DELIVERED ? 1 : 0),
            lastLocationUpdate: now
          });

          const activeOrders = await tx.getOrdersByIds(driver.assignedOrders);
          const hasActiveOrders = activeOrders.some(
            (candidate) => !TERMINAL_STATUSES.has(candidate.status)
          );
          if (!hasActiveOrders) {
            driver.status = DriverStatus.AVAILABLE;
            driver.isAvailable = true;
          }
          await tx.updateDriver(driver);
        }
      }

      if (TERMINAL_STATUSES.has(nextStatus)) {
        const batches = await tx.listBatchesForOrder(order.id, true);
        for (const batch of batches) {
          if (batch.completedAt) continue;
          const batchOrders = await tx.getOrdersByIds(batch.orderIds, true);
          const complete = batch.orderIds.every((id) => {
            const batchOrder = batchOrders.find((candidate) => candidate.id === id);
            return batchOrder !== undefined && TERMINAL_STATUSES.has(batchOrder.status);
          });
          if (complete) {
            const updatedBatch = cloneBatch({ ...batch, completedAt: now });
            await tx.updateBatch(updatedBatch);
            completedBatches.push(updatedBatch);
          }
        }
      }

      return { order, previousStatus, driver, completedBatches };
    });

    if (plan.previousStatus !== plan.order.status) {
      this.emit('order:status', {
        previousStatus: plan.previousStatus,
        order: cloneOrder(plan.order)
      });
    }
    if (plan.driver) this.emit('driver:updated', cloneDriver(plan.driver));
    for (const batch of plan.completedBatches) {
      this.emit('batch:completed', cloneBatch(batch));
    }

    return cloneOrder(plan.order);
  }

  async updatePaymentStatus(orderId: string, status: PaymentStatus): Promise<Order> {
    const order = await this.store.transaction(async (tx) => {
      const current = await tx.getOrder(orderId, true);
      if (!current) throw new NotFoundError(`Order ${orderId} was not found`);
      const updated = cloneOrder({
        ...current,
        paymentStatus: status,
        updatedAt: new Date()
      });
      await tx.updateOrder(updated);
      return updated;
    });

    this.emit('payment:updated', {
      status,
      order: cloneOrder(order)
    });
    return cloneOrder(order);
  }

  async recordPayment(transaction: PaymentTransaction): Promise<PaymentTransaction> {
    const stored = clonePayment(transaction);
    await this.store.transaction((tx) => tx.insertPayment(stored));
    this.emit('payment:recorded', clonePayment(stored));
    return clonePayment(stored);
  }

  async getPayments(orderId: string): Promise<PaymentTransaction[]> {
    return this.store.getPayments(orderId);
  }

  async getPayment(paymentId: string): Promise<PaymentTransaction | undefined> {
    return this.store.getPayment(paymentId);
  }

  async findPaymentByProviderTransactionId(
    providerTransactionId: string
  ): Promise<PaymentTransaction | undefined> {
    return this.store.findPaymentByProviderTransactionId(providerTransactionId);
  }

  async recordAudit(
    input: Omit<AuditLogEntry, 'id' | 'timestamp'>
  ): Promise<AuditLogEntry> {
    const entry: AuditLogEntry = {
      ...input,
      id: `audit_${uuidv4()}`,
      timestamp: new Date()
    };
    await this.store.transaction((tx) => tx.insertAudit(entry));
    return { ...entry, timestamp: new Date(entry.timestamp) };
  }

  async getAuditLog(
    limit = 50,
    offset = 0
  ): Promise<{ entries: AuditLogEntry[]; total: number }> {
    return this.store.getAuditLog(limit, offset);
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    return this.store.getOrder(orderId);
  }

  async getOrders(): Promise<Order[]> {
    return this.store.getOrders();
  }

  async getOrdersPage(options: OrderPageOptions): Promise<OrderPage> {
    return this.store.getOrdersPage(options);
  }

  async getBatches(): Promise<BatchAssignment[]> {
    return this.store.getBatches();
  }

  async getMetrics(): Promise<SystemMetrics> {
    return this.store.getMetrics();
  }

  getQueueSize(): Promise<number> {
    return this.store.getQueueSize();
  }

  getDispatchDriverIds(): string[] {
    return [...this.dispatchDriverIds];
  }

  isReady(): Promise<boolean> {
    return this.store.ping();
  }

  getPendingOrders(): Promise<Order[]> {
    return this.store.getPendingOrders();
  }

  async registerDriver(driver: Driver): Promise<void> {
    const stored = cloneDriver(driver);
    await this.store.transaction((tx) => tx.insertDriver(stored));
    this.emit('driver:updated', cloneDriver(stored));
  }

  async updateDriver(driver: Driver): Promise<void> {
    const stored = cloneDriver(driver);
    await this.store.transaction(async (tx) => {
      const existing = await tx.getDriver(stored.id, true);
      if (!existing) throw new NotFoundError(`Driver ${stored.id} was not found`);
      await tx.updateDriver(stored);
    });
    this.emit('driver:updated', cloneDriver(stored));
  }

  async updateDriverDetails(driverId: string, patch: DriverPatch): Promise<Driver> {
    const result = await this.store.transaction(async (tx) => {
      const current = await tx.getDriver(driverId, true);
      if (!current) throw new NotFoundError(`Driver ${driverId} was not found`);

      const assignedOrders = await tx.getOrdersByIds(current.assignedOrders);
      const hasActiveOrders = assignedOrders.some(
        (order) => !TERMINAL_STATUSES.has(order.status)
      );
      const changesStatus = patch.status !== undefined || patch.isAvailable !== undefined;
      if (hasActiveOrders && changesStatus) {
        throw new ConflictError(
          `Driver ${driverId} has active orders; status can only change after they finish`
        );
      }
      if (patch.status === DriverStatus.BUSY) {
        throw new ValidationError('status BUSY is managed by the dispatcher');
      }
      if (
        patch.isAvailable === true &&
        patch.status === undefined &&
        current.status !== DriverStatus.AVAILABLE
      ) {
        throw new ValidationError('isAvailable can only be true when status is AVAILABLE');
      }

      const driver = cloneDriver(current);
      if (patch.status !== undefined) {
        driver.status = patch.status;
        driver.isAvailable = patch.status === DriverStatus.AVAILABLE;
      }
      if (patch.isAvailable !== undefined) {
        driver.isAvailable = patch.isAvailable;
      }
      if (
        patch.currentLatitude !== undefined &&
        patch.currentLongitude !== undefined
      ) {
        driver.currentLatitude = patch.currentLatitude;
        driver.currentLongitude = patch.currentLongitude;
        driver.lastLocationUpdate = new Date();
      }
      if (patch.maxOrdersPerBatch !== undefined) {
        driver.maxOrdersPerBatch = patch.maxOrdersPerBatch;
      }
      if (patch.rating !== undefined) {
        driver.rating = patch.rating;
      }

      await tx.updateDriver(driver);
      return driver;
    });

    this.emit('driver:updated', cloneDriver(result));
    return cloneDriver(result);
  }

  async getDriver(driverId: string): Promise<Driver | undefined> {
    return this.store.getDriver(driverId);
  }

  async getDrivers(): Promise<Driver[]> {
    return this.store.getDrivers();
  }

  async getAvailableDrivers(): Promise<Driver[]> {
    return (await this.getDrivers()).filter(
      (driver) => driver.isAvailable && driver.status === DriverStatus.AVAILABLE
    );
  }

  startAutoProcessing(
    intervalMs: number,
    onBatch?: (batch: BatchAssignment) => void
  ): void {
    if (!Number.isInteger(intervalMs) || intervalMs < 100) {
      throw new ValidationError('Processing interval must be at least 100 milliseconds');
    }
    this.stopAutoProcessing();
    this.processingInterval = setInterval(() => {
      void this.processBatch()
        .then((batch) => {
          if (batch && onBatch) onBatch(batch);
        })
        .catch((error) => {
          logger.warn('auto_processing_failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }, intervalMs);
  }

  stopAutoProcessing(): void {
    if (this.processingInterval) clearInterval(this.processingInterval);
    this.processingInterval = null;
  }

  private optimizeDeliverySequence(orders: Order[], driver?: Driver): string[] {
    if (orders.length <= 1) {
      return orders.map((order) => order.id);
    }

    const sequence: string[] = [];
    const remaining = new Set(orders.map((_, index) => index));
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

      for (const index of remaining) {
        const nextOrder = orders[index];
        if (!nextOrder) continue;
        const distance = DistanceCalculator.calculate(
          currentOrder.customer.latitude,
          currentOrder.customer.longitude,
          nextOrder.customer.latitude,
          nextOrder.customer.longitude
        );

        if (distance < minDistance) {
          minDistance = distance;
          nearestIndex = index;
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

  private calculatePreparationMinutes(orders: Order[]): number {
    return orders.reduce(
      (longest, order) =>
        Math.max(longest, Math.ceil(order.restaurant.preparationTime)),
      0
    );
  }

  private selectDriver(drivers: Driver[], orders: Order[]): Driver | undefined {
    const availableDrivers = drivers.filter(
      (driver) =>
        driver.assignedOrders.length + orders.length <= driver.maxOrdersPerBatch
    );
    if (availableDrivers.length === 0) return undefined;

    const firstOrder = orders[0];
    if (!firstOrder) return availableDrivers[0];
    return [...availableDrivers].sort((left, right) => {
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
