import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../errors';
import type { IdempotencyClaim, IdempotencyRecord, IdempotencyStore } from '../idempotency';
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
import {
  cloneAudit,
  cloneBatch,
  cloneDriver,
  cloneOrder,
  clonePayment
} from './clone';

export type StorageKind = 'memory' | 'postgres' | 'pglite';

export interface OrderPage {
  orders: Order[];
  total: number;
}

export interface OrderPageOptions {
  status?: OrderStatus;
  limit: number;
  offset: number;
}

export interface DispatchTransaction {
  getOrder(orderId: string, lock?: boolean): Promise<Order | undefined>;
  getOrdersByIds(orderIds: string[], lock?: boolean): Promise<Order[]>;
  lockQueuedOrders(limit: number): Promise<Order[]>;
  insertOrder(order: Order): Promise<void>;
  updateOrder(order: Order): Promise<void>;

  getDriver(driverId: string, lock?: boolean): Promise<Driver | undefined>;
  lockAvailableDrivers(driverIds: string[]): Promise<Driver[]>;
  insertDriver(driver: Driver): Promise<void>;
  updateDriver(driver: Driver): Promise<void>;

  getBatch(batchId: string, lock?: boolean): Promise<BatchAssignment | undefined>;
  listBatchesForOrder(orderId: string, lock?: boolean): Promise<BatchAssignment[]>;
  insertBatch(batch: BatchAssignment): Promise<void>;
  updateBatch(batch: BatchAssignment): Promise<void>;

  insertPayment(payment: PaymentTransaction): Promise<void>;
  insertAudit(entry: AuditLogEntry): Promise<void>;
}

export interface DispatchStore extends IdempotencyStore {
  readonly kind: StorageKind;
  initialize(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
  transaction<T>(fn: (tx: DispatchTransaction) => Promise<T>): Promise<T>;

  getOrder(orderId: string): Promise<Order | undefined>;
  getOrders(): Promise<Order[]>;
  getOrdersPage(options: OrderPageOptions): Promise<OrderPage>;
  getPendingOrders(): Promise<Order[]>;
  getQueueSize(): Promise<number>;
  getDriver(driverId: string): Promise<Driver | undefined>;
  getDrivers(): Promise<Driver[]>;
  getBatches(): Promise<BatchAssignment[]>;
  getPayments(orderId: string): Promise<PaymentTransaction[]>;
  getPayment(paymentId: string): Promise<PaymentTransaction | undefined>;
  findPaymentByProviderTransactionId(
    providerTransactionId: string
  ): Promise<PaymentTransaction | undefined>;
  getAuditLog(
    limit: number,
    offset: number
  ): Promise<{ entries: AuditLogEntry[]; total: number }>;
  getMetrics(): Promise<SystemMetrics>;
}

const TERMINAL = new Set<OrderStatus>([
  OrderStatus.DELIVERED,
  OrderStatus.CANCELLED,
  OrderStatus.FAILED
]);

interface MemorySnapshot {
  orders: Map<string, Order>;
  drivers: Map<string, Driver>;
  batches: Map<string, BatchAssignment>;
  payments: Map<string, PaymentTransaction>;
  audits: AuditLogEntry[];
  idempotency: Map<string, IdempotencyRecord>;
}

export class MemoryDispatchStore implements DispatchStore {
  readonly kind = 'memory' as const;
  private orders = new Map<string, Order>();
  private drivers = new Map<string, Driver>();
  private batches = new Map<string, BatchAssignment>();
  private payments = new Map<string, PaymentTransaction>();
  private audits: AuditLogEntry[] = [];
  private idempotency = new Map<string, IdempotencyRecord>();
  private tail: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {}

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.orders.clear();
    this.drivers.clear();
    this.batches.clear();
    this.payments.clear();
    this.audits = [];
    this.idempotency.clear();
  }

