import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { IdempotencyRecord } from '../idempotency';
import { AuditLogEntry, BatchAssignment, Driver, Order, PaymentTransaction } from '../types/order';
import { StateSnapshot, Store } from './Store';

const DATE_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'assignedAt',
  'pickedUpAt',
  'deliveredAt',
  'estimatedDeliveryTime',
  'lastLocationUpdate',
  'startedAt',
  'completedAt',
  'processedAt',
  'timestamp'
]);

function parseJson<T>(json: string): T {
  return JSON.parse(json, (key, value) => {
    if (DATE_KEYS.has(key) && typeof value === 'string') {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date;
    }
    return value;
  }) as T;
}

export class SqliteStore implements Store {
  private readonly database: import('node:sqlite').DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drivers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audits (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
  }

  saveOrder(order: Order): void {
    this.upsert('orders', order.id, order);
  }

  saveDriver(driver: Driver): void {
    this.upsert('drivers', driver.id, driver);
  }

  saveBatch(batch: BatchAssignment): void {
    this.upsert('batches', batch.id, batch);
  }

  savePayment(payment: PaymentTransaction): void {
    this.upsert('payments', payment.id, payment);
  }

  saveAudit(entry: AuditLogEntry): void {
    this.upsert('audits', entry.id, entry);
  }

  load(): StateSnapshot {
    return {
      orders: this.readAll<Order>('orders'),
      drivers: this.readAll<Driver>('drivers'),
      batches: this.readAll<BatchAssignment>('batches'),
      payments: this.readAll<PaymentTransaction>('payments'),
      audits: this.readAll<AuditLogEntry>('audits')
    };
  }

  getIdempotency(key: string): IdempotencyRecord | undefined {
    const row = this.database
      .prepare('SELECT data FROM idempotency WHERE key = ?')
      .get(key) as { data: string } | undefined;
    return row ? parseJson<IdempotencyRecord>(row.data) : undefined;
  }

  saveIdempotency(record: IdempotencyRecord): void {
    this.database
      .prepare(
        `INSERT INTO idempotency (key, data) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET data = excluded.data`
      )
      .run(record.key, JSON.stringify(record));
  }

  ping(): boolean {
    try {
      this.database.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.database.close();
  }

  private upsert(
    table: 'orders' | 'drivers' | 'batches' | 'payments' | 'audits',
    id: string,
    value: unknown
  ): void {
    this.database
      .prepare(
        `INSERT INTO ${table} (id, data) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`
      )
      .run(id, JSON.stringify(value));
  }

  private readAll<T>(table: 'orders' | 'drivers' | 'batches' | 'payments' | 'audits'): T[] {
    const rows = this.database.prepare(`SELECT data FROM ${table}`).all() as Array<{ data: string }>;
    return rows.map((row) => parseJson<T>(row.data));
  }
}
