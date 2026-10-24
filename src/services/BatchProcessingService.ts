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
import {
  cloneBatch,
  cloneDriver,
  cloneEarning,
  cloneOrder,
  clonePayment,
  clonePayout
} from '../store/clone';
import {
  AuditLogEntry,
  BatchAssignment,
  Driver,
  DriverEarning,
  DriverEarningsSummary,
  DriverStatus,
  Order,
  OrderStatus,
  PaymentStatus,
  PaymentTransaction,
  Payout,
  SystemMetrics
} from '../types/order';
import { KpiRange, KpiReport } from '../types/kpi';
import { DistanceCalculator } from '../utils/DistanceCalculator';

export const DISPATCH_DRIVER_ID = '1388246780';
export const DEFAULT_CURRENCY = 'THB';

export interface BatchProcessingOptions {
  dispatchDriverIds?: string[];
  /** Percentage of the delivery fee paid to the driver. */
  driverSharePercent?: number;
}

export interface DriverPatch {
  currentLatitude?: number;
  currentLongitude?: number;
  status?: DriverStatus;
  isAvailable?: boolean;
  acceptsNewOrders?: boolean;
  maxOrdersPerBatch?: number;
  rating?: number;
}

export interface CreatePayoutInput {
  driverId: string;
  method?: string;
  reference?: string;
  note?: string;
}

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.FAILED
]);

const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.PENDING]: [OrderStatus.READY, OrderStatus.CANCELLED, OrderStatus.FAILED],
  [OrderStatus.READY]: [OrderStatus.CANCELLED, OrderStatus.FAILED],
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
  earning?: DriverEarning;
  completedBatches: BatchAssignment[];
}

