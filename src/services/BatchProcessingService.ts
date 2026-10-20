import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { InMemoryStore, Store } from '../store/Store';
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

/**
 * Batch Processing Service
 * Processes orders in configured batches, optimizes routing, assigns the configured
 * driver, tracks the order lifecycle, and optionally persists state through a Store.
 */
export class BatchProcessingService extends EventEmitter {
  private readonly batchSize: number;
  private readonly store: Store;
  private readonly dispatchDriverIds: Set<string>;
  private readonly drivers = new Map<string, Driver>();
  private readonly orders = new Map<string, Order>();
  private readonly batches = new Map<string, BatchAssignment>();
  private readonly payments = new Map<string, PaymentTransaction>();
  private readonly audits: AuditLogEntry[] = [];
  private orderQueue: Order[] = [];
  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    batchSize: number = 3,
    store: Store = new InMemoryStore(),
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
    this.restore();
  }

  private restore(): void {
    const state = this.store.load();
    for (const driver of state.drivers) this.drivers.set(driver.id, driver);
    for (const order of state.orders) this.orders.set(order.id, order);
    for (const batch of state.batches) this.batches.set(batch.id, batch);
    for (const payment of state.payments) this.payments.set(payment.id, payment);
    for (const audit of state.audits ?? []) this.audits.push(audit);
    this.orderQueue = [...this.orders.values()]
      .filter((order) => order.status === OrderStatus.PENDING)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  /**
   * Add an order to the dispatch queue. Set enqueue to false to keep a record
   * (for example a failed payment) without making it dispatchable.
   */
  addOrder(order: Order, enqueue: boolean = true): void {
    if (this.orders.has(order.id)) {
      throw new ConflictError(`Order ${order.id} already exists`);
    }
    order.status = OrderStatus.PENDING;
    order.updatedAt = new Date();
    this.orders.set(order.id, order);
    if (enqueue) this.orderQueue.push(order);
    this.store.saveOrder(order);
    this.emit('order:created', this.cloneOrder(order));
  }

  enqueueOrder(orderId: string): Order {
    const order = this.requireOrder(orderId);
    if (order.status !== OrderStatus.PENDING) {
      throw new ConflictError(`Order ${orderId} is ${order.status} and cannot be queued`);
    }
    if (!this.orderQueue.some((queuedOrder) => queuedOrder.id === orderId)) {
      order.updatedAt = new Date();
      this.orderQueue.push(order);
      this.store.saveOrder(order);
      this.emit('order:queued', this.cloneOrder(order));
    }
    return this.cloneOrder(order);
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
        const availableCapacity = this.getAvailableDispatchDrivers().reduce(
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

      const updatedDriver: Driver = {
        ...driver,
        status: DriverStatus.BUSY,
        isAvailable: false,
        assignedOrders: [...driver.assignedOrders, ...batchOrders.map((order) => order.id)],
        lastLocationUpdate: now
      };
      this.updateDriver(updatedDriver);

      for (const order of batchOrders) {
        order.status = OrderStatus.ASSIGNED;
        order.assignedDriverId = driverId;
        order.assignedAt = now;
        order.estimatedDeliveryTime = new Date(now.getTime() + estimatedDurationMinutes * 60_000);
        order.updatedAt = now;
        this.store.saveOrder(order);
      }

      this.batches.set(batchAssignment.id, batchAssignment);
      this.store.saveBatch(batchAssignment);
      this.orderQueue.splice(0, batchOrders.length);

      this.emit('batch:assigned', this.cloneBatch(batchAssignment));
      this.emit('driver:updated', this.cloneDriver(updatedDriver));

      return batchAssignment;
    } finally {
      this.isProcessing = false;
    }
  }

  updateOrderStatus(orderId: string, nextStatus: OrderStatus): Order {
    const order = this.requireOrder(orderId);
    const previousStatus = order.status;

    if (previousStatus === nextStatus) {
      return this.cloneOrder(order);
    }

    if (!ALLOWED_TRANSITIONS[previousStatus].includes(nextStatus)) {
      throw new ConflictError(
        `Order ${orderId} cannot transition from ${previousStatus} to ${nextStatus}`
      );
    }

    const now = new Date();
    order.status = nextStatus;
    order.updatedAt = now;
    if (nextStatus === OrderStatus.PICKED_UP) order.pickedUpAt = now;
    if (nextStatus === OrderStatus.DELIVERED) order.deliveredAt = now;

    if (previousStatus === OrderStatus.PENDING) {
      this.removeFromQueue(orderId);
    }

    this.store.saveOrder(order);

    if (TERMINAL_STATUSES.has(nextStatus)) {
      this.releaseDriverCapacity(order, now);
      this.completeBatchIfDone(orderId, now);
    }

    this.emit('order:status', {
      previousStatus,
      order: this.cloneOrder(order)
    });

    return this.cloneOrder(order);
  }

  updatePaymentStatus(orderId: string, status: PaymentStatus): Order {
    const order = this.requireOrder(orderId);
    order.paymentStatus = status;
    order.updatedAt = new Date();
    this.store.saveOrder(order);
    this.emit('payment:updated', {
      status,
      order: this.cloneOrder(order)
    });
    return this.cloneOrder(order);
  }

  recordPayment(transaction: PaymentTransaction): PaymentTransaction {
    const stored = this.clonePayment(transaction);
    this.payments.set(stored.id, stored);
    this.store.savePayment(stored);
    this.emit('payment:recorded', this.clonePayment(stored));
    return this.clonePayment(stored);
  }

  getPayments(orderId: string): PaymentTransaction[] {
    return [...this.payments.values()]
      .filter((payment) => payment.orderId === orderId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .map((payment) => this.clonePayment(payment));
  }

  getPayment(paymentId: string): PaymentTransaction | undefined {
    const payment = this.payments.get(paymentId);
    return payment ? this.clonePayment(payment) : undefined;
  }

  findPaymentByProviderTransactionId(providerTransactionId: string): PaymentTransaction | undefined {
    for (const payment of this.payments.values()) {
      if (payment.providerTransactionId === providerTransactionId) {
        return this.clonePayment(payment);
      }
    }
    return undefined;
  }

  recordAudit(input: Omit<AuditLogEntry, 'id' | 'timestamp'>): AuditLogEntry {
    const entry: AuditLogEntry = {
      ...input,
      id: `audit_${uuidv4()}`,
      timestamp: new Date()
    };
    this.audits.push(entry);
    this.store.saveAudit(entry);
    return this.cloneAudit(entry);
  }

  getAuditLog(limit = 50, offset = 0): { entries: AuditLogEntry[]; total: number } {
    const sorted = [...this.audits].sort(
      (left, right) => right.timestamp.getTime() - left.timestamp.getTime()
    );
    return {
      entries: sorted.slice(offset, offset + limit).map((entry) => this.cloneAudit(entry)),
      total: sorted.length
    };
  }

  getOrder(orderId: string): Order | undefined {
    const order = this.orders.get(orderId);
    return order ? this.cloneOrder(order) : undefined;
  }

  getOrders(): Order[] {
    return [...this.orders.values()].map((order) => this.cloneOrder(order));
  }

  getBatches(): BatchAssignment[] {
    return [...this.batches.values()].map((batch) => this.cloneBatch(batch));
  }

  getMetrics(): SystemMetrics {
    const orders = [...this.orders.values()];
    const assignedOrders = orders.filter((order) => order.assignedAt !== undefined);
    const deliveredOrders = orders.filter((order) => order.status === OrderStatus.DELIVERED);
    const failedOrders = orders.filter(
      (order) => order.status === OrderStatus.FAILED || order.status === OrderStatus.CANCELLED
    );
    const terminalCount = deliveredOrders.length + failedOrders.length;

    const average = (values: number[]): number =>
      values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

    const processingTimes = assignedOrders.map(
      (order) => order.assignedAt!.getTime() - order.createdAt.getTime()
    );
    const deliveryTimes = deliveredOrders
      .filter((order) => order.deliveredAt !== undefined && order.assignedAt !== undefined)
      .map((order) => order.deliveredAt!.getTime() - order.assignedAt!.getTime());

    return {
      totalOrdersProcessed: assignedOrders.length,
      totalBatchesCreated: this.batches.size,
      averageProcessingTime: average(processingTimes),
      averageDeliveryTime: average(deliveryTimes),
      successRate: terminalCount === 0 ? 0 : deliveredOrders.length / terminalCount,
      totalRevenue: deliveredOrders
        .filter((order) => order.paymentStatus !== PaymentStatus.REFUNDED)
        .reduce((sum, order) => sum + order.totalAmount, 0),
      activeDrivers: [...this.drivers.values()].filter(
        (driver) => driver.isAvailable && driver.status === DriverStatus.AVAILABLE
      ).length,
      pendingOrders: this.orderQueue.length,
      timestamp: new Date()
    };
  }

  /**
   * Optimize delivery sequence using nearest neighbor algorithm
   */
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

  getQueueSize(): number {
    return this.orderQueue.length;
  }

  getDispatchDriverIds(): string[] {
    return [...this.dispatchDriverIds];
  }

  isReady(): boolean {
    return this.store.ping();
  }

  getPendingOrders(): Order[] {
    return this.orderQueue.map((order) => this.cloneOrder(order));
  }

  registerDriver(driver: Driver): void {
    if (this.drivers.has(driver.id)) {
      throw new ConflictError(`Driver ${driver.id} already exists`);
    }
    const stored = this.cloneDriver(driver);
    this.drivers.set(stored.id, stored);
    this.store.saveDriver(stored);
    this.emit('driver:updated', this.cloneDriver(stored));
  }

  updateDriver(driver: Driver): void {
    if (!this.drivers.has(driver.id)) {
      throw new NotFoundError(`Driver ${driver.id} was not found`);
    }
    const stored = this.cloneDriver(driver);
    this.drivers.set(stored.id, stored);
    this.store.saveDriver(stored);
  }

  updateDriverDetails(driverId: string, patch: DriverPatch): Driver {
    const driver = this.drivers.get(driverId);
    if (!driver) throw new NotFoundError(`Driver ${driverId} was not found`);

    const hasActiveOrders = driver.assignedOrders.some((orderId) => {
      const order = this.orders.get(orderId);
      return order !== undefined && !TERMINAL_STATUSES.has(order.status);
    });
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
      driver.status !== DriverStatus.AVAILABLE
    ) {
      throw new ValidationError('isAvailable can only be true when status is AVAILABLE');
    }

    if (patch.status !== undefined) {
      driver.status = patch.status;
      driver.isAvailable = patch.status === DriverStatus.AVAILABLE;
    }
    if (patch.isAvailable !== undefined) {
      driver.isAvailable = patch.isAvailable;
    }
    if (patch.currentLatitude !== undefined && patch.currentLongitude !== undefined) {
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

    this.store.saveDriver(driver);
    this.emit('driver:updated', this.cloneDriver(driver));
    return this.cloneDriver(driver);
  }

  getDriver(driverId: string): Driver | undefined {
    const driver = this.drivers.get(driverId);
    return driver ? this.cloneDriver(driver) : undefined;
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
      throw new ValidationError('Processing interval must be at least 100 milliseconds');
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

  private requireOrder(orderId: string): Order {
    const order = this.orders.get(orderId);
    if (!order) throw new NotFoundError(`Order ${orderId} was not found`);
    return order;
  }

  private removeFromQueue(orderId: string): void {
    this.orderQueue = this.orderQueue.filter((order) => order.id !== orderId);
  }

  private releaseDriverCapacity(order: Order, now: Date): void {
    if (!order.assignedDriverId) return;
    const driver = this.drivers.get(order.assignedDriverId);
    if (!driver) return;

    driver.assignedOrders = driver.assignedOrders.filter((orderId) => orderId !== order.id);
    if (order.status === OrderStatus.DELIVERED) {
      driver.totalDeliveries += 1;
    }

    const hasActiveOrders = driver.assignedOrders.some((orderId) => {
      const assignedOrder = this.orders.get(orderId);
      return assignedOrder !== undefined && !TERMINAL_STATUSES.has(assignedOrder.status);
    });

    if (!hasActiveOrders) {
      driver.status = DriverStatus.AVAILABLE;
      driver.isAvailable = true;
    }

    driver.lastLocationUpdate = now;
    this.store.saveDriver(driver);
    this.emit('driver:updated', this.cloneDriver(driver));
  }

  private completeBatchIfDone(orderId: string, now: Date): void {
    for (const batch of this.batches.values()) {
      if (batch.completedAt || !batch.orderIds.includes(orderId)) continue;
      const isComplete = batch.orderIds.every((id) => {
        const order = this.orders.get(id);
        return order !== undefined && TERMINAL_STATUSES.has(order.status);
      });
      if (isComplete) {
        batch.completedAt = now;
        this.store.saveBatch(batch);
        this.emit('batch:completed', this.cloneBatch(batch));
      }
    }
  }

  private calculatePreparationMinutes(orders: Order[]): number {
    return orders.reduce(
      (longest, order) => Math.max(longest, Math.ceil(order.restaurant.preparationTime)),
      0
    );
  }

  private selectDriver(orders: Order[]): Driver | undefined {
    const availableDrivers = this.getAvailableDispatchDrivers().filter(
      (driver) => driver.assignedOrders.length + orders.length <= driver.maxOrdersPerBatch
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
          this.dispatchDriverIds.has(driver.id) &&
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

  private cloneOrder(order: Order): Order {
    return {
      ...order,
      restaurant: { ...order.restaurant },
      customer: { ...order.customer },
      items: order.items.map((item) => ({ ...item })),
      createdAt: new Date(order.createdAt),
      updatedAt: new Date(order.updatedAt),
      assignedAt: order.assignedAt ? new Date(order.assignedAt) : undefined,
      pickedUpAt: order.pickedUpAt ? new Date(order.pickedUpAt) : undefined,
      deliveredAt: order.deliveredAt ? new Date(order.deliveredAt) : undefined,
      estimatedDeliveryTime: order.estimatedDeliveryTime
        ? new Date(order.estimatedDeliveryTime)
        : undefined
    };
  }

  private cloneBatch(batch: BatchAssignment): BatchAssignment {
    return {
      ...batch,
      orderIds: [...batch.orderIds],
      deliverySequence: [...batch.deliverySequence],
      createdAt: new Date(batch.createdAt),
      startedAt: batch.startedAt ? new Date(batch.startedAt) : undefined,
      completedAt: batch.completedAt ? new Date(batch.completedAt) : undefined
    };
  }

  private clonePayment(payment: PaymentTransaction): PaymentTransaction {
    return {
      ...payment,
      createdAt: new Date(payment.createdAt),
      processedAt: payment.processedAt ? new Date(payment.processedAt) : undefined
    };
  }

  private cloneAudit(entry: AuditLogEntry): AuditLogEntry {
    return {
      ...entry,
      timestamp: new Date(entry.timestamp),
      details: entry.details ? { ...entry.details } : undefined
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
