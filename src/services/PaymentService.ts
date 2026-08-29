import { PaymentTransaction, PaymentStatus, Order } from '../types/order';
import { v4 as uuidv4 } from 'uuid';

/**
 * PaymentService
 * - processes payments for orders (mock/simulated gateway)
 * - returns a PaymentTransaction and does NOT persist state (caller should persist/update Order)
 */
export class PaymentService {
  /**
   * Process payment for an order.
   * - Sets transaction status to PROCESSING, then completes or fails.
   * - Throws only on unexpected errors; returns a transaction record for the result.
   */
  async processPayment(order: Order, method = 'card'): Promise<PaymentTransaction> {
    const tx: PaymentTransaction = {
      id: `tx_${uuidv4()}`,
      orderId: order.id,
      amount: order.totalAmount,
      method,
      status: PaymentStatus.PROCESSING,
      createdAt: new Date()
    };

    try {
      const success = await this.callMockGateway(order, tx);

      tx.status = success ? PaymentStatus.COMPLETED : PaymentStatus.FAILED;
      tx.processedAt = new Date();

      return tx;
    } catch (err: any) {
      tx.status = PaymentStatus.FAILED;
      tx.processedAt = new Date();
      tx.notes = String(err?.message ?? err);
      return tx;
    }
  }

  /**
   * Simulated payment gateway call.
   * - replace with real gateway integration (Stripe, PayPal, etc.)
   */
  private async callMockGateway(order: Order, tx: PaymentTransaction): Promise<boolean> {
    // Simulate network latency
    await new Promise((res) => setTimeout(res, 150));

    // Basic validation: amount must be > 0
    if (order.totalAmount <= 0) {
      throw new Error('Invalid payment amount');
    }

    // Example rule: succeed for now. You can add deterministic failure rules for testing.
    return true;
  }
}
