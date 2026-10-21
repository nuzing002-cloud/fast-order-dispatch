import {
  AuditLogEntry,
  BatchAssignment,
  Driver,
  DriverEarning,
  Order,
  PaymentTransaction,
  Payout,
  PushSubscriptionRecord
} from '../types/order';

export function cloneOrder(order: Order): Order {
  return {
    ...order,
    restaurant: { ...order.restaurant },
    customer: { ...order.customer },
    items: order.items.map((item) => ({ ...item })),
    declinedDriverIds: order.declinedDriverIds ? [...order.declinedDriverIds] : undefined,
    queuedAt: order.queuedAt ? new Date(order.queuedAt) : undefined,
    createdAt: new Date(order.createdAt),
    updatedAt: new Date(order.updatedAt),
    assignedAt: order.assignedAt ? new Date(order.assignedAt) : undefined,
    pickedUpAt: order.pickedUpAt ? new Date(order.pickedUpAt) : undefined,
    deliveredAt: order.deliveredAt ? new Date(order.deliveredAt) : undefined,
    estimatedDeliveryTime: order.estimatedDeliveryTime
      ? new Date(order.estimatedDeliveryTime)
      : undefined
  };
}

export function cloneDriver(driver: Driver): Driver {
  return {
    ...driver,
    assignedOrders: [...driver.assignedOrders],
    acceptsNewOrders: driver.acceptsNewOrders !== false,
    lastLocationUpdate: driver.lastLocationUpdate
      ? new Date(driver.lastLocationUpdate)
      : undefined
  };
}

export function cloneBatch(batch: BatchAssignment): BatchAssignment {
  return {
    ...batch,
    orderIds: [...batch.orderIds],
    deliverySequence: [...batch.deliverySequence],
    createdAt: new Date(batch.createdAt),
    startedAt: batch.startedAt ? new Date(batch.startedAt) : undefined,
    completedAt: batch.completedAt ? new Date(batch.completedAt) : undefined
  };
}

export function clonePayment(payment: PaymentTransaction): PaymentTransaction {
  return {
    ...payment,
    createdAt: new Date(payment.createdAt),
    processedAt: payment.processedAt ? new Date(payment.processedAt) : undefined
  };
}

export function cloneEarning(earning: DriverEarning): DriverEarning {
  return {
    ...earning,
    createdAt: new Date(earning.createdAt),
    paidAt: earning.paidAt ? new Date(earning.paidAt) : undefined
  };
}

export function clonePayout(payout: Payout): Payout {
  return {
    ...payout,
    earningIds: [...payout.earningIds],
    createdAt: new Date(payout.createdAt),
    paidAt: new Date(payout.paidAt)
  };
}

export function clonePushSubscription(
  subscription: PushSubscriptionRecord
): PushSubscriptionRecord {
  return {
    ...subscription,
    keys: { ...subscription.keys },
    createdAt: new Date(subscription.createdAt)
  };
}

export function cloneAudit(entry: AuditLogEntry): AuditLogEntry {
  return {
    ...entry,
    timestamp: new Date(entry.timestamp),
    details: entry.details ? { ...entry.details } : undefined
  };
}
