import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../errors';
import type { IdempotencyClaim, IdempotencyRecord } from '../idempotency';
import {
  AuditLogEntry,
  BatchAssignment,
  Driver,
  DriverEarning,
  DriverStatus,
  Order,
  PaymentTransaction,
  Payout,
  PushSubscriptionRecord,
  SystemMetrics
} from '../types/order';
import type {
  DispatchStore,
  DispatchTransaction,
  OrderPage,
  OrderPageOptions,
  StorageKind
} from './DispatchStore';
import { applyMigrations } from './schema';
import { parseJson, stringifyJson } from './serialize';
import { SqlDatabase, SqlExecutor } from './sql';

function orderValues(order: Order): unknown[] {
  return [
    order.id,
    order.orderId,
    order.status,
    order.paymentStatus,
    order.queuedAt ?? null,
    order.createdAt,
    order.updatedAt,
    order.assignedDriverId ?? null,
    order.assignedAt ?? null,
    order.deliveredAt ?? null,
    order.totalAmount,
    stringifyJson(order)
  ];
}

function orderUpdateValues(order: Order): unknown[] {
  return [
    order.orderId,
    order.status,
    order.paymentStatus,
    order.queuedAt ?? null,
    order.updatedAt,
    order.assignedDriverId ?? null,
    order.assignedAt ?? null,
    order.deliveredAt ?? null,
    order.totalAmount,
    stringifyJson(order),
    order.id
  ];
}

function driverValues(driver: Driver): unknown[] {
  return [
    driver.id,
    driver.status,
    driver.isAvailable,
    driver.maxOrdersPerBatch,
    stringifyJson(driver)
  ];
}

function batchValues(batch: BatchAssignment): unknown[] {
  return [
    batch.id,
    batch.driverId,
    stringifyJson(batch.orderIds),
    batch.createdAt,
    batch.completedAt ?? null,
    stringifyJson(batch)
  ];
}

function paymentValues(payment: PaymentTransaction): unknown[] {
  return [
    payment.id,
    payment.orderId,
    payment.providerTransactionId ?? null,
    payment.createdAt,
    stringifyJson(payment)
  ];
}

function auditValues(entry: AuditLogEntry): unknown[] {
  return [entry.id, entry.timestamp, stringifyJson(entry)];
}

function earningValues(earning: DriverEarning): unknown[] {
  return [
    earning.id,
    earning.driverId,
    earning.orderId,
    earning.status,
    earning.amount,
    earning.createdAt,
    earning.paidAt ?? null,
    earning.payoutId ?? null,
    stringifyJson(earning)
  ];
}

function payoutValues(payout: Payout): unknown[] {
  return [
    payout.id,
    payout.driverId,
    payout.status,
    payout.amount,
    payout.createdAt,
    payout.paidAt,
    stringifyJson(payout)
  ];
}

export class PostgresDispatchStore implements DispatchStore {
  constructor(
    private readonly database: SqlDatabase,
    readonly kind: StorageKind = 'postgres'
  ) {}

  async initialize(): Promise<void> {
    await applyMigrations(this.database);
  }

  async ping(): Promise<boolean> {
    return this.database.ping();
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  async transaction<T>(fn: (tx: DispatchTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => fn(new PostgresDispatchTransaction(tx)));
  }

  async getOrder(orderId: string): Promise<Order | undefined> {
    const rows = await this.database.query('SELECT data FROM orders WHERE id = $1', [orderId]);
    return rows[0] ? parseJson<Order>(rows[0].data) : undefined;
  }

  async getOrders(): Promise<Order[]> {
    const rows = await this.database.query(
      'SELECT data FROM orders ORDER BY created_at ASC, id ASC'
    );
    return rows.map((row) => parseJson<Order>(row.data));
  }

  async getOrdersPage(options: OrderPageOptions): Promise<OrderPage> {
    const status = options.status ?? null;
    const [rows, totals] = await Promise.all([
      this.database.query(
        `SELECT data FROM orders
         WHERE ($1::text IS NULL OR status = $1)
         ORDER BY created_at ASC, id ASC
         LIMIT $2 OFFSET $3`,
        [status, options.limit, options.offset]
      ),
      this.database.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM orders WHERE ($1::text IS NULL OR status = $1)',
        [status]
      )
    ]);
    return {
      orders: rows.map((row) => parseJson<Order>(row.data)),
      total: Number(totals[0]?.total ?? 0)
    };
  }

