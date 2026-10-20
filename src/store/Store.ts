import { IdempotencyRecord } from '../idempotency';
import { AuditLogEntry, BatchAssignment, Driver, Order, PaymentTransaction } from '../types/order';

export interface StateSnapshot {
  orders: Order[];
  drivers: Driver[];
  batches: BatchAssignment[];
  payments: PaymentTransaction[];
  audits: AuditLogEntry[];
}

export interface Store {
  saveOrder(order: Order): void;
  saveDriver(driver: Driver): void;
  saveBatch(batch: BatchAssignment): void;
  savePayment(payment: PaymentTransaction): void;
  saveAudit(entry: AuditLogEntry): void;
  load(): StateSnapshot;
  getIdempotency(key: string): IdempotencyRecord | undefined;
  saveIdempotency(record: IdempotencyRecord): void;
  ping(): boolean;
  close(): void;
}

export class InMemoryStore implements Store {
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly audits: AuditLogEntry[] = [];

  saveOrder(_order: Order): void {}

  saveDriver(_driver: Driver): void {}

  saveBatch(_batch: BatchAssignment): void {}

  savePayment(_payment: PaymentTransaction): void {}

  saveAudit(entry: AuditLogEntry): void {
    this.audits.push(entry);
  }

  load(): StateSnapshot {
    return { orders: [], drivers: [], batches: [], payments: [], audits: [...this.audits] };
  }

  getIdempotency(key: string): IdempotencyRecord | undefined {
    return this.idempotency.get(key);
  }

  saveIdempotency(record: IdempotencyRecord): void {
    this.idempotency.set(record.key, record);
  }

  ping(): boolean {
    return true;
  }

  close(): void {}
}
