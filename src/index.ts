import cors from 'cors';
import dotenv from 'dotenv';
import express, { Express, NextFunction, Request, Response } from 'express';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { ConflictError, HttpError, NotFoundError, ValidationError } from './errors';
import { attachRealtime } from './realtime';
import {
  BatchProcessingService,
  DISPATCH_DRIVER_ID
} from './services/BatchProcessingService';
import { PaymentService } from './services/PaymentService';
import { InMemoryStore } from './store/Store';
import { SqliteStore } from './store/SqliteStore';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, field: string): number {
  const number = requiredNumber(value, field);
  if (number < 0) {
    throw new ValidationError(`${field} must be zero or greater`);
  }
  return number;
}

function coordinate(value: unknown, field: string, min: number, max: number): number {
  const number = requiredNumber(value, field);
  if (number < min || number > max) {
    throw new ValidationError(`${field} must be between ${min} and ${max}`);
  }
  return number;
}

function parseRestaurant(value: unknown): Restaurant {
  if (!isRecord(value)) throw new ValidationError('restaurant must be an object');
  return {
    id: requiredString(value.id, 'restaurant.id'),
    name: requiredString(value.name, 'restaurant.name'),
    address: requiredString(value.address, 'restaurant.address'),
    latitude: coordinate(value.latitude, 'restaurant.latitude', -90, 90),
    longitude: coordinate(value.longitude, 'restaurant.longitude', -180, 180),
    phone: requiredString(value.phone, 'restaurant.phone'),
    preparationTime: nonNegativeNumber(value.preparationTime, 'restaurant.preparationTime')
  };
}

function parseCustomer(value: unknown): Customer {
  if (!isRecord(value)) throw new ValidationError('customer must be an object');
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
  if (!Array.isArray(value)) throw new ValidationError('items must be an array');
  if (value.length === 0) throw new ValidationError('items must not be empty');
  return value.map((item, index) => {
    if (!isRecord(item)) throw new ValidationError(`items[${index}] must be an object`);
    return {
      id: requiredString(item.id, `items[${index}].id`),
      name: requiredString(item.name, `items[${index}].name`),
      quantity: nonNegativeNumber(item.quantity, `items[${index}].quantity`),
      price: nonNegativeNumber(item.price, `items[${index}].price`),
      specialInstructions: optionalString(
        item.specialInstructions,
        `items[${index}].specialInstructions`
      )
    };
  });
}

function parseOrder(value: unknown): Order {
  if (!isRecord(value)) throw new ValidationError('request body must be an object');
  const id = optionalString(value.id, 'id') ?? `order_${uuidv4()}`;
  return {
    id,
    orderId: optionalString(value.orderId, 'orderId') ?? id,
    restaurant: parseRestaurant(value.restaurant),
    customer: parseCustomer(value.customer),
    items: parseItems(value.items),
    totalAmount: nonNegativeNumber(value.totalAmount, 'totalAmount'),
    deliveryFee: nonNegativeNumber(value.deliveryFee, 'deliveryFee'),
    status: OrderStatus.PENDING,
    paymentStatus: PaymentStatus.PENDING,
    createdAt: new Date(),
    updatedAt: new Date(),
    notes: optionalString(value.notes, 'notes')
  };
}

function parseDriver(value: unknown): Driver {
  if (!isRecord(value)) throw new ValidationError('request body must be an object');
  const status = value.status === undefined
    ? DriverStatus.AVAILABLE
    : requiredString(value.status, 'status') as DriverStatus;
  if (!Object.values(DriverStatus).includes(status)) {
    throw new ValidationError(`status must be one of: ${Object.values(DriverStatus).join(', ')}`);
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
      : nonNegativeNumber(value.totalDeliveries, 'totalDeliveries'),
    rating: value.rating === undefined ? 0 : requiredNumber(value.rating, 'rating'),
    isAvailable: value.isAvailable === undefined ? status === DriverStatus.AVAILABLE : value.isAvailable === true,
    maxOrdersPerBatch: value.maxOrdersPerBatch === undefined
      ? 3
      : nonNegativeNumber(value.maxOrdersPerBatch, 'maxOrdersPerBatch'),
    lastLocationUpdate: value.lastLocationUpdate === undefined
      ? undefined
      : new Date(requiredString(value.lastLocationUpdate, 'lastLocationUpdate'))
  };
}

function parseOrderStatus(value: unknown): OrderStatus {
  const status = requiredString(value, 'status') as OrderStatus;
  if (!Object.values(OrderStatus).includes(status)) {
    throw new ValidationError(`status must be one of: ${Object.values(OrderStatus).join(', ')}`);
  }
  return status;
}