  async transaction<T>(fn: (tx: DispatchTransaction) => Promise<T>): Promise<T> {
    const release = await this.acquire();
    const snapshot = this.snapshot();
    try {
      return await fn(new MemoryDispatchTransaction(this));
    } catch (error) {
      this.restore(snapshot);
      throw error;
    } finally {
      release();
    }
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    await this.tail;
    return this.readOrder(orderId);
  }

  async getOrders(): Promise<Order[]> {
    await this.tail;
    return [...this.orders.values()].map(cloneOrder);
  }

  async getOrdersPage(options: OrderPageOptions): Promise<OrderPage> {
    await this.tail;
    const matching = [...this.orders.values()]
      .filter((order) => options.status === undefined || order.status === options.status)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime()
          || left.id.localeCompare(right.id)
      );
    return {
      orders: matching.slice(options.offset, options.offset + options.limit).map(cloneOrder),
      total: matching.length
    };
  }

  async getPendingOrders(): Promise<Order[]> {
    await this.tail;
    return this.queuedOrders().map(cloneOrder);
  }

  async getQueueSize(): Promise<number> {
    await this.tail;
    return this.queuedOrders().length;
  }

  async getDriver(driverId: string): Promise<Driver | undefined> {
    await this.tail;
    return this.readDriver(driverId);
  }

  async getDrivers(): Promise<Driver[]> {
    await this.tail;
    return [...this.drivers.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneDriver);
  }

  async getBatches(): Promise<BatchAssignment[]> {
    await this.tail;
    return [...this.batches.values()]
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime()
          || left.id.localeCompare(right.id)
      )
      .map(cloneBatch);
  }

  async getPayments(orderId: string): Promise<PaymentTransaction[]> {
    await this.tail;
    return [...this.payments.values()]
      .filter((payment) => payment.orderId === orderId)
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime()
          || left.id.localeCompare(right.id)
      )
      .map(clonePayment);
  }

  async getPayment(paymentId: string): Promise<PaymentTransaction | undefined> {
    await this.tail;
    const payment = this.payments.get(paymentId);
    return payment ? clonePayment(payment) : undefined;
  }

  async findPaymentByProviderTransactionId(
    providerTransactionId: string
  ): Promise<PaymentTransaction | undefined> {
    await this.tail;
    for (const payment of this.payments.values()) {
      if (payment.providerTransactionId === providerTransactionId) {
        return clonePayment(payment);
      }
    }
    return undefined;
  }

  async getAuditLog(
    limit: number,
    offset: number
  ): Promise<{ entries: AuditLogEntry[]; total: number }> {
    await this.tail;
    const sorted = [...this.audits].sort(
      (left, right) =>
        right.timestamp.getTime() - left.timestamp.getTime()
        || left.id.localeCompare(right.id)
    );
    return {
      entries: sorted.slice(offset, offset + limit).map(cloneAudit),
      total: sorted.length
    };
  }

  async getMetrics(): Promise<SystemMetrics> {
    await this.tail;
    const orders = [...this.orders.values()];
    const assignedOrders = orders.filter((order) => order.assignedAt !== undefined);
    const deliveredOrders = orders.filter((order) => order.status === OrderStatus.DELIVERED);
    const failedOrders = orders.filter(
      (order) => order.status === OrderStatus.FAILED || order.status === OrderStatus.CANCELLED
    );
    const terminalCount = deliveredOrders.length + failedOrders.length;
    const average = (values: number[]): number =>
      values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

    return {
      totalOrdersProcessed: assignedOrders.length,
      totalBatchesCreated: this.batches.size,
      averageProcessingTime: average(
        assignedOrders.map((order) => order.assignedAt!.getTime() - order.createdAt.getTime())
      ),
      averageDeliveryTime: average(
        deliveredOrders
          .filter((order) => order.deliveredAt !== undefined && order.assignedAt !== undefined)
          .map((order) => order.deliveredAt!.getTime() - order.assignedAt!.getTime())
      ),
      successRate: terminalCount === 0 ? 0 : deliveredOrders.length / terminalCount,
      totalRevenue: deliveredOrders
        .filter((order) => order.paymentStatus !== PaymentStatus.REFUNDED)
        .reduce((sum, order) => sum + order.totalAmount, 0),
      activeDrivers: [...this.drivers.values()].filter(
        (driver) => driver.isAvailable && driver.status === DriverStatus.AVAILABLE
      ).length,
      pendingOrders: this.queuedOrders().length,
      timestamp: new Date()
    };
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | undefined> {
    await this.tail;
    const record = this.idempotency.get(key);
    return record ? { ...record } : undefined;
  }

  async claimIdempotency(
    key: string,
    fingerprint: string,
    now: number,
    expiresAt: number
  ): Promise<IdempotencyClaim> {
    const release = await this.acquire();
    try {
      const existing = this.idempotency.get(key);
      const staleBefore = now - 60_000;
      if (
        !existing ||
        existing.expiresAt <= now ||
        (existing.status === 0 && existing.createdAt <= staleBefore)
      ) {
        const record: IdempotencyRecord = {
          key,
          fingerprint,
          status: 0,
          body: null,
          createdAt: now,
          expiresAt,
          claimToken: randomUUID()
        };
        this.idempotency.set(key, record);
        return { record: { ...record }, claimed: true };
      }
      return { record: { ...existing }, claimed: false };
    } finally {
      release();
    }
  }

  async completeIdempotency(record: IdempotencyRecord): Promise<void> {
    const release = await this.acquire();
    try {
      const existing = this.idempotency.get(record.key);
      if (!existing || existing.status !== 0) return;
      if (
        existing.claimToken !== undefined &&
        existing.claimToken !== record.claimToken
      ) {
        return;
      }
      this.idempotency.set(record.key, { ...record, body: record.body });
    } finally {
      release();
    }
  }

  async releaseIdempotency(key: string, claimToken?: string): Promise<void> {
    const release = await this.acquire();
    try {
      const existing = this.idempotency.get(key);
      if (
        existing?.status === 0 &&
        (claimToken === undefined || existing.claimToken === claimToken)
      ) {
        this.idempotency.delete(key);
      }
    } finally {
      release();
    }
  }

  readOrder(orderId: string): Order | undefined {
    const order = this.orders.get(orderId);
    return order ? cloneOrder(order) : undefined;
  }

  readDriver(driverId: string): Driver | undefined {
    const driver = this.drivers.get(driverId);
    return driver ? cloneDriver(driver) : undefined;
  }

  listOrders(): Order[] {
    return [...this.orders.values()];
  }

  listDrivers(): Driver[] {
    return [...this.drivers.values()];
  }

  listBatches(): BatchAssignment[] {
    return [...this.batches.values()];
  }

  listPayments(): PaymentTransaction[] {
    return [...this.payments.values()];
  }

  queuedOrders(): Order[] {
    return [...this.orders.values()]
      .filter((order) => order.status === OrderStatus.PENDING && order.queuedAt !== undefined)
      .sort((left, right) => {
        const queueOrder = left.queuedAt!.getTime() - right.queuedAt!.getTime();
        if (queueOrder !== 0) return queueOrder;
        const createdOrder = left.createdAt.getTime() - right.createdAt.getTime();
        return createdOrder !== 0 ? createdOrder : left.id.localeCompare(right.id);
      });
  }

  writeOrder(order: Order): void {
    this.orders.set(order.id, cloneOrder(order));
  }

  writeDriver(driver: Driver): void {
    this.drivers.set(driver.id, cloneDriver(driver));
  }

  writeBatch(batch: BatchAssignment): void {
    this.batches.set(batch.id, cloneBatch(batch));
  }

  writePayment(payment: PaymentTransaction): void {
    this.payments.set(payment.id, clonePayment(payment));
  }

  writeAudit(entry: AuditLogEntry): void {
    this.audits.push(cloneAudit(entry));
  }

  auditEntries(): AuditLogEntry[] {
    return [...this.audits];
  }

  private async acquire(): Promise<() => void> {
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }

  private snapshot(): MemorySnapshot {
    return {
      orders: new Map([...this.orders].map(([id, order]) => [id, cloneOrder(order)])),
      drivers: new Map([...this.drivers].map(([id, driver]) => [id, cloneDriver(driver)])),
      batches: new Map([...this.batches].map(([id, batch]) => [id, cloneBatch(batch)])),
      payments: new Map([...this.payments].map(([id, payment]) => [id, clonePayment(payment)])),
      audits: this.audits.map(cloneAudit),
      idempotency: new Map([...this.idempotency].map(([key, record]) => [key, { ...record }]))
    };
  }

  private restore(snapshot: MemorySnapshot): void {
    this.orders = snapshot.orders;
    this.drivers = snapshot.drivers;
    this.batches = snapshot.batches;
    this.payments = snapshot.payments;
    this.audits = snapshot.audits;
    this.idempotency = snapshot.idempotency;
  }
}

