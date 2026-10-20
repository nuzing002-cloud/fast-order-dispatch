import { v4 as uuidv4 } from 'uuid';
import { Order, PaymentStatus, PaymentTransaction } from '../types/order';

export type GatewayResult =
  | boolean
  | {
      success: boolean;
      providerTransactionId?: string;
      notes?: string;
    };

export interface PaymentGateway {
  charge(order: Order, transaction: PaymentTransaction): Promise<GatewayResult>;
  refund(order: Order, transaction: PaymentTransaction): Promise<GatewayResult>;
}

const GATEWAY_DELAY_MS = 150;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class MockPaymentGateway implements PaymentGateway {
  async charge(order: Order, _transaction: PaymentTransaction): Promise<boolean> {
    await delay(GATEWAY_DELAY_MS);
    if (order.totalAmount <= 0) {
      throw new Error('Invalid payment amount');
    }
    return true;
  }

  async refund(_order: Order, _transaction: PaymentTransaction): Promise<boolean> {
    await delay(GATEWAY_DELAY_MS);
    return true;
  }
}

export class PaymentService {
  constructor(
    private readonly gateway: PaymentGateway = new MockPaymentGateway(),
    readonly provider: string = 'mock'
  ) {}

  async processPayment(order: Order, method: string = 'card'): Promise<PaymentTransaction> {
    const transaction: PaymentTransaction = {
      id: `tx_${uuidv4()}`,
      orderId: order.id,
      amount: order.totalAmount,
      method,
      kind: 'charge',
      status: PaymentStatus.PROCESSING,
      provider: this.provider,
      createdAt: new Date()
    };

    return this.execute(transaction, () => this.gateway.charge(order, transaction), 'Payment failed');
  }

  async refund(
    order: Order,
    method: string = 'card',
    sourceTransactionId?: string
  ): Promise<PaymentTransaction> {
    const transaction: PaymentTransaction = {
      id: `tx_${uuidv4()}`,
      orderId: order.id,
      amount: -order.totalAmount,
      method,
      kind: 'refund',
      status: PaymentStatus.PROCESSING,
      provider: this.provider,
      sourceTransactionId,
      createdAt: new Date()
    };

    return this.execute(transaction, () => this.gateway.refund(order, transaction), 'Refund failed');
  }

  private async execute(
    transaction: PaymentTransaction,
    operation: () => Promise<GatewayResult>,
    failureNote: string
  ): Promise<PaymentTransaction> {
    try {
      const result = await operation();
      const success = typeof result === 'boolean' ? result : result.success;
      if (typeof result !== 'boolean') {
        transaction.providerTransactionId = result.providerTransactionId;
        if (result.notes) transaction.notes = result.notes;
      }
      transaction.status = success ? PaymentStatus.COMPLETED : PaymentStatus.FAILED;
      transaction.processedAt = new Date();
      if (!success && !transaction.notes) transaction.notes = failureNote;
      return transaction;
    } catch (error) {
      transaction.status = PaymentStatus.FAILED;
      transaction.processedAt = new Date();
      transaction.notes = String(error instanceof Error ? error.message : error);
      return transaction;
    }
  }
}
