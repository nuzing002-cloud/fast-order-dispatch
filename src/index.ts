import cors from 'cors';
import express, {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response
} from 'express';
import { createServer } from 'http';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ApiKeyInput } from './auth';
import { AppConfig, loadConfig } from './config';
import { ConflictError, HttpError, NotFoundError, ValidationError } from './errors';
import { createIdempotencyMiddleware, IdempotencyStore } from './idempotency';
import { logger } from './logger';
import {
  createAuthMiddleware,
  createRateLimiter,
  requestLogger,
  RequestWithId,
  requireRole,
  securityHeaders
} from './middleware';
import { openApiSpec } from './openapi';
import { renderPrometheusMetrics } from './prometheus';
import { createPushNotifier, PushNotifier } from './push';
import { createRedisRateLimiter, RateLimiterHandle } from './rateLimiter';
import { attachRealtime } from './realtime';
import {
  BatchProcessingService,
  DISPATCH_DRIVER_ID,
  DriverPatch
} from './services/BatchProcessingService';
import {
  HttpPaymentGateway,
  StripePaymentGateway,
  verifyHmacSignature,
  verifyStripeSignature
} from './services/PaymentGateways';
import { PaymentService } from './services/PaymentService';
import { createDispatchStore } from './store/createStore';
import {
  Customer,
  Driver,
  DriverStatus,
  Order,
  OrderItem,
  OrderStatus,
  PaymentStatus,
  PaymentTransaction,
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
    acceptsNewOrders: value.acceptsNewOrders === undefined
      ? true
      : value.acceptsNewOrders === true,
    maxOrdersPerBatch: value.maxOrdersPerBatch === undefined
      ? 4
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
  if (value.acceptsNewOrders !== undefined) {
    if (typeof value.acceptsNewOrders !== 'boolean') {
      throw new ValidationError('acceptsNewOrders must be a boolean');
    }
    patch.acceptsNewOrders = value.acceptsNewOrders;
  }
  if (value.maxOrdersPerBatch !== undefined) {
    patch.maxOrdersPerBatch = positiveInteger(value.maxOrdersPerBatch, 'maxOrdersPerBatch');
  }
  if (value.rating !== undefined) {
    patch.rating = rating(value.rating, 'rating');
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError(
      'at least one of currentLatitude/currentLongitude, status, isAvailable, acceptsNewOrders, maxOrdersPerBatch, or rating is required'
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

const swaggerUiPath = path.dirname(require.resolve('swagger-ui-dist'));

const docsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>fast-order-dispatch API</title>
  <link rel="stylesheet" href="/swagger-ui/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/swagger-ui/swagger-ui-bundle.js"></script>
  <script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });</script>
</body>
</html>`;

type AsyncRoute = (
  request: Request,
  response: Response,
  next: NextFunction
) => Promise<unknown>;

function asyncHandler(handler: AsyncRoute): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

export interface PaymentWebhookOptions {
  provider: 'mock' | 'http' | 'stripe';
  secret?: string;
}

export interface DispatchAppOptions {
  service?: BatchProcessingService;
  paymentService?: PaymentService;
  apiKey?: string;
  apiKeys?: ApiKeyInput;
  corsOrigins?: string[];
  rateLimit?: { windowMs: number; max: number };
  redisUrl?: string | null;
  trustProxy?: boolean;
  idempotencyStore?: IdempotencyStore;
  idempotencyTtlMs?: number;
  paymentWebhook?: PaymentWebhookOptions;
  push?: PushNotifier;
}

export function createDispatchApp(options: DispatchAppOptions = {}): Express {
  const service = options.service ?? new BatchProcessingService();
  const paymentService = options.paymentService ?? new PaymentService();
  options.push?.bindService(service);
  const app = express();
  app.disable('x-powered-by');

  if (options.trustProxy) app.set('trust proxy', true);

  app.use(securityHeaders());
  app.use(requestLogger());
  app.use(cors({ origin: options.corsOrigins ?? ['*'] }));
  app.use(
    '/swagger-ui',
    express.static(swaggerUiPath, { index: false, maxAge: '1h' })
  );
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.post(
    '/webhooks/payments',
    express.raw({ type: 'application/json', limit: '1mb' }),
    asyncHandler(async (request, response) => {
      await handlePaymentWebhook(request, response, service, options.paymentWebhook);
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(createAuthMiddleware(options.apiKeys ?? options.apiKey));

  if (options.rateLimit) {
    if (options.redisUrl) {
      const limiter: RateLimiterHandle = createRedisRateLimiter({
        url: options.redisUrl,
        windowMs: options.rateLimit.windowMs,
        max: options.rateLimit.max
      });
      app.locals.rateLimiter = limiter;
      app.use(limiter.middleware);
    } else {
      app.use(createRateLimiter(options.rateLimit));
    }
  }

  if (options.idempotencyStore) {
    app.use(
      createIdempotencyMiddleware(options.idempotencyStore, {
        ttlMs: options.idempotencyTtlMs
      })
    );
  }

  const audit = async (
    request: Request,
    action: string,
    entityType: 'order' | 'payment' | 'driver' | 'batch' | 'system',
    entityId: string,
    details?: Record<string, unknown>
  ): Promise<void> => {
    await service.recordAudit({
      actor: request.auth?.label ?? 'anonymous',
      role: request.auth?.role ?? 'none',
      ip: request.ip,
      action,
      entityType,
      entityId,
      details
    });
  };

  app.get(
    '/health',
    asyncHandler(async (_request, response) => {
      response.json({
        status: 'ok',
        service: 'fast-order-dispatch',
        dispatchDriverId: DISPATCH_DRIVER_ID,
        dispatchDriverIds: service.getDispatchDriverIds(),
        storage: service.getStorageKind(),
        paymentProvider: paymentService.provider,
        pushEnabled: Boolean(options.push),
        queueSize: await service.getQueueSize(),
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      });
    })
  );

  app.get(
    '/ready',
    asyncHandler(async (_request, response) => {
      const ready = await service.isReady();
      response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
    })
  );

  app.get('/openapi.json', (_request: Request, response: Response) => {
    response.json(openApiSpec);
  });

  app.get('/docs', (_request: Request, response: Response) => {
    response.type('html').send(docsHtml);
  });

  app.get(
    '/drivers',
    asyncHandler(async (_request, response) => {
      response.json({ drivers: await service.getDrivers() });
    })
  );

  app.post(
    '/drivers',
    asyncHandler(async (request, response) => {
      const driver = parseDriver(request.body);
      await service.registerDriver(driver);
      await audit(request, 'driver.registered', 'driver', driver.id, {
        vehicle: driver.vehicle
      });
      response.status(201).json({
        driver: (await service.getDriver(driver.id)) ?? driver,
        dispatchDriverId: DISPATCH_DRIVER_ID
      });
    })
  );

  app.get(
    '/drivers/:id',
    asyncHandler(async (request, response) => {
      const driverId = routeParam(request, 'id');
      const driver = await service.getDriver(driverId);
      if (!driver) throw new NotFoundError(`Driver ${driverId} was not found`);
      response.json({ driver });
    })
  );

  app.patch(
    '/drivers/:id',
    asyncHandler(async (request, response) => {
      const patch = parseDriverPatch(request.body);
      const driver = await service.updateDriverDetails(routeParam(request, 'id'), patch);
      await audit(request, 'driver.updated', 'driver', driver.id, {
        fields: Object.keys(patch)
      });
      response.json({ driver });
    })
  );

  app.get(
    '/drivers/:id/earnings',
    asyncHandler(async (request, response) => {
      const summary = await service.getDriverEarnings(routeParam(request, 'id'));
      response.json(summary);
    })
  );

  app.get(
    '/payouts',
    requireRole('admin'),
    asyncHandler(async (request, response) => {
      const { limit, offset } = parsePagination(request.query);
      const driverId =
        request.query.driverId === undefined
          ? undefined
          : requiredString(request.query.driverId, 'driverId');
      const payouts = await service.getPayouts(driverId);
      response.json({
        payouts: payouts.slice(offset, offset + limit),
        total: payouts.length,
        limit,
        offset
      });
    })
  );

  app.post(
    '/payouts',
    requireRole('admin'),
    asyncHandler(async (request, response) => {
      if (!isRecord(request.body)) {
        throw new ValidationError('request body must be an object');
      }
      const payout = await service.createPayout({
        driverId: requiredString(request.body.driverId, 'driverId'),
        method: optionalString(request.body.method, 'method'),
        reference: optionalString(request.body.reference, 'reference'),
        note: optionalString(request.body.note, 'note')
      });
      await audit(request, 'driver.payout_paid', 'driver', payout.driverId, {
        payoutId: payout.id,
        amount: payout.amount,
        method: payout.method,
        reference: payout.reference
      });
      response.status(201).json({ payout });
    })
  );

  app.get('/push/public-key', (_request: Request, response: Response) => {
    if (!options.push) {
      response.status(503).json({ error: 'Push notifications are not configured' });
      return;
    }
    response.json({ publicKey: options.push.getPublicKey() });
  });

  app.post(
    '/push/subscribe',
    asyncHandler(async (request, response) => {
      if (!options.push) {
        throw new ConflictError('Push notifications are not configured');
      }
      if (!isRecord(request.body)) {
        throw new ValidationError('request body must be an object');
      }
      const driverId = requiredString(request.body.driverId, 'driverId');
      const driver = await service.getDriver(driverId);
      if (!driver) throw new NotFoundError(`Driver ${driverId} was not found`);
      const subscription = request.body.subscription;
      if (!isRecord(subscription)) {
        throw new ValidationError('subscription must be an object');
      }
      const keys = subscription.keys;
      if (!isRecord(keys)) {
        throw new ValidationError('subscription.keys must be an object');
      }
      const record = await options.push.subscribe(driverId, {
        endpoint: requiredString(subscription.endpoint, 'subscription.endpoint'),
        keys: {
          p256dh: requiredString(keys.p256dh, 'subscription.keys.p256dh'),
          auth: requiredString(keys.auth, 'subscription.keys.auth')
        }
      });
      await audit(request, 'push.subscribed', 'driver', driverId, {
        endpoint: record.endpoint.slice(0, 80)
      });
      response.status(201).json({
        subscription: { endpoint: record.endpoint, driverId }
      });
    })
  );

  app.post(
    '/push/unsubscribe',
    asyncHandler(async (request, response) => {
      if (!options.push) {
        throw new ConflictError('Push notifications are not configured');
      }
      if (!isRecord(request.body)) {
        throw new ValidationError('request body must be an object');
      }
      const endpoint = requiredString(request.body.endpoint, 'endpoint');
      const removed = await options.push.unsubscribe(endpoint);
      response.json({ removed });
    })
  );

  app.get(
    '/orders/pending',
    asyncHandler(async (_request, response) => {
      response.json({
        orders: await service.getPendingOrders(),
        queueSize: await service.getQueueSize(),
        dispatchDriverId: DISPATCH_DRIVER_ID
      });
    })
  );

  app.get(
    '/orders',
    asyncHandler(async (request, response) => {
      const { limit, offset } = parsePagination(request.query);
      const status = request.query.status === undefined
        ? undefined
        : parseOrderStatus(request.query.status);
      const { orders, total } = await service.getOrdersPage({ status, limit, offset });
      response.json({ orders, total, limit, offset });
    })
  );

  app.get(
    '/orders/:id',
    asyncHandler(async (request, response) => {
      const orderId = routeParam(request, 'id');
      const order = await service.getOrder(orderId);
      if (!order) throw new NotFoundError(`Order ${orderId} was not found`);
      response.json({ order });
    })
  );

  app.get(
    '/orders/:id/payments',
    asyncHandler(async (request, response) => {
      const orderId = routeParam(request, 'id');
      if (!(await service.getOrder(orderId))) {
        throw new NotFoundError(`Order ${orderId} was not found`);
      }
      response.json({ payments: await service.getPayments(orderId) });
    })
  );

  app.post(
    '/orders',
    asyncHandler(async (request, response) => {
      const order = parseOrder(request.body);
      const paymentMethod = isRecord(request.body)
        ? optionalString(request.body.paymentMethod, 'paymentMethod')
        : undefined;
      await service.addOrder(order, false);
      const transaction = await paymentService.processPayment(order, paymentMethod ?? 'card');
      await service.recordPayment(transaction);
      await service.updatePaymentStatus(order.id, transaction.status);
      await audit(request, 'order.created', 'order', order.id, {
        totalAmount: order.totalAmount,
        paymentStatus: transaction.status
      });
      await audit(request, 'payment.charge', 'payment', transaction.id, {
        orderId: order.id,
        amount: transaction.amount,
        status: transaction.status,
        provider: transaction.provider
      });

      if (transaction.status !== PaymentStatus.COMPLETED) {
        response.status(402).json({
          error: transaction.notes ?? 'Payment failed',
          order: await service.getOrder(order.id),
          transaction
        });
        return;
      }

      response.status(201).json({
        order: await service.getOrder(order.id),
        transaction,
        batch: null,
        assignedDriverId: null,
        assignedToTargetDriver: false,
        queueSize: await service.getQueueSize()
      });
    })
  );

  app.post(
    '/orders/:id/pay',
    asyncHandler(async (request, response) => {
      const orderId = routeParam(request, 'id');
      const order = await service.getOrder(orderId);
      if (!order) throw new NotFoundError(`Order ${orderId} was not found`);
      if (
        order.paymentStatus === PaymentStatus.COMPLETED ||
        order.paymentStatus === PaymentStatus.REFUNDED
      ) {
        throw new ConflictError(`Order ${orderId} is already paid`);
      }
      if (
        order.status === OrderStatus.CANCELLED ||
        order.status === OrderStatus.FAILED ||
        order.status === OrderStatus.DELIVERED
      ) {
        throw new ConflictError(`Order ${orderId} is ${order.status} and cannot be paid`);
      }

      const method = isRecord(request.body)
        ? optionalString(request.body.method, 'method')
        : undefined;
      const transaction = await paymentService.processPayment(order, method ?? 'card');
      await service.recordPayment(transaction);
      await service.updatePaymentStatus(orderId, transaction.status);
      await audit(request, 'payment.charge_retry', 'payment', transaction.id, {
        orderId,
        amount: transaction.amount,
        status: transaction.status,
        provider: transaction.provider
      });

      if (transaction.status !== PaymentStatus.COMPLETED) {
        response.status(402).json({
          error: transaction.notes ?? 'Payment failed',
          order: await service.getOrder(orderId),
          transaction
        });
        return;
      }

      response.json({
        order: await service.getOrder(orderId),
        transaction,
        batch: null,
        assignedDriverId: null,
        assignedToTargetDriver: false,
        queueSize: await service.getQueueSize()
      });
    })
  );

  app.post(
    '/orders/:id/refund',
    requireRole('admin'),
    asyncHandler(async (request, response) => {
      const orderId = routeParam(request, 'id');
      const order = await service.getOrder(orderId);
      if (!order) throw new NotFoundError(`Order ${orderId} was not found`);
      if (order.paymentStatus !== PaymentStatus.COMPLETED) {
        throw new ConflictError(`Order ${orderId} has no completed payment to refund`);
      }

      const method = isRecord(request.body)
        ? optionalString(request.body.method, 'method')
        : undefined;
      const payments = await service.getPayments(orderId);
      const originalCharge = [...payments]
        .reverse()
        .find(
          (payment) =>
            payment.kind !== 'refund' && payment.status === PaymentStatus.COMPLETED
        );
      const transaction = await paymentService.refund(
        order,
        method ?? 'card',
        originalCharge?.providerTransactionId
      );
      await service.recordPayment(transaction);
      await audit(request, 'payment.refund', 'payment', transaction.id, {
        orderId,
        amount: transaction.amount,
        status: transaction.status,
        provider: transaction.provider
      });

      if (transaction.status !== PaymentStatus.COMPLETED) {
        response.status(402).json({
          error: transaction.notes ?? 'Refund failed',
          order: await service.getOrder(orderId),
          transaction
        });
        return;
      }

      await service.updatePaymentStatus(orderId, PaymentStatus.REFUNDED);
      response.json({
        order: await service.getOrder(orderId),
        transaction
      });
    })
  );

  app.patch(
    '/orders/:id/status',
    asyncHandler(async (request, response) => {
      const status = isRecord(request.body)
        ? parseOrderStatus(request.body.status)
        : parseOrderStatus(undefined);
      const order = await service.updateOrderStatus(routeParam(request, 'id'), status);
      await audit(request, 'order.status_changed', 'order', order.id, { status });
      if (order.status === OrderStatus.READY) {
        await service.processBatch().catch((error) => {
          logger.warn('ready_dispatch_failed', {
            orderId: order.id,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      response.json({ order: await service.getOrder(order.id) });
    })
  );

  app.post(
    '/orders/:id/decline',
    asyncHandler(async (request, response) => {
      const driverId = isRecord(request.body)
        ? optionalString(request.body.driverId, 'driverId')
        : undefined;
      const result = await service.declineOrder(routeParam(request, 'id'), driverId);
      await audit(request, 'order.declined', 'order', result.order.id, {
        driverId: driverId ?? result.driver?.id
      });
      response.json(result);
    })
  );

  app.get(
    '/batches',
    asyncHandler(async (request, response) => {
      const { limit, offset } = parsePagination(request.query);
      const batches = await service.getBatches();
      response.json({
        batches: batches.slice(offset, offset + limit),
        total: batches.length,
        limit,
        offset
      });
    })
  );

  app.get(
    '/metrics',
    asyncHandler(async (_request, response) => {
      response.json(await service.getMetrics());
    })
  );

  app.get(
    '/metrics/prometheus',
    asyncHandler(async (_request, response) => {
      const usage = process.memoryUsage();
      response
        .type('text/plain; version=0.0.4; charset=utf-8')
        .send(
          renderPrometheusMetrics(await service.getMetrics(), {
            uptimeSeconds: Math.round(process.uptime()),
            memoryRssBytes: usage.rss,
            memoryHeapUsedBytes: usage.heapUsed
          })
        );
    })
  );

  app.get(
    '/audit',
    requireRole('admin'),
    asyncHandler(async (request, response) => {
      const { limit, offset } = parsePagination(request.query);
      const { entries, total } = await service.getAuditLog(limit, offset);
      response.json({ entries, total, limit, offset });
    })
  );

  app.post(
    '/dispatch/process',
    asyncHandler(async (request, response) => {
      const batch = await service.processBatch();
      if (batch) {
        await audit(request, 'dispatch.processed', 'batch', batch.id, {
          orderIds: batch.orderIds,
          driverId: batch.driverId
        });
      }
      response.json({ batch, queueSize: await service.getQueueSize() });
    })
  );

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
      response.status(error.statusCode).json({
        error:
          error.statusCode >= 500 ? 'Internal server error' : error.message
      });
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
    response.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export function createPaymentService(config: AppConfig): PaymentService {
  if (config.paymentProvider === 'stripe' && config.stripeSecretKey) {
    return new PaymentService(
      new StripePaymentGateway({
        secretKey: config.stripeSecretKey,
        apiBase: config.stripeApiBase
      }),
      'stripe'
    );
  }
  if (config.paymentProvider === 'http' && config.paymentGatewayUrl) {
    return new PaymentService(
      new HttpPaymentGateway({
        url: config.paymentGatewayUrl,
        apiKey: config.paymentGatewayApiKey
      }),
      'http'
    );
  }
  return new PaymentService();
}

function mapProviderStatus(value: unknown): PaymentStatus | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.toLowerCase()) {
    case 'succeeded':
    case 'paid':
    case 'completed':
      return PaymentStatus.COMPLETED;
    case 'failed':
    case 'canceled':
    case 'cancelled':
    case 'declined':
      return PaymentStatus.FAILED;
    case 'refunded':
      return PaymentStatus.REFUNDED;
    case 'processing':
    case 'pending':
      return PaymentStatus.PROCESSING;
    default:
      return undefined;
  }
}

function extractWebhookUpdate(
  provider: 'mock' | 'http' | 'stripe',
  payload: Record<string, unknown>
): { providerTransactionId: string; status: PaymentStatus } | undefined {
  if (provider === 'stripe') {
    const type = typeof payload.type === 'string' ? payload.type : '';
    const data = isRecord(payload.data) && isRecord(payload.data.object)
      ? payload.data.object
      : undefined;
    if (!data) return undefined;
    const providerTransactionId =
      typeof data.payment_intent === 'string'
        ? data.payment_intent
        : typeof data.id === 'string'
          ? data.id
          : undefined;
    if (!providerTransactionId) return undefined;

    if (type === 'payment_intent.succeeded') {
      return { providerTransactionId, status: PaymentStatus.COMPLETED };
    }
    if (type === 'payment_intent.payment_failed' || type === 'payment_intent.canceled') {
      return { providerTransactionId, status: PaymentStatus.FAILED };
    }
    if (type === 'charge.refunded' || type === 'refund.succeeded') {
      return { providerTransactionId, status: PaymentStatus.REFUNDED };
    }
    return undefined;
  }

  const providerTransactionId =
    typeof payload.transactionId === 'string'
      ? payload.transactionId
      : typeof payload.providerTransactionId === 'string'
        ? payload.providerTransactionId
        : typeof payload.id === 'string'
          ? payload.id
          : undefined;
  const status = mapProviderStatus(payload.status);
  if (!providerTransactionId || !status) return undefined;
  return { providerTransactionId, status };
}

async function handlePaymentWebhook(
  request: Request,
  response: Response,
  service: BatchProcessingService,
  options: PaymentWebhookOptions | undefined
): Promise<void> {
  const provider = options?.provider ?? 'mock';
  if (provider === 'mock' || !options?.secret) {
    response.status(provider === 'mock' ? 404 : 503).json({
      error: provider === 'mock' ? 'Payment webhook is disabled' : 'Webhook secret is not configured'
    });
    return;
  }

  const rawBody = Buffer.isBuffer(request.body)
    ? request.body
    : typeof request.body === 'string'
      ? Buffer.from(request.body)
      : Buffer.alloc(0);
  const verified =
    provider === 'stripe'
      ? verifyStripeSignature(rawBody, request.header('stripe-signature'), options.secret)
      : verifyHmacSignature(
          rawBody,
          request.header('x-webhook-signature') ?? request.header('x-signature'),
          options.secret
        );
  if (!verified) {
    response.status(400).json({ error: 'Invalid webhook signature' });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error('invalid payload');
    payload = parsed;
  } catch {
    response.status(400).json({ error: 'Invalid webhook payload' });
    return;
  }

  const update = extractWebhookUpdate(provider, payload);
  if (!update) {
    response.json({ received: true, matched: false });
    return;
  }

  const payment = await service.findPaymentByProviderTransactionId(update.providerTransactionId);
  if (!payment) {
    response.json({ received: true, matched: false });
    return;
  }

  const updated: PaymentTransaction = {
    ...payment,
    status: update.status,
    processedAt: new Date()
  };
  await service.recordPayment(updated);
  if (updated.kind !== 'refund') {
    await service.updatePaymentStatus(updated.orderId, update.status);
    if (update.status === PaymentStatus.COMPLETED) {
      const order = await service.getOrder(updated.orderId);
      if (order?.status === OrderStatus.READY && !order.queuedAt) {
        await service.enqueueOrder(order.id).catch((error) => {
          if (!(error instanceof ConflictError)) throw error;
        });
      }
    }
  } else if (update.status === PaymentStatus.REFUNDED) {
    await service.updatePaymentStatus(updated.orderId, PaymentStatus.REFUNDED);
  }
  await service.recordAudit({
    actor: 'payment-provider',
    role: 'provider',
    ip: request.ip,
    action: 'payment.webhook',
    entityType: 'payment',
    entityId: updated.id,
    details: {
      provider,
      providerTransactionId: update.providerTransactionId,
      status: update.status
    }
  });
  response.json({ received: true, matched: true });
}

const store = createDispatchStore(config);
export const dispatchService = new BatchProcessingService(config.dispatchBatchSize, store, {
  dispatchDriverIds: config.dispatchDriverIds,
  driverSharePercent: config.driverSharePercent
});
export const paymentService = createPaymentService(config);
export const pushNotifier = createPushNotifier(store, config);
export const app = createDispatchApp({
  service: dispatchService,
  paymentService,
  apiKeys: config.apiKeys.length > 0 ? config.apiKeys : config.apiKey,
  corsOrigins: config.corsOrigins,
  rateLimit: { windowMs: config.rateLimitWindowMs, max: config.rateLimitMax },
  redisUrl: config.redisUrl,
  trustProxy: config.trustProxy,
  idempotencyStore: store,
  idempotencyTtlMs: config.idempotencyTtlMs,
  paymentWebhook: {
    provider: config.paymentProvider,
    secret:
      config.paymentProvider === 'stripe'
        ? config.stripeWebhookSecret
        : config.paymentWebhookSecret
  },
  push: pushNotifier
});

export interface StartServerOptions {
  port?: number;
  host?: string;
}

export async function startServer(
  options: StartServerOptions = {}
): Promise<{ server: ReturnType<typeof createServer>; io: Awaited<ReturnType<typeof attachRealtime>> }> {
  const port = options.port ?? Number(process.env.PORT ?? 3000);
  const host = options.host ?? process.env.HOST ?? '0.0.0.0';

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ValidationError('PORT must be an integer between 0 and 65535');
  }

  await dispatchService.initialize();
  pushNotifier.bindService(dispatchService);

  const server = createServer(app);
  const io = await attachRealtime(server, dispatchService, {
    apiKeys: config.apiKeys.length > 0 ? config.apiKeys : config.apiKey,
    redisUrl: config.redisUrl,
    corsOrigins: config.corsOrigins
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
      nodeEnv: config.nodeEnv,
      storage: dispatchService.getStorageKind(),
      cors:
        config.corsOrigins.length === 1 && config.corsOrigins[0] === '*'
          ? '*'
          : `${config.corsOrigins.length} origin(s)`,
      auth: config.apiKeys.length > 0 ? `${config.apiKeys.length} api key(s)` : 'disabled',
      rateLimit:
        config.rateLimitMax > 0
          ? `${config.rateLimitMax}/${config.rateLimitWindowMs}ms`
          : 'disabled',
      rateLimitBackend: config.redisUrl ? 'redis' : 'memory',
      paymentProvider: config.paymentProvider,
      driverSharePercent: config.driverSharePercent,
      push: Boolean(config.vapidPublicKey && config.vapidPrivateKey),
      redis: Boolean(config.redisUrl)
    });
    logger.info('dispatch_restricted', { driverIds: dispatchService.getDispatchDriverIds() });
  });

  return { server, io };
}

if (require.main === module) {
  void startServer()
    .then(({ io }) => {
      const shutdown = (): void => {
        logger.info('shutting_down');
        dispatchService.stopAutoProcessing();
        const limiter = app.locals.rateLimiter as RateLimiterHandle | undefined;
        io.close(async () => {
          if (limiter) await limiter.close().catch(() => undefined);
          await dispatchService.close().catch((error) => {
            logger.error('shutdown_failed', {
              error: error instanceof Error ? error.message : String(error)
            });
          });
          process.exit(0);
        });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((error) => {
      logger.error('startup_failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      process.exit(1);
    });
}
