import cors from 'cors';
import express, { Express, NextFunction, Request, Response } from 'express';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig } from './config';
import { ConflictError, HttpError, NotFoundError, ValidationError } from './errors';
import { logger } from './logger';
import {
  createAuthMiddleware,
  createRateLimiter,
  requestLogger,
  RequestWithId,
  securityHeaders
} from './middleware';
import { openApiSpec } from './openapi';
import { attachRealtime } from './realtime';
import {
  BatchProcessingService,
  DISPATCH_DRIVER_ID,
  DriverPatch
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

const config = loadConfig();

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

function positiveInteger(value: unknown, field: string): number {
  const number = requiredNumber(value, field);
  if (!Number.isInteger(number) || number < 1) {
    throw new ValidationError(`${field} must be a positive integer`);
  }
  return number;
}

function rating(value: unknown, field: string): number {
  const number = requiredNumber(value, field);
  if (number < 0 || number > 5) {
    throw new ValidationError(`${field} must be between 0 and 5`);
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
    rating: value.rating === undefined ? 0 : rating(value.rating, 'rating'),
    isAvailable: value.isAvailable === undefined ? status === DriverStatus.AVAILABLE : value.isAvailable === true,
    maxOrdersPerBatch: value.maxOrdersPerBatch === undefined
      ? 3
      : positiveInteger(value.maxOrdersPerBatch, 'maxOrdersPerBatch'),
    lastLocationUpdate: value.lastLocationUpdate === undefined
      ? undefined
      : new Date(requiredString(value.lastLocationUpdate, 'lastLocationUpdate'))
  };
}

function parseDriverPatch(value: unknown): DriverPatch {
  if (!isRecord(value)) throw new ValidationError('request body must be an object');
  const patch: DriverPatch = {};

  if (value.currentLatitude !== undefined || value.currentLongitude !== undefined) {
    patch.currentLatitude = coordinate(value.currentLatitude, 'currentLatitude', -90, 90);
    patch.currentLongitude = coordinate(value.currentLongitude, 'currentLongitude', -180, 180);
  }
  if (value.status !== undefined) {
    const status = requiredString(value.status, 'status') as DriverStatus;
    if (status === DriverStatus.BUSY || !Object.values(DriverStatus).includes(status)) {
      throw new ValidationError('status must be one of: AVAILABLE, ON_BREAK, OFFLINE');
    }
    patch.status = status;
  }
  if (value.isAvailable !== undefined) {
    if (typeof value.isAvailable !== 'boolean') {
      throw new ValidationError('isAvailable must be a boolean');
    }
    patch.isAvailable = value.isAvailable;
  }
  if (value.maxOrdersPerBatch !== undefined) {
    patch.maxOrdersPerBatch = positiveInteger(value.maxOrdersPerBatch, 'maxOrdersPerBatch');
  }
  if (value.rating !== undefined) {
    patch.rating = rating(value.rating, 'rating');
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError(
      'at least one of currentLatitude/currentLongitude, status, isAvailable, maxOrdersPerBatch, or rating is required'
    );
  }
  return patch;
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

function parsePagination(query: Request['query']): { limit: number; offset: number } {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ValidationError('limit must be an integer between 1 and 200');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError('offset must be a non-negative integer');
  }
  return { limit, offset };
}

const docsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>fast-order-dispatch API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });</script>
</body>
</html>`;

export interface DispatchAppOptions {
  service?: BatchProcessingService;
  paymentService?: PaymentService;
  apiKey?: string;
  rateLimit?: { windowMs: number; max: number };
  trustProxy?: boolean;
}

export function createDispatchApp(options: DispatchAppOptions = {}): Express {
  const service = options.service ?? new BatchProcessingService();
  const paymentService = options.paymentService ?? new PaymentService();
  const app = express();

  if (options.trustProxy) app.set('trust proxy', true);

  app.use(securityHeaders());
  app.use(requestLogger());
  app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }));
  if (options.rateLimit) app.use(createRateLimiter(options.rateLimit));
  app.use(createAuthMiddleware(options.apiKey));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_request: Request, response: Response) => {
    response.json({
      status: 'ok',
      service: 'fast-order-dispatch',
      dispatchDriverId: DISPATCH_DRIVER_ID,
      dispatchDriverIds: service.getDispatchDriverIds(),
      storage: process.env.DB_PATH ? 'sqlite' : 'memory',
      queueSize: service.getQueueSize(),
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  app.get('/ready', (_request: Request, response: Response) => {
    const ready = service.isReady();
    response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
  });

  app.get('/openapi.json', (_request: Request, response: Response) => {
    response.json(openApiSpec);
  });

  app.get('/docs', (_request: Request, response: Response) => {
    response.type('html').send(docsHtml);
  });

  app.get('/drivers', (_request: Request, response: Response) => {
    response.json({ drivers: service.getDrivers() });
  });

  app.post('/drivers', (request: Request, response: Response, next: NextFunction) => {
    try {
      const driver = parseDriver(request.body);
      service.registerDriver(driver);
      response.status(201).json({
        driver: service.getDriver(driver.id) ?? driver,
        dispatchDriverId: DISPATCH_DRIVER_ID
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/drivers/:id', (request: Request, response: Response, next: NextFunction) => {
    try {
      const driverId = routeParam(request, 'id');
      const driver = service.getDriver(driverId);
      if (!driver) throw new NotFoundError(`Driver ${driverId} was not found`);
      response.json({ driver });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/drivers/:id', (request: Request, response: Response, next: NextFunction) => {
    try {
      const patch = parseDriverPatch(request.body);
      const driver = service.updateDriverDetails(routeParam(request, 'id'), patch);
      response.json({ driver });
    } catch (error) {
      next(error);
    }
  });

  const pendingOrders = (_request: Request, response: Response): void => {
    response.json({
      orders: service.getPendingOrders(),
      queueSize: service.getQueueSize(),
      dispatchDriverId: DISPATCH_DRIVER_ID
    });
  };

  app.get('/orders/pending', pendingOrders);

  app.get('/orders', (request: Request, response: Response, next: NextFunction) => {
    try {
      const { limit, offset } = parsePagination(request.query);
      const status = request.query.status === undefined
        ? undefined
        : parseOrderStatus(request.query.status);
      const orders = service
        .getOrders()
        .filter((order) => status === undefined || order.status === status);
      response.json({
        orders: orders.slice(offset, offset + limit),
        total: orders.length,
        limit,
        offset
      });
    } catch (error) {
      next(error);
    }
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

  app.get('/orders/:id/payments', (request: Request, response: Response, next: NextFunction) => {
    try {
      const orderId = routeParam(request, 'id');
      if (!service.getOrder(orderId)) {
        throw new NotFoundError(`Order ${orderId} was not found`);
      }
      response.json({ payments: service.getPayments(orderId) });
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
      service.recordPayment(transaction);

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
        assignedDriverId: batch?.driverId ?? null,
        assignedToTargetDriver: batch
          ? service.getDispatchDriverIds().includes(batch.driverId)
          : false,
        queueSize: service.getQueueSize()
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
      service.recordPayment(transaction);
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
        assignedDriverId: batch?.driverId ?? null,
        assignedToTargetDriver: batch
          ? service.getDispatchDriverIds().includes(batch.driverId)
          : false,
        queueSize: service.getQueueSize()
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/orders/:id/refund', async (request: Request, response: Response, next: NextFunction) => {
    try {
      const orderId = routeParam(request, 'id');
      const order = service.getOrder(orderId);
      if (!order) throw new NotFoundError(`Order ${orderId} was not found`);
      if (order.paymentStatus !== PaymentStatus.COMPLETED) {
        throw new ConflictError(`Order ${orderId} has no completed payment to refund`);
      }

      const method = isRecord(request.body)
        ? optionalString(request.body.method, 'method')
        : undefined;
      const transaction = await paymentService.refund(order, method ?? 'card');
      service.recordPayment(transaction);

      if (transaction.status !== PaymentStatus.COMPLETED) {
        response.status(402).json({
          error: transaction.notes ?? 'Refund failed',
          order: service.getOrder(orderId),
          transaction
        });
        return;
      }

      service.updatePaymentStatus(orderId, PaymentStatus.REFUNDED);
      response.json({
        order: service.getOrder(orderId),
        transaction
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

  app.get('/batches', (request: Request, response: Response, next: NextFunction) => {
    try {
      const { limit, offset } = parsePagination(request.query);
      const batches = service.getBatches();
      response.json({
        batches: batches.slice(offset, offset + limit),
        total: batches.length,
        limit,
        offset
      });
    } catch (error) {
      next(error);
    }
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

  app.use((error: unknown, request: RequestWithId, response: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      if (error.statusCode >= 500) {
        logger.error('request_error', {
          requestId: request.requestId,
          status: error.statusCode,
          error: error.message,
          path: request.originalUrl
        });
      } else {
        logger.warn('request_rejected', {
          requestId: request.requestId,
          status: error.statusCode,
          error: error.message,
          path: request.originalUrl
        });
      }
      response.status(error.statusCode).json({ error: error.message });
      return;
    }

    const statusHint =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: unknown }).status
        : undefined;
    if (statusHint === 400) {
      response.status(400).json({ error: 'Invalid JSON body' });
      return;
    }

    const message = error instanceof Error ? error.message : 'Internal server error';
    logger.error('unhandled_error', {
      requestId: request.requestId,
      error: message,
      path: request.originalUrl
    });
    response.status(500).json({ error: message });
  });

  return app;
}

const store = process.env.DB_PATH ? new SqliteStore(process.env.DB_PATH) : new InMemoryStore();
export const dispatchService = new BatchProcessingService(3, store, {
  dispatchDriverIds: config.dispatchDriverIds
});
export const app = createDispatchApp({
  service: dispatchService,
  apiKey: config.apiKey,
  rateLimit: { windowMs: config.rateLimitWindowMs, max: config.rateLimitMax },
  trustProxy: config.trustProxy
});

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
  const io = attachRealtime(server, dispatchService, {
    apiKey: config.apiKey,
    redisUrl: process.env.REDIS_URL
  });

  const interval = Number(process.env.AUTO_PROCESS_INTERVAL_MS ?? 0);
  if (Number.isInteger(interval) && interval >= 100) {
    dispatchService.startAutoProcessing(interval);
  }

  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;
    logger.info('server_listening', {
      host,
      port: boundPort,
      storage: process.env.DB_PATH ? 'sqlite' : 'memory',
      auth: config.apiKey ? 'api-key' : 'disabled',
      rateLimit: config.rateLimitMax > 0 ? `${config.rateLimitMax}/${config.rateLimitWindowMs}ms` : 'disabled',
      redis: Boolean(process.env.REDIS_URL)
    });
    logger.info('dispatch_restricted', { driverIds: dispatchService.getDispatchDriverIds() });
  });

  return { server, io };
}

if (require.main === module) {
  const { io } = startServer();
  const shutdown = (): void => {
    logger.info('shutting_down');
    dispatchService.stopAutoProcessing();
    io.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