export class BatchProcessingService extends EventEmitter {
  private readonly batchSize: number;
  private readonly store: DispatchStore;
  private readonly dispatchDriverIds: Set<string>;
  private readonly driverSharePercent: number;
  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    batchSize: number = 4,
    store: DispatchStore = new MemoryDispatchStore(),
    options: BatchProcessingOptions = {}
  ) {
    super();
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
      throw new ValidationError('Batch size must be an integer between 1 and 50');
    }
    const share = options.driverSharePercent ?? 80;
    if (!Number.isFinite(share) || share < 0 || share > 100) {
      throw new ValidationError('Driver share percent must be between 0 and 100');
    }
    this.batchSize = batchSize;
    this.store = store;
    this.driverSharePercent = share;
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
      status: enqueue ? OrderStatus.READY : OrderStatus.PENDING,
      readyAt: enqueue ? now : undefined,
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
      if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.READY) {
        throw new ConflictError(`Order ${orderId} is ${order.status} and cannot be queued`);
      }
      if (order.queuedAt) return { changed: false, order };
      const now = new Date();
      const updated = cloneOrder({
        ...order,
        status: OrderStatus.READY,
        readyAt: order.readyAt ?? now,
        queuedAt: now,
        updatedAt: now
      });
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
        const queuedOrders = await tx.lockQueuedOrders(
          Math.max(this.batchSize * 25, 100)
        );
        if (queuedOrders.length === 0) return null;

        const drivers = (await tx.lockAvailableDrivers([...this.dispatchDriverIds])).filter(
          (candidate) => candidate.acceptsNewOrders !== false
        );
        if (drivers.length === 0) return null;

        const planned = this.planBatch(drivers, queuedOrders);
        if (!planned) return null;
        const { driver, orders: batchOrders } = planned;

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
        readyAt:
          nextStatus === OrderStatus.READY ? current.readyAt ?? now : current.readyAt,
        queuedAt:
          nextStatus === OrderStatus.READY ? current.queuedAt ?? now : undefined,
        pickedUpAt:
          nextStatus === OrderStatus.PICKED_UP ? now : current.pickedUpAt,
        deliveredAt:
          nextStatus === OrderStatus.DELIVERED ? now : current.deliveredAt
      });

      await tx.updateOrder(order);

      let driver: Driver | undefined;
      let earning: DriverEarning | undefined;
      const completedBatches: BatchAssignment[] = [];

      if (nextStatus === OrderStatus.DELIVERED && order.assignedDriverId) {
        const existing = await tx.getEarningByOrder(order.id, true);
        if (!existing) {
          earning = {
            id: `earn_${uuidv4()}`,
            driverId: order.assignedDriverId,
            orderId: order.id,
            amount: roundMoney((order.deliveryFee * this.driverSharePercent) / 100),
            currency: DEFAULT_CURRENCY,
            status: 'PENDING',
            createdAt: now
          };
          await tx.insertEarning(earning);
        } else {
          earning = existing;
        }
      }

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

      return { order, previousStatus, driver, earning, completedBatches };
    });

    if (plan.previousStatus !== plan.order.status) {
      this.emit('order:status', {
        previousStatus: plan.previousStatus,
        order: cloneOrder(plan.order)
      });
    }
    if (plan.driver) this.emit('driver:updated', cloneDriver(plan.driver));
    if (plan.earning) this.emit('earning:created', cloneEarning(plan.earning));
    for (const batch of plan.completedBatches) {
      this.emit('batch:completed', cloneBatch(batch));
    }

    return cloneOrder(plan.order);
  }

  async declineOrder(
    orderId: string,
    driverId?: string
  ): Promise<{ order: Order; driver?: Driver }> {
    const now = new Date();
    const result = await this.store.transaction(async (tx) => {
      const order = await tx.getOrder(orderId, true);
      if (!order) throw new NotFoundError(`Order ${orderId} was not found`);
      if (order.status !== OrderStatus.ASSIGNED) {
        throw new ConflictError(
          `Order ${orderId} is ${order.status} and can no longer be declined`
        );
      }
      if (driverId !== undefined && order.assignedDriverId !== driverId) {
        throw new ConflictError(`Order ${orderId} is not assigned to driver ${driverId}`);
      }
      const assignedDriverId = order.assignedDriverId;
      if (!assignedDriverId) {
        throw new ConflictError(`Order ${orderId} has no assigned driver`);
      }

      const updatedOrder = cloneOrder({
        ...order,
        status: OrderStatus.READY,
        readyAt: order.readyAt ?? now,
        queuedAt: now,
        assignedDriverId: undefined,
        assignedAt: undefined,
        estimatedDeliveryTime: undefined,
        declinedDriverIds: [
          ...new Set([...(order.declinedDriverIds ?? []), assignedDriverId])
        ],
        updatedAt: now
      });
      await tx.updateOrder(updatedOrder);

      const storedDriver = await tx.getDriver(assignedDriverId, true);
      let updatedDriver: Driver | undefined;
      if (storedDriver) {
        updatedDriver = cloneDriver({
          ...storedDriver,
          assignedOrders: storedDriver.assignedOrders.filter(
            (candidate) => candidate !== order.id
          ),
          lastLocationUpdate: now
        });
        const activeOrders = await tx.getOrdersByIds(updatedDriver.assignedOrders);
        const hasActiveOrders = activeOrders.some(
          (candidate) => !TERMINAL_STATUSES.has(candidate.status)
        );
        if (!hasActiveOrders) {
          updatedDriver.status = DriverStatus.AVAILABLE;
          updatedDriver.isAvailable = true;
        }
        await tx.updateDriver(updatedDriver);
      }

      for (const batch of await tx.listBatchesForOrder(order.id, true)) {
        if (batch.completedAt) continue;
        const orderIds = batch.orderIds.filter((candidate) => candidate !== order.id);
        await tx.updateBatch(
          cloneBatch({
            ...batch,
            orderIds,
            deliverySequence: batch.deliverySequence.filter(
              (candidate) => candidate !== order.id
            ),
            totalRevenue: roundMoney(
              Math.max(0, batch.totalRevenue - order.totalAmount)
            ),
            completedAt: orderIds.length === 0 ? now : batch.completedAt
          })
        );
      }

      return { order: updatedOrder, driver: updatedDriver };
    });

    this.emit('order:status', {
      previousStatus: OrderStatus.ASSIGNED,
      order: cloneOrder(result.order)
    });
    if (result.driver) this.emit('driver:updated', cloneDriver(result.driver));
    return { order: cloneOrder(result.order), driver: result.driver ? cloneDriver(result.driver) : undefined };
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

  async getEarningsForDriver(driverId: string): Promise<DriverEarning[]> {
    return this.store.getEarningsForDriver(driverId);
  }

  async getDriverEarnings(driverId: string): Promise<DriverEarningsSummary> {
    const driver = await this.store.getDriver(driverId);
    if (!driver) throw new NotFoundError(`Driver ${driverId} was not found`);
    const [earnings, payouts] = await Promise.all([
      this.store.getEarningsForDriver(driverId),
      this.store.getPayouts(driverId)
    ]);
    const pendingAmount = roundMoney(
      earnings
        .filter((earning) => earning.status === 'PENDING')
        .reduce((sum, earning) => sum + earning.amount, 0)
    );
    const paidAmount = roundMoney(
      earnings
        .filter((earning) => earning.status === 'PAID')
        .reduce((sum, earning) => sum + earning.amount, 0)
    );
    return {
      driverId,
      currency: DEFAULT_CURRENCY,
      pendingAmount,
      paidAmount,
      totalAmount: roundMoney(pendingAmount + paidAmount),
      earnings,
      payouts
    };
  }

  async getPayouts(driverId?: string): Promise<Payout[]> {
    return this.store.getPayouts(driverId);
  }

  async createPayout(input: CreatePayoutInput): Promise<Payout> {
    const now = new Date();
    const payout = await this.store.transaction(async (tx) => {
      const driver = await tx.getDriver(input.driverId, true);
      if (!driver) throw new NotFoundError(`Driver ${input.driverId} was not found`);
      const earnings = await tx.getPendingEarningsForDriver(input.driverId, true);
      if (earnings.length === 0) {
        throw new ConflictError(`Driver ${input.driverId} has no pending earnings`);
      }

      const record: Payout = {
        id: `payout_${uuidv4()}`,
        driverId: input.driverId,
        amount: roundMoney(earnings.reduce((sum, earning) => sum + earning.amount, 0)),
        currency: DEFAULT_CURRENCY,
        status: 'PAID',
        method: input.method ?? 'transfer',
        reference: input.reference,
        note: input.note,
        earningIds: earnings.map((earning) => earning.id),
        createdAt: now,
        paidAt: now
      };

      for (const earning of earnings) {
        await tx.updateEarning({
          ...earning,
          status: 'PAID',
          paidAt: now,
          payoutId: record.id
        });
      }
      await tx.insertPayout(record);
      return record;
    });

    this.emit('payout:created', clonePayout(payout));
    return clonePayout(payout);
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

  async getKpiReport(range: KpiRange): Promise<KpiReport> {
    return this.store.getKpiReport(range);
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
      if (hasActiveOrders && patch.status !== undefined) {
        throw new ConflictError(
          `Driver ${driverId} has active orders; status can only change after they finish`
        );
      }
      if (hasActiveOrders && patch.isAvailable === true) {
        throw new ConflictError(
          `Driver ${driverId} has active orders; availability is restored automatically after delivery`
        );
      }
      if (patch.status === DriverStatus.BUSY) {
        throw new ValidationError('status BUSY is managed by the dispatcher');
      }
      const effectiveStatus = patch.status ?? current.status;
      if (patch.isAvailable === true && effectiveStatus !== DriverStatus.AVAILABLE) {
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
      if (patch.acceptsNewOrders !== undefined) {
        driver.acceptsNewOrders = patch.acceptsNewOrders;
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
      (driver) =>
        driver.isAvailable &&
        driver.status === DriverStatus.AVAILABLE &&
        driver.acceptsNewOrders !== false
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

  private planBatch(
    drivers: Driver[],
    queuedOrders: Order[]
  ): { driver: Driver; orders: Order[] } | undefined {
    let bestDriver: Driver | undefined;
    let bestOrders: Order[] = [];
    let bestDistance = Infinity;

    for (const driver of drivers) {
      const capacity = Math.min(
        this.batchSize,
        driver.maxOrdersPerBatch - driver.assignedOrders.length
      );
      if (capacity < 1) continue;

      const orders = queuedOrders
        .filter((order) => !(order.declinedDriverIds ?? []).includes(driver.id))
        .map((order) => ({
          order,
          distance: DistanceCalculator.calculate(
            driver.currentLatitude,
            driver.currentLongitude,
            order.customer.latitude,
            order.customer.longitude
          )
        }))
        .sort((left, right) => left.distance - right.distance)
        .slice(0, capacity)
        .map((entry) => entry.order);
      const firstOrder = orders[0];
      if (!firstOrder) continue;

      const distance = DistanceCalculator.calculate(
        driver.currentLatitude,
        driver.currentLongitude,
        firstOrder.customer.latitude,
        firstOrder.customer.longitude
      );
      if (
        orders.length > bestOrders.length ||
        (orders.length === bestOrders.length && distance < bestDistance)
      ) {
        bestDriver = driver;
        bestOrders = orders;
        bestDistance = distance;
      }
    }

    return bestDriver ? { driver: bestDriver, orders: bestOrders } : undefined;
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

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