  async getPendingOrders(): Promise<Order[]> {
    const rows = await this.database.query(
      `SELECT data FROM orders
       WHERE status = 'PENDING' AND queued_at IS NOT NULL
       ORDER BY queued_at ASC, created_at ASC, id ASC`
    );
    return rows.map((row) => parseJson<Order>(row.data));
  }

  async getQueueSize(): Promise<number> {
    const rows = await this.database.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM orders
       WHERE status = 'PENDING' AND queued_at IS NOT NULL`
    );
    return Number(rows[0]?.total ?? 0);
  }

  async getDriver(driverId: string): Promise<Driver | undefined> {
    const rows = await this.database.query('SELECT data FROM drivers WHERE id = $1', [driverId]);
    return rows[0] ? parseJson<Driver>(rows[0].data) : undefined;
  }

  async getDrivers(): Promise<Driver[]> {
    const rows = await this.database.query('SELECT data FROM drivers ORDER BY id ASC');
    return rows.map((row) => parseJson<Driver>(row.data));
  }

  async getBatches(): Promise<BatchAssignment[]> {
    const rows = await this.database.query(
      'SELECT data FROM batches ORDER BY created_at ASC, id ASC'
    );
    return rows.map((row) => parseJson<BatchAssignment>(row.data));
  }

  async getPayments(orderId: string): Promise<PaymentTransaction[]> {
    const rows = await this.database.query(
      'SELECT data FROM payments WHERE order_id = $1 ORDER BY created_at ASC, id ASC',
      [orderId]
    );
    return rows.map((row) => parseJson<PaymentTransaction>(row.data));
  }

  async getPayment(paymentId: string): Promise<PaymentTransaction | undefined> {
    const rows = await this.database.query('SELECT data FROM payments WHERE id = $1', [paymentId]);
    return rows[0] ? parseJson<PaymentTransaction>(rows[0].data) : undefined;
  }

  async findPaymentByProviderTransactionId(
    providerTransactionId: string
  ): Promise<PaymentTransaction | undefined> {
    const rows = await this.database.query(
      `SELECT data FROM payments
       WHERE provider_transaction_id = $1
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      [providerTransactionId]
    );
    return rows[0] ? parseJson<PaymentTransaction>(rows[0].data) : undefined;
  }

  async getEarningByOrder(orderId: string): Promise<DriverEarning | undefined> {
    const rows = await this.database.query(
      'SELECT data FROM driver_earnings WHERE order_id = $1',
      [orderId]
    );
    return rows[0] ? parseJson<DriverEarning>(rows[0].data) : undefined;
  }

  async getEarningsForDriver(driverId: string): Promise<DriverEarning[]> {
    const rows = await this.database.query(
      'SELECT data FROM driver_earnings WHERE driver_id = $1 ORDER BY created_at ASC, id ASC',
      [driverId]
    );
    return rows.map((row) => parseJson<DriverEarning>(row.data));
  }

  async getEarnings(): Promise<DriverEarning[]> {
    const rows = await this.database.query(
      'SELECT data FROM driver_earnings ORDER BY created_at ASC, id ASC'
    );
    return rows.map((row) => parseJson<DriverEarning>(row.data));
  }

  async getPayout(payoutId: string): Promise<Payout | undefined> {
    const rows = await this.database.query('SELECT data FROM payouts WHERE id = $1', [payoutId]);
    return rows[0] ? parseJson<Payout>(rows[0].data) : undefined;
  }

  async getPayouts(driverId?: string): Promise<Payout[]> {
    const rows = await this.database.query(
      `SELECT data FROM payouts
       WHERE ($1::text IS NULL OR driver_id = $1)
       ORDER BY created_at ASC, id ASC`,
      [driverId ?? null]
    );
    return rows.map((row) => parseJson<Payout>(row.data));
  }

  async savePushSubscription(subscription: PushSubscriptionRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO push_subscriptions (endpoint, driver_id, created_at, data)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (endpoint) DO UPDATE SET
         driver_id = excluded.driver_id,
         data = excluded.data`,
      [
        subscription.endpoint,
        subscription.driverId,
        subscription.createdAt,
        stringifyJson(subscription)
      ]
    );
  }

  async deletePushSubscription(endpoint: string): Promise<boolean> {
    const rows = await this.database.query(
      'DELETE FROM push_subscriptions WHERE endpoint = $1 RETURNING endpoint',
      [endpoint]
    );
    return rows.length > 0;
  }

  async getPushSubscriptions(driverId?: string): Promise<PushSubscriptionRecord[]> {
    const rows = await this.database.query(
      `SELECT data FROM push_subscriptions
       WHERE ($1::text IS NULL OR driver_id = $1)
       ORDER BY created_at ASC`,
      [driverId ?? null]
    );
    return rows.map((row) => parseJson<PushSubscriptionRecord>(row.data));
  }

  async getAuditLog(
    limit: number,
    offset: number
  ): Promise<{ entries: AuditLogEntry[]; total: number }> {
    const [rows, totals] = await Promise.all([
      this.database.query(
        'SELECT data FROM audits ORDER BY timestamp DESC, id ASC LIMIT $1 OFFSET $2',
        [limit, offset]
      ),
      this.database.query<{ total: number }>('SELECT count(*)::int AS total FROM audits')
    ]);
    return {
      entries: rows.map((row) => parseJson<AuditLogEntry>(row.data)),
      total: Number(totals[0]?.total ?? 0)
    };
  }

  async getMetrics(): Promise<SystemMetrics> {
    const rows = await this.database.query<Record<string, unknown>>(`
      SELECT
        (SELECT count(*)::int FROM orders WHERE assigned_at IS NOT NULL) AS total_orders_processed,
        (SELECT count(*)::int FROM batches) AS total_batches_created,
        COALESCE((
          SELECT avg(EXTRACT(EPOCH FROM (assigned_at - created_at)) * 1000)
          FROM orders WHERE assigned_at IS NOT NULL
        ), 0) AS average_processing_time,
        COALESCE((
          SELECT avg(EXTRACT(EPOCH FROM (delivered_at - assigned_at)) * 1000)
          FROM orders WHERE delivered_at IS NOT NULL AND assigned_at IS NOT NULL
        ), 0) AS average_delivery_time,
        COALESCE((
          SELECT count(*)::numeric FROM orders WHERE status = 'DELIVERED'
        ) / NULLIF((
          SELECT count(*)::numeric FROM orders
          WHERE status IN ('DELIVERED', 'CANCELLED', 'FAILED')
        ), 0), 0) AS success_rate,
        COALESCE((
          SELECT sum(total_amount) FROM orders
          WHERE status = 'DELIVERED' AND payment_status <> 'REFUNDED'
        ), 0) AS total_revenue,
        (SELECT count(*)::int FROM drivers WHERE status = 'AVAILABLE' AND is_available) AS active_drivers,
        (SELECT count(*)::int FROM orders WHERE status = 'PENDING' AND queued_at IS NOT NULL) AS pending_orders
    `);
    const row = rows[0] ?? {};
    return {
      totalOrdersProcessed: Number(row.total_orders_processed ?? 0),
      totalBatchesCreated: Number(row.total_batches_created ?? 0),
      averageProcessingTime: Number(row.average_processing_time ?? 0),
      averageDeliveryTime: Number(row.average_delivery_time ?? 0),
      successRate: Number(row.success_rate ?? 0),
      totalRevenue: Number(row.total_revenue ?? 0),
      activeDrivers: Number(row.active_drivers ?? 0),
      pendingOrders: Number(row.pending_orders ?? 0),
      timestamp: new Date()
    };
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | undefined> {
    const rows = await this.database.query(
      `SELECT key, fingerprint, status, body, created_at, expires_at, claim_token
       FROM idempotency WHERE key = $1`,
      [key]
    );
    return rows[0] ? idempotencyRecord(rows[0]) : undefined;
  }

  async claimIdempotency(
    key: string,
    fingerprint: string,
    now: number,
    expiresAt: number
  ): Promise<IdempotencyClaim> {
    const claimToken = randomUUID();
    return this.database.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO idempotency (key, fingerprint, claim_token, status, body, created_at, expires_at)
         VALUES ($1, $2, $5, 0, NULL, $3, $4)
         ON CONFLICT (key) DO NOTHING
         RETURNING key, fingerprint, status, body, created_at, expires_at, claim_token`,
        [key, fingerprint, now, expiresAt, claimToken]
      );
      if (inserted[0]) {
        return { record: idempotencyRecord(inserted[0]), claimed: true };
      }

      const existing = await tx.query(
        `SELECT key, fingerprint, status, body, created_at, expires_at, claim_token
         FROM idempotency WHERE key = $1`,
        [key]
      );
      const record = existing[0] ? idempotencyRecord(existing[0]) : undefined;
      if (!record) {
        return {
          record: {
            key,
            fingerprint,
            status: 0,
            body: null,
            createdAt: now,
            expiresAt,
            claimToken
          },
          claimed: false
        };
      }
      const stale = record.status === 0 && record.createdAt <= now - 60_000;
      if (record.expiresAt > now && !stale) {
        return { record, claimed: false };
      }

      const claimed = await tx.query(
        `UPDATE idempotency
         SET fingerprint = $2, claim_token = $6, status = 0, body = NULL,
             created_at = $3, expires_at = $4
         WHERE key = $1
           AND (expires_at <= $3 OR (status = 0 AND created_at <= $5))
         RETURNING key, fingerprint, status, body, created_at, expires_at, claim_token`,
        [key, fingerprint, now, expiresAt, now - 60_000, claimToken]
      );
      return claimed[0]
        ? { record: idempotencyRecord(claimed[0]), claimed: true }
        : { record, claimed: false };
    });
  }

  async completeIdempotency(record: IdempotencyRecord): Promise<void> {
    await this.database.query(
      `UPDATE idempotency
       SET fingerprint = $2, status = $3, body = $4::jsonb, created_at = $5, expires_at = $6
       WHERE key = $1 AND status = 0 AND claim_token = $7`,
      [
        record.key,
        record.fingerprint,
        record.status,
        stringifyJson(record.body ?? null),
        record.createdAt,
        record.expiresAt,
        record.claimToken
      ]
    );
  }

  async releaseIdempotency(key: string, claimToken?: string): Promise<void> {
    if (claimToken === undefined) {
      await this.database.query('DELETE FROM idempotency WHERE key = $1 AND status = 0', [key]);
      return;
    }
    await this.database.query(
      'DELETE FROM idempotency WHERE key = $1 AND status = 0 AND claim_token = $2',
      [key, claimToken]
    );
  }
}

