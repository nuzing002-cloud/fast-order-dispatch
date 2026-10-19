import { PaymentGateway, PaymentService } from '../src/services/PaymentService';
import { Order, OrderStatus, PaymentStatus } from '../src/types/order';

function makeOrder(totalAmount: number): Order {
  return {
    id: 'o1',
    orderId: 'o1',
    restaurant: {
      id: 'r1',
      name: 'Restaurant',
      address: 'Somewhere',
      latitude: 13.75,
      longitude: 100.5,
      phone: '0000000000',
      preparationTime: 5
    },
    customer: {
      id: 'c1',
      name: 'Customer',
      phone: '0000000000',
      address: 'Elsewhere',
      latitude: 13.76,
      longitude: 100.51
    },
    items: [{ id: 'i1', name: 'Item', quantity: 1, price: totalAmount }],
    totalAmount,
    deliveryFee: 10,
    status: OrderStatus.PENDING,
    paymentStatus: PaymentStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

describe('PaymentService', () => {
  test('completes a payment for a valid order', async () => {
    const service = new PaymentService();
    const transaction = await service.processPayment(makeOrder(100));

    expect(transaction.status).toBe(PaymentStatus.COMPLETED);
    expect(transaction.orderId).toBe('o1');
    expect(transaction.amount).toBe(100);
    expect(transaction.processedAt).toBeInstanceOf(Date);
  });

  test('fails a payment for a non-positive amount', async () => {
    const service = new PaymentService();
    const transaction = await service.processPayment(makeOrder(0));

    expect(transaction.status).toBe(PaymentStatus.FAILED);
    expect(transaction.notes).toContain('Invalid payment amount');
    expect(transaction.processedAt).toBeInstanceOf(Date);
  });

  test('fails a payment when the gateway declines', async () => {
    const gateway: PaymentGateway = {
      charge: async () => false,
      refund: async () => false
    };
    const transaction = await new PaymentService(gateway).processPayment(makeOrder(50));

    expect(transaction.kind).toBe('charge');
    expect(transaction.status).toBe(PaymentStatus.FAILED);
    expect(transaction.notes).toBe('Payment failed');
  });

  test('creates a refund transaction with a negative amount', async () => {
    const transaction = await new PaymentService().refund(makeOrder(120), 'wallet');

    expect(transaction.kind).toBe('refund');
    expect(transaction.amount).toBe(-120);
    expect(transaction.method).toBe('wallet');
    expect(transaction.status).toBe(PaymentStatus.COMPLETED);
    expect(transaction.processedAt).toBeInstanceOf(Date);
  });
});
