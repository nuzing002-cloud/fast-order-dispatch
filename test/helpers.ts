import { DISPATCH_DRIVER_ID } from '../src/services/BatchProcessingService';
import { Driver, DriverStatus, Order, OrderStatus, PaymentStatus } from '../src/types/order';

let sequence = 0;

export function makeOrder(
  id = `o${(sequence += 1)}`,
  latitude = 13.76,
  longitude = 100.51,
  totalAmount = 100,
  preparationTime = 5
): Order {
  return {
    id,
    orderId: id,
    restaurant: {
      id: `r_${id}`,
      name: 'Restaurant',
      address: 'Somewhere',
      latitude: 13.75,
      longitude: 100.5,
      phone: '0000000000',
      preparationTime
    },
    customer: {
      id: `c_${id}`,
      name: 'Customer',
      phone: '0000000000',
      address: 'Elsewhere',
      latitude,
      longitude
    },
    items: [{ id: 'i1', name: 'Item', quantity: 1, price: totalAmount }],
    totalAmount,
    deliveryFee: 28,
    status: OrderStatus.PENDING,
    paymentStatus: PaymentStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

export function makeDriver(id = DISPATCH_DRIVER_ID, maxOrdersPerBatch = 3): Driver {
  return {
    id,
    name: 'Target Driver',
    phone: '0000000000',
    vehicle: 'motorcycle',
    licensePlate: 'TARGET',
    status: DriverStatus.AVAILABLE,
    currentLatitude: 13.7563,
    currentLongitude: 100.5018,
    assignedOrders: [],
    totalDeliveries: 0,
    rating: 0,
    isAvailable: true,
    maxOrdersPerBatch
  };
}