class MemoryDispatchTransaction implements DispatchTransaction {
  constructor(private readonly store: MemoryDispatchStore) {}

  async getOrder(orderId: string, _lock = false): Promise<Order | undefined> {
    return this.store.readOrder(orderId);
  }

  async getOrdersByIds(orderIds: string[], _lock = false): Promise<Order[]> {
    return orderIds
      .map((orderId) => this.store.readOrder(orderId))
      .filter((order): order is Order => order !== undefined);
  }

  async lockQueuedOrders(limit: number): Promise<Order[]> {
    return this.store.queuedOrders().slice(0, limit).map(cloneOrder);
  }

  async insertOrder(order: Order): Promise<void> {
    if (this.store.readOrder(order.id)) {
      throw new ConflictError(`Order ${order.id} already exists`);
    }
    this.store.writeOrder(order);
  }

  async updateOrder(order: Order): Promise<void> {
    if (!this.store.readOrder(order.id)) {
      throw new NotFoundError(`Order ${order.id} was not found`);
    }
    this.store.writeOrder(order);
  }

  async getDriver(driverId: string, _lock = false): Promise<Driver | undefined> {
    return this.store.readDriver(driverId);
  }

  async lockAvailableDrivers(driverIds: string[]): Promise<Driver[]> {
    const allowed = new Set(driverIds);
    return this.store
      .listDrivers()
      .filter(
        (driver) =>
          allowed.has(driver.id) &&
          driver.isAvailable &&
          driver.status === DriverStatus.AVAILABLE
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneDriver);
  }

