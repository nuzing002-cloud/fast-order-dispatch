import { BatchAssignment, Driver, Order, PaymentTransaction } from '../types/order';

export interface StateSnapshot {
  orders: Order[];
  drivers: Driver[];
  batches: BatchAssignment[];
  payments: PaymentTransaction[];
}

export interface Store {
  saveOrder(order: Order): void;
  saveDriver(driver: Driver): void;
  saveBatch(batch: BatchAssignment): void;
  savePayment(payment: PaymentTransaction): void;
  load(): StateSnapshot;
  ping(): boolean;
  close(): void;
}

export class InMemoryStore implements Store {
  saveOrder(_order: Order): void {}

  saveDriver(_driver: Driver): void {}

  saveBatch(_batch: BatchAssignment): void {}

  savePayment(_payment: PaymentTransaction): void {}

  load(): StateSnapshot {
    return { orders: [], drivers: [], batches: [], payments: [] };
  }

  ping(): boolean {
    return true;
  }

  close(): void {}
}