function routeParam(request: Request, name: string): string {
  const value = request.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${name} is required`);
  }
  return value;
}

export function createDispatchApp(
  service: BatchProcessingService = new BatchProcessingService(),
  paymentService: PaymentService = new PaymentService()
): Express {
  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_request: Request, response: Response) => {
    response.json({
      status: 'ok',
      service: 'fast-order-dispatch',
      dispatchDriverId: DISPATCH_DRIVER_ID,
      storage: process.env.DB_PATH ? 'sqlite' : 'memory',
      queueSize: service.getQueueSize(),
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  app.get('/drivers', (_request: Request, response: Response) => {
    response.json({ drivers: service.getDrivers() });
  });

  app.post('/drivers', (request: Request, response: Response, next: NextFunction) => {
    try {
      const driver = parseDriver(request.body);
      service.registerDriver(driver);
      response.status(201).json({ driver, dispatchDriverId: DISPATCH_DRIVER_ID });
    } catch (error) {
      next(error);
    }
  });

  app.get('/orders/pending', (_request: Request, response: Response) => {
    response.json({
      orders: service.getPendingOrders(),
      queueSize: service.getQueueSize(),
      dispatchDriverId: DISPATCH_DRIVER_ID
    });
  });

  app.get('/orders', (_request: Request, response: Response) => {
    response.json({ orders: service.getOrders() });
  });

  app.get('/orders/:id', (request: Request, response: Response, next: NextFunction) => {
    try {
      const orderId = routeParam(request, 'id');
      const order = service.getOrder(orderId);
      if (!order) throw new NotFoundError(`Order ${orderId} was not found`);
      response.json({ order });
    } catch (error) {
      next(error);
    }
  });

  app.post('/orders', async (request: Request, response: Response, next: NextFunction) => {
    try {
      const order = parseOrder(request.body);
      const paymentMethod = isRecord(request.body)
        ? optionalString(request.body.paymentMethod, 'paymentMethod')
        : undefined;
      const transaction = await paymentService.processPayment(order, paymentMethod ?? 'card');
      order.paymentStatus = transaction.status;

      if (transaction.status !== PaymentStatus.COMPLETED) {
        service.addOrder(order, false);
        response.status(402).json({
          error: transaction.notes ?? 'Payment failed',
          order: service.getOrder(order.id),
          transaction
        });
        return;
      }

      service.addOrder(order);
      const batch = await service.processBatch();
      response.status(201).json({
        order: service.getOrder(order.id),
        transaction,
        batch,
        queueSize: service.getQueueSize(),
        assignedToTargetDriver: batch?.driverId === DISPATCH_DRIVER_ID
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/orders/:id/pay', async (request: Request, response: Response, next: NextFunction) => {
    try {
      const orderId = routeParam(request, 'id');
      const order = service.getOrder(orderId);
      if (!order) throw new NotFoundError(`Order ${orderId} was not found`);
      if (order.paymentStatus === PaymentStatus.COMPLETED) {
        throw new ConflictError(`Order ${orderId} is already paid`);
      }

      const method = isRecord(request.body)
        ? optionalString(request.body.method, 'method')
        : undefined;
      const transaction = await paymentService.processPayment(order, method ?? 'card');
      service.updatePaymentStatus(orderId, transaction.status);

      if (transaction.status !== PaymentStatus.COMPLETED) {
        response.status(402).json({
          error: transaction.notes ?? 'Payment failed',
          order: service.getOrder(orderId),
          transaction
        });
        return;
      }

      service.enqueueOrder(orderId);
      const batch = await service.processBatch();
      response.json({
        order: service.getOrder(orderId),
        transaction,
        batch,
        queueSize: service.getQueueSize(),
        assignedToTargetDriver: batch?.driverId === DISPATCH_DRIVER_ID
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/orders/:id/status', (request: Request, response: Response, next: NextFunction) => {
    try {
      const status = isRecord(request.body)
        ? parseOrderStatus(request.body.status)
        : parseOrderStatus(undefined);
      const order = service.updateOrderStatus(routeParam(request, 'id'), status);
      response.json({ order });
    } catch (error) {
      next(error);
    }
  });

  app.get('/batches', (_request: Request, response: Response) => {
    response.json({ batches: service.getBatches() });
  });

  app.get('/metrics', (_request: Request, response: Response) => {
    response.json(service.getMetrics());
  });

  app.post('/dispatch/process', async (_request: Request, response: Response, next: NextFunction) => {
    try {
      const batch = await service.processBatch();
      response.json({ batch, queueSize: service.getQueueSize() });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message });
      return;
    }
    const message = error instanceof Error ? error.message : 'Internal server error';
    const statusCode = message.includes('must be') || message.includes('already exists')
      ? 400
      : 500;
    response.status(statusCode).json({ error: message });
  });

  return app;
}

const store = process.env.DB_PATH ? new SqliteStore(process.env.DB_PATH) : new InMemoryStore();
export const dispatchService = new BatchProcessingService(3, store);
export const app = createDispatchApp(dispatchService);

export interface StartServerOptions {
  port?: number;
  host?: string;
}

export function startServer(options: StartServerOptions = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ValidationError('PORT must be an integer between 0 and 65535');
  }

  const server = createServer(app);
  const io = attachRealtime(server, dispatchService);

  const interval = Number(process.env.AUTO_PROCESS_INTERVAL_MS ?? 0);
  if (Number.isInteger(interval) && interval >= 100) {
    dispatchService.startAutoProcessing(interval);
  }

  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;
    console.log(`[SERVER] fast-order-dispatch listening on http://${host}:${boundPort}`);
    console.log(`[DISPATCH] Orders are restricted to driver ${DISPATCH_DRIVER_ID}`);
    if (process.env.DB_PATH) console.log(`[STORE] SQLite persistence enabled at ${process.env.DB_PATH}`);
    if (process.env.REDIS_URL) console.log('[REALTIME] REDIS_URL detected; connecting adapter');
  });

  return { server, io };
}

if (require.main === module) {
  const { io } = startServer();
  const shutdown = (): void => {
    dispatchService.stopAutoProcessing();
    io.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