  async insertDriver(driver: Driver): Promise<void> {
    if (this.store.readDriver(driver.id)) {
      throw new ConflictError(`Driver ${driver.id} already exists`);
    }
    this.store.writeDriver(driver);
  }

  async updateDriver(driver: Driver): Promise<void> {
    if (!this.store.readDriver(driver.id)) {
      throw new NotFoundError(`Driver ${driver.id} was not found`);
    }
    this.store.writeDriver(driver);
  }

  async getBatch(batchId: string, _lock = false): Promise<BatchAssignment | undefined> {
    const batch = this.store.listBatches().find((candidate) => candidate.id === batchId);
    return batch ? cloneBatch(batch) : undefined;
  }

  async listBatchesForOrder(orderId: string, _lock = false): Promise<BatchAssignment[]> {
    return this.store
      .listBatches()
      .filter((batch) => batch.orderIds.includes(orderId))
      .map(cloneBatch);
  }

  async insertBatch(batch: BatchAssignment): Promise<void> {
    this.store.writeBatch(batch);
  }

  async updateBatch(batch: BatchAssignment): Promise<void> {
    this.store.writeBatch(batch);
  }

  async insertPayment(payment: PaymentTransaction): Promise<void> {
    this.store.writePayment(payment);
  }

  async insertAudit(entry: AuditLogEntry): Promise<void> {
    this.store.writeAudit(entry);
  }
}

export function isTerminalOrder(order: Order): boolean {
  return TERMINAL.has(order.status);
}
