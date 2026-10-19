import { BatchAssignment, Driver, Order } from '../types/order';

export interface StateSnapshot {
  orders: Order[];
  drivers: Driver[];
  batches: BatchAssignment[];
}

export interface Store {
  saveOrder(order: Order): void;
  saveDriver(driver: Driver): void;
  saveBatch(batch: BatchAssignment): void;
  load(): StateSnapshot;
  close(): void;
}

export class InMemoryStore implements Store {
  saveOrder(_order: Order): void {}

  saveDriver(_driver: Driver): void {}

  saveBatch(_batch: BatchAssignment): void {}

  load(): StateSnapshot {
    return { orders: [], drivers: [], batches: [] };
  }

  close(): void {}
}