class PostgresDispatchTransaction implements DispatchTransaction {
  constructor(private readonly tx: SqlExecutor) {}

  async getOrder(orderId: string, lock = false): Promise<Order | undefined> {
    const rows = await this.tx.query(
      `SELECT data FROM orders WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [orderId]
    );
    return rows[0] ? parseJson<Order>(rows[0].data) : undefined;
  }

  async getOrdersByIds(orderIds: string[], lock = false): Promise<Order[]> {
    if (orderIds.length === 0) return [];
    const rows = await this.tx.query(
      `SELECT data FROM orders WHERE id = ANY($1::text[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`,
      [orderIds]
    );
    return rows.map((row) => parseJson<Order>(row.data));
  }

  async lockQueuedOrders(limit: number): Promise<Order[]> {
    const rows = await this.tx.query(
      `SELECT data FROM orders
       WHERE status = 'PENDING' AND queued_at IS NOT NULL
       ORDER BY queued_at ASC, created_at ASC, id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    return rows.map((row) => parseJson<Order>(row.data));
  }

  async insertOrder(order: Order): Promise<void> {
    const rows = await this.tx.query(
      `INSERT INTO orders (
         id, order_id, status, payment_status, queued_at, created_at, updated_at,
         assigned_driver_id, assigned_at, delivered_at, total_amount, data
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      orderValues(order)
    );
    if (!rows[0]) throw new ConflictError(`Order ${order.id} already exists`);
  }

  async updateOrder(order: Order): Promise<void> {
    const rows = await this.tx.query(
      `UPDATE orders SET
         order_id = $1, status = $2, payment_status = $3, queued_at = $4, updated_at = $5,
         assigned_driver_id = $6, assigned_at = $7, delivered_at = $8, total_amount = $9,
         data = $10::jsonb
       WHERE id = $11
       RETURNING id`,
      orderUpdateValues(order)
    );
    if (!rows[0]) throw new NotFoundError(`Order ${order.id} was not found`);
  }

  async getDriver(driverId: string, lock = false): Promise<Driver | undefined> {
    const rows = await this.tx.query(
      `SELECT data FROM drivers WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [driverId]
    );
    return rows[0] ? parseJson<Driver>(rows[0].data) : undefined;
  }

  async lockAvailableDrivers(driverIds: string[]): Promise<Driver[]> {
    if (driverIds.length === 0) return [];
    const rows = await this.tx.query(
      `SELECT data FROM drivers
       WHERE id = ANY($1::text[])
         AND status = $2
         AND is_available = true
       ORDER BY id
       FOR UPDATE SKIP LOCKED`,
      [driverIds, DriverStatus.AVAILABLE]
    );
    return rows.map((row) => parseJson<Driver>(row.data));
  }

  async insertDriver(driver: Driver): Promise<void> {
    const rows = await this.tx.query(
      `INSERT INTO drivers (id, status, is_available, max_orders_per_batch, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      driverValues(driver)
    );
    if (!rows[0]) throw new ConflictError(`Driver ${driver.id} already exists`);
  }

  async updateDriver(driver: Driver): Promise<void> {
    const rows = await this.tx.query(
      `UPDATE drivers SET status = $2, is_available = $3, max_orders_per_batch = $4, data = $5::jsonb
       WHERE id = $1
       RETURNING id`,
      [driver.id, driver.status, driver.isAvailable, driver.maxOrdersPerBatch, stringifyJson(driver)]
    );
    if (!rows[0]) throw new NotFoundError(`Driver ${driver.id} was not found`);
  }

  async getBatch(batchId: string, lock = false): Promise<BatchAssignment | undefined> {
    const rows = await this.tx.query(
      `SELECT data FROM batches WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [batchId]
    );
    return rows[0] ? parseJson<BatchAssignment>(rows[0].data) : undefined;
  }

  async listBatchesForOrder(orderId: string, lock = false): Promise<BatchAssignment[]> {
    const rows = await this.tx.query(
      `SELECT b.data FROM batches b
       JOIN batch_orders bo ON bo.batch_id = b.id
       WHERE bo.order_id = $1
       ORDER BY b.created_at ASC, b.id ASC
       ${lock ? 'FOR UPDATE OF b' : ''}`,
      [orderId]
    );
    return rows.map((row) => parseJson<BatchAssignment>(row.data));
  }

  async insertBatch(batch: BatchAssignment): Promise<void> {
    await this.tx.query(
      `INSERT INTO batches (id, driver_id, order_ids, created_at, completed_at, data)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb)`,
      batchValues(batch)
    );
    for (const [position, orderId] of batch.orderIds.entries()) {
      await this.tx.query(
        'INSERT INTO batch_orders (batch_id, order_id, position) VALUES ($1, $2, $3)',
        [batch.id, orderId, position]
      );
    }
  }

  async updateBatch(batch: BatchAssignment): Promise<void> {
    await this.tx.query(
      `UPDATE batches SET order_ids = $2::jsonb, completed_at = $3, data = $4::jsonb
       WHERE id = $1`,
      [batch.id, stringifyJson(batch.orderIds), batch.completedAt ?? null, stringifyJson(batch)]
    );
  }

  async insertPayment(payment: PaymentTransaction): Promise<void> {
    await this.tx.query(
      `INSERT INTO payments (id, order_id, provider_transaction_id, created_at, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         order_id = excluded.order_id,
         provider_transaction_id = excluded.provider_transaction_id,
         created_at = excluded.created_at,
         data = excluded.data`,
      paymentValues(payment)
    );
  }

  async insertAudit(entry: AuditLogEntry): Promise<void> {
    await this.tx.query(
      `INSERT INTO audits (id, timestamp, data)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET timestamp = excluded.timestamp, data = excluded.data`,
      auditValues(entry)
    );
  }

  async getEarningByOrder(
    orderId: string,
    lock = false
  ): Promise<DriverEarning | undefined> {
    const rows = await this.tx.query(
      `SELECT data FROM driver_earnings WHERE order_id = $1${lock ? ' FOR UPDATE' : ''}`,
      [orderId]
    );
    return rows[0] ? parseJson<DriverEarning>(rows[0].data) : undefined;
  }

  async getPendingEarningsForDriver(
    driverId: string,
    lock = false
  ): Promise<DriverEarning[]> {
    const rows = await this.tx.query(
      `SELECT data FROM driver_earnings
       WHERE driver_id = $1 AND status = 'PENDING'
       ORDER BY created_at ASC, id ASC
       ${lock ? 'FOR UPDATE' : ''}`,
      [driverId]
    );
    return rows.map((row) => parseJson<DriverEarning>(row.data));
  }

  async insertEarning(earning: DriverEarning): Promise<void> {
    await this.tx.query(
      `INSERT INTO driver_earnings (
         id, driver_id, order_id, status, amount, paid_at, payout_id, created_at, data
       ) VALUES ($1, $2, $3, $4, $5, $7, $8, $6, $9::jsonb)
       ON CONFLICT (order_id) DO NOTHING`,
      earningValues(earning)
    );
  }

  async updateEarning(earning: DriverEarning): Promise<void> {
    await this.tx.query(
      `UPDATE driver_earnings
       SET id = $1, driver_id = $2, status = $4, amount = $5, created_at = $6,
           paid_at = $7, payout_id = $8, data = $9::jsonb
       WHERE order_id = $3`,
      earningValues(earning)
    );
  }

  async insertPayout(payout: Payout): Promise<void> {
    const rows = await this.tx.query(
      `INSERT INTO payouts (id, driver_id, status, amount, created_at, paid_at, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      payoutValues(payout)
    );
    if (!rows[0]) throw new ConflictError(`Payout ${payout.id} already exists`);
  }
}

function idempotencyRecord(row: Record<string, unknown>): IdempotencyRecord {
  return {
    key: String(row.key),
    fingerprint: String(row.fingerprint),
    status: Number(row.status),
    body: row.body,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    claimToken: row.claim_token === null ? undefined : String(row.claim_token)
  };
}
