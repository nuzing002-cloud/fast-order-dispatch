import { Order, OrderStatus, Driver, BatchAssignment } from '../types/order';
import { DistanceCalculator } from '../utils/DistanceCalculator';

/**
 * Batch Processing Service
 * Processes orders in batches of 3, optimizes routing, and assigns to drivers
 */
export class BatchProcessingService {
  private batchSize: number = 3;
  private orderQueue: Order[] = [];
  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessing: boolean = false;

  constructor(batchSize: number = 3) {
    this.batchSize = batchSize;
  }

  /**
   * Add order to processing queue
   */
  addOrder(order: Order): void {
    order.status = OrderStatus.PENDING;
    this.orderQueue.push(order);
    console.log(`[QUEUE] Order ${order.id} added. Queue size: ${this.orderQueue.length}`);
  }

  /**
   * Process orders in batches of 3
   */
  async processBatch(): Promise<BatchAssignment | null> {
    if (this.isProcessing || this.orderQueue.length === 0) {
      return null;
    }

    this.isProcessing = true;

    try {
      const batchOrders = this.orderQueue.splice(0, this.batchSize);
      console.log(`\n[BATCH] Processing ${batchOrders.length} orders`);
      
      const optimizedSequence = this.optimizeDeliverySequence(batchOrders);
      
      const batchAssignment: BatchAssignment = {
        id: `BATCH_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        driverId: '',
        orderIds: batchOrders.map(o => o.id),
        createdAt: new Date(),
        startedAt: new Date(),
        totalRevenue: batchOrders.reduce((sum, o) => sum + o.totalAmount, 0),
        deliverySequence: optimizedSequence
      };

      console.log(`[BATCH] Optimized sequence: ${optimizedSequence.join(' → ')}`);
      console.log(`[BATCH] Total revenue: $${batchAssignment.totalRevenue}`);
      console.log(`[QUEUE] Remaining orders: ${this.orderQueue.length}`);

      return batchAssignment;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Optimize delivery sequence using nearest neighbor algorithm
   */
  private optimizeDeliverySequence(orders: Order[]): string[] {
    if (orders.length <= 1) {
      return orders.map(o => o.id);
    }

    const sequence: string[] = [];
    const remaining = new Set(orders.map((_, i) => i));
    let currentIndex = 0;
    sequence.push(orders[0].id);
    remaining.delete(0);

    while (remaining.size > 0) {
      let nearestIndex = -1;
      let minDistance = Infinity;
      const currentOrder = orders[currentIndex];

      for (const idx of remaining) {
        const distance = DistanceCalculator.calculate(
          currentOrder.customer.latitude,
          currentOrder.customer.longitude,
          orders[idx].customer.latitude,
          orders[idx].customer.longitude
        );

        if (distance < minDistance) {
          minDistance = distance;
          nearestIndex = idx;
        }
      }

      if (nearestIndex !== -1) {
        sequence.push(orders[nearestIndex].id);
        currentIndex = nearestIndex;
        remaining.delete(nearestIndex);
      }
    }

    return sequence;
  }

  getQueueSize(): number {
    return this.orderQueue.length;
  }

  getPendingOrders(): Order[] {
    return [...this.orderQueue];
  }
}
