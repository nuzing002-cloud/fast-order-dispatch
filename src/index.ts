import cors from 'cors';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  BatchProcessingService,
  DISPATCH_DRIVER_ID
} from './services/BatchProcessingService';
import {
  Customer,
  Driver,
  DriverStatus,
  Order,
  OrderItem,
  OrderStatus,
  PaymentStatus,
  Restaurant
} from './types/order';

dotenv.config();

const app = express();
const dispatchService = new BatchProcessingService();

app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }));
app.use(express.json({ limit: '1mb' }));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function coordinate(value: unknown, field: string, min: number, max: number): number {
  const number = requiredNumber(value, field);
  if (number < min || number > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return number;
}

function parseRestaurant(value: unknown): Restaurant {
  if (!isRecord(value)) throw new Error('restaurant must be an object');
  return {
    id: requiredString(value.id, 'restaurant.id'),
    name: requiredString(value.name, 'restaurant.name'),
    address: requiredString(value.address, 'restaurant.address'),
    latitude: coordinate(value.latitude, 'restaurant.latitude', -90, 90),
    longitude: coordinate(value.longitude, 'restaurant.longitude', -180, 180),
    phone: requiredString(value.phone, 'restaurant.phone'),
    preparationTime: requiredNumber(value.preparationTime, 'restaurant.preparationTime')
  };
}

function parseCustomer(value: unknown): Customer {
  if (!isRecord(value)) throw new Error('customer must be an object');
  return {
    id: requiredString(value.id, 'customer.id'),
    name: requiredString(value.name, 'customer.name'),
    phone: requiredString(value.phone, 'customer.phone'),
    address: requiredString(value.address, 'customer.address'),
    latitude: coordinate(value.latitude, 'customer.latitude', -90, 90),
    longitude: coordinate(value.longitude, 'customer.longitude', -180, 180),
    email: optionalString(value.email, 'customer.email')
  };
}

function parseItems(value: unknown): OrderItem[] {
  if (!Array.isArray(value)) throw new Error('items must be an array');
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`items[${index}] must be an object`);
    return {
      id: requiredString(item.id, `items[${index}].id`),
      name: requiredString(item.name, `items[${index}].name`),
      quantity: requiredNumber(item.quantity, `items[${index}].quantity`),
      price: requiredNumber(item.price, `items[${index}].price`),
      specialInstructions: optionalString(
        item.specialInstructions,
        `items[${index}].specialInstructions`
      )
    };
  });
}

function parseOrder(value: unknown): Order {
  if (!isRecord(value)) throw new Error('request body must be an object');
  const id = optionalString(value.id, 'id') ?? `order_${uuidv4()}`;
  return {
    id,
    orderId: optionalString(value.orderId, 'orderId') ?? id,
    restaurant: parseRestaurant(value.restaurant),
    customer: parseCustomer(value.customer),
    items: parseItems(value.items),
    totalAmount: requiredNumber(value.totalAmount, 'totalAmount'),
    deliveryFee: requiredNumber(value.deliveryFee, 'deliveryFee'),
    status: OrderStatus.PENDING,
    paymentStatus: PaymentStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
    notes: optionalString(value.notes, 'notes')
  };
}

function parseDriver(value: unknown): Driver {
  if (!isRecord(value)) throw new Error('request body must be an object');
  const status = value.status === undefined
    ? DriverStatus.AVAILABLE
    : requiredString(value.status, 'status') as DriverStatus;
  if (!Object.values(DriverStatus).includes(status)) {
    throw new Error(`status must be one of: ${Object.values(DriverStatus).join(', ')}`);
  }

  return {
    id: requiredString(value.id, 'id'),
    name: requiredString(value.name, 'name'),
    phone: requiredString(value.phone, 'phone'),
    vehicle: requiredString(value.vehicle, 'vehicle'),
    licensePlate: requiredString(value.licensePlate, 'licensePlate'),
    status,
    currentLatitude: coordinate(value.currentLatitude, 'currentLatitude', -90, 90),
    currentLongitude: coordinate(value.currentLongitude, 'currentLongitude', -180, 180),
    assignedOrders: Array.isArray(value.assignedOrders)
      ? value.assignedOrders.map((orderId, index) => requiredString(orderId, `assignedOrders[${index}]`))
      : [],
    totalDeliveries: value.totalDeliveries === undefined
      ? 0
      : requiredNumber(value.totalDeliveries, 'totalDeliveries'),
    rating: value.rating === undefined ? 0 : requiredNumber(value.rating, 'rating'),
    isAvailable: value.isAvailable === undefined ? status === DriverStatus.AVAILABLE : value.isAvailable === true,
    maxOrdersPerBatch: value.maxOrdersPerBatch === undefined
      ? 3
      : requiredNumber(value.maxOrdersPerBatch, 'maxOrdersPerBatch'),
    lastLocationUpdate: value.lastLocationUpdate === undefined
      ? undefined
      : new Date(requiredString(value.lastLocationUpdate, 'lastLocationUpdate'))
  };
}

app.get('/health', (_request: Request, response: Response) => {
  response.json({
    status: 'ok',
    service: 'fast-order-dispatch',
    dispatchDriverId: DISPATCH_DRIVER_ID,
    queueSize: dispatchService.getQueueSize(),
    timestamp: new Date().toISOString()
  });
});

app.get('/drivers', (_request: Request, response: Response) => {
  response.json({ drivers: dispatchService.getDrivers() });
});

app.post('/drivers', (request: Request, response: Response, next: NextFunction) => {
  try {
    const driver = parseDriver(request.body);
    dispatchService.registerDriver(driver);
    response.status(201).json({ driver, dispatchDriverId: DISPATCH_DRIVER_ID });
  } catch (error) {
    next(error);
  }
});

app.post('/orders', async (request: Request, response: Response, next: NextFunction) => {
  try {
    const order = parseOrder(request.body);
    dispatchService.addOrder(order);
    const batch = await dispatchService.processBatch();
    response.status(201).json({
      order,
      batch,
      queueSize: dispatchService.getQueueSize(),
      assignedToTargetDriver: batch?.driverId === DISPATCH_DRIVER_ID
    });
  } catch (error) {
    next(error);
  }
});

function sendPendingOrders(_request: Request, response: Response): void {
  response.json({
    orders: dispatchService.getPendingOrders(),
    queueSize: dispatchService.getQueueSize(),
    dispatchDriverId: DISPATCH_DRIVER_ID
  });
}

app.get('/orders/pending', sendPendingOrders);
// Keep the shorter path working for clients that cannot easily type the suffix.
app.get('/orders/', sendPendingOrders);

app.post('/dispatch/process', async (_request: Request, response: Response, next: NextFunction) => {
  try {
    const batch = await dispatchService.processBatch();
    response.json({ batch, queueSize: dispatchService.getQueueSize() });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : 'Internal server error';
  const statusCode = message.includes('must be') || message.includes('already exists')
    ? 400
    : 500;
  response.status(statusCode).json({ error: message });
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

export { app, dispatchService };

if (require.main === module) {
  app.listen(port, host, () => {
    console.log(`[SERVER] fast-order-dispatch listening on http://${host}:${port}`);
    console.log(`[DISPATCH] Orders are restricted to driver ${DISPATCH_DRIVER_ID}`);
  });
}