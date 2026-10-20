# fast-order-dispatch

Order dispatch service with batch processing, payment coordination, lifecycle tracking, realtime job management, and optional SQLite persistence.

## Features

- Batches up to 3 orders and assigns them to the configured driver pool (default driver ID `1388246780`)
- Nearest-neighbour route optimization using Haversine distance
- Delivery ETA = travel time + longest restaurant preparation time in the batch
- Full order lifecycle with guarded transitions and automatic driver release
- Payments on order creation with retry, refund, and a persisted transaction ledger
- Pluggable payment providers: mock, generic HTTP gateway, or Stripe PaymentIntents
- Signed payment webhooks (Stripe or HMAC-SHA256) that reconcile the ledger
- Idempotency keys for order creation, retry, refund, driver registration, and dispatch
- Multiple API keys with roles (`admin`, `operator`, `viewer`) and per-key quotas
- Audit log for money and lifecycle changes (admin endpoint)
- Socket.IO realtime events with optional Redis fan-out across instances
- Per-process or Redis-backed distributed rate limiting, security headers, and request logging
- Pagination and status filtering for orders and batches
- Optional SQLite persistence using the built-in `node:sqlite` module
- OpenAPI document at `/openapi.json` and Swagger UI at `/docs`
- Metrics endpoint, readiness probe, and Docker deployment

## Requirements

- Node.js 24 or newer
- npm
- Docker (optional, for the container workflow)

## Quick start

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

The service listens on `HOST`/`PORT` from the environment (defaults to `0.0.0.0:3000`).
Browse `http://127.0.0.1:3000/docs` for the interactive API reference.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | `*` | CORS origin for HTTP and Socket.IO |
| `API_KEY` | unset | Requires this key on protected routes and Socket.IO handshakes |
| `RATE_LIMIT_MAX` | `0` | Requests allowed per window per IP (`0` disables limiting) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds |
| `TRUST_PROXY` | unset | Set to `1`/`true` behind a reverse proxy |
| `DISPATCH_DRIVER_IDS` | `1388246780` | Comma-separated drivers eligible for dispatch |
| `DB_PATH` | unset | Enables SQLite persistence at this file path |
| `REDIS_URL` | unset | Enables the Socket.IO Redis adapter for multiple instances |
| `AUTO_PROCESS_INTERVAL_MS` | unset | Runs the dispatcher automatically at this interval (minimum 100) |
| `API_KEYS` | unset | Comma-separated `token:role[:limit]` entries |
| `IDEMPOTENCY_TTL_MS` | `86400000` | How long idempotency keys are retained |
| `PAYMENT_PROVIDER` | `mock` | `mock`, `http`, or `stripe` |
| `PAYMENT_GATEWAY_URL` | unset | Required when `PAYMENT_PROVIDER=http` |
| `PAYMENT_GATEWAY_API_KEY` | unset | Bearer token for the HTTP gateway |
| `PAYMENT_WEBHOOK_SECRET` | unset | HMAC secret for generic webhooks |
| `STRIPE_SECRET_KEY` | unset | Required when `PAYMENT_PROVIDER=stripe` |
| `STRIPE_WEBHOOK_SECRET` | unset | Stripe signing secret for `/webhooks/payments` |
| `STRIPE_API_BASE` | `https://api.stripe.com` | Override for Stripe-compatible APIs |

Without `DB_PATH` all state is kept in memory and is lost on restart (audit entries and idempotency keys included).

## Authentication

When `API_KEY` or `API_KEYS` is set, all routes except `/health`, `/ready`, `/openapi.json`, `/docs`, and `/webhooks/payments` require one of:

```bash
curl -H "x-api-key: $API_KEY" http://127.0.0.1:3000/drivers
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3000/drivers
```

`API_KEYS` supports multiple keys with roles and an optional per-key quota inside the rate-limit window:

```text
API_KEYS=admin-token:admin:1000,ops-token:operator:300,report-token:viewer
```

- `admin` can do everything, including refunds and `GET /audit`
- `operator` can create/update orders, drivers, payments, and dispatch
- `viewer` is read-only

The legacy `API_KEY` is treated as an admin key. Socket.IO clients pass a key through the handshake:

```js
import { io } from 'socket.io-client';

const socket = io('http://127.0.0.1:3000', { auth: { token: process.env.API_KEY } });
```

Rate limiting returns `429` with `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` headers. Counters are per process by default and shared across instances when `REDIS_URL` is set; if Redis is unreachable the limiter falls back to local counters.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Service status, storage mode, queue size |
| `GET` | `/ready` | Readiness probe (checks storage) |
| `GET` | `/openapi.json` | OpenAPI 3 document |
| `GET` | `/docs` | Swagger UI |
| `GET` | `/drivers` | List drivers |
| `POST` | `/drivers` | Register a driver |
| `GET` | `/drivers/:id` | Fetch one driver |
| `PATCH` | `/drivers/:id` | Update location, status, capacity, or rating |
| `GET` | `/orders` | List orders (`status`, `limit`, `offset`) |
| `GET` | `/orders/pending` | Orders waiting in the dispatch queue |
| `GET` | `/orders/:id` | Fetch one order |
| `POST` | `/orders` | Create an order, charge it, and try to dispatch |
| `POST` | `/orders/:id/pay` | Retry payment for an unpaid order |
| `POST` | `/orders/:id/refund` | Refund a completed payment |
| `GET` | `/orders/:id/payments` | Payment ledger for an order |
| `PATCH` | `/orders/:id/status` | Advance the order lifecycle |
| `POST` | `/dispatch/process` | Run one dispatch cycle manually |
| `GET` | `/batches` | List batch assignments (`limit`, `offset`) |
| `GET` | `/metrics` | Dispatch metrics |
| `GET` | `/audit` | Audit log (admin only) |
| `POST` | `/webhooks/payments` | Signed payment-provider webhook |

Errors use `{ "error": "message" }` with status `400`, `401`, `402`, `404`, `409`, `429`, or `500`. Every response carries an `X-Request-Id` header that is also written to the structured request log.

### Register a driver

```bash
curl -X POST http://127.0.0.1:3000/drivers \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "1388246780",
    "name": "Target Driver",
    "phone": "0000000000",
    "vehicle": "motorcycle",
    "licensePlate": "TARGET",
    "currentLatitude": 13.7563,
    "currentLongitude": 100.5018,
    "maxOrdersPerBatch": 3
  }'
```

Only drivers listed in `DISPATCH_DRIVER_IDS` receive orders. Other drivers are stored but never selected.

### Update a driver

```bash
curl -X PATCH http://127.0.0.1:3000/drivers/1388246780 \
  -H 'Content-Type: application/json' \
  -d '{"currentLatitude":13.8,"currentLongitude":100.6,"status":"ON_BREAK"}'
```

Updatable fields: `currentLatitude`/`currentLongitude` (send both), `status` (`AVAILABLE`, `ON_BREAK`, `OFFLINE`), `isAvailable`, `maxOrdersPerBatch`, `rating` (0-5). Status cannot be changed while the driver has active orders; location updates are always allowed. `BUSY` is managed by the dispatcher.

### Submit an order

```bash
curl -X POST http://127.0.0.1:3000/orders \
  -H 'Content-Type: application/json' \
  -d '{
    "totalAmount": 100,
    "deliveryFee": 10,
    "restaurant": {
      "id": "r1",
      "name": "R1",
      "address": "A",
      "latitude": 13.75,
      "longitude": 100.5,
      "phone": "0000000000",
      "preparationTime": 10
    },
    "customer": {
      "id": "c1",
      "name": "C1",
      "phone": "0000000000",
      "address": "B",
      "latitude": 13.76,
      "longitude": 100.51
    },
    "items": [{ "id": "i1", "name": "X", "quantity": 1, "price": 100 }]
  }'
```

A successful call returns `201` with the order, payment transaction, batch, `assignedDriverId`, `assignedToTargetDriver`, and queue size. If no eligible driver is available or has capacity, the order stays in `GET /orders/pending`.

### Order lifecycle

```text
PENDING ──► ASSIGNED ──► PICKED_UP ──► IN_DELIVERY ──► DELIVERED
   │            │             │              │
   ├──► CANCELLED / FAILED ◄──┴──────────────┘
```

| From | To |
| --- | --- |
| `PENDING` | `CANCELLED`, `FAILED` |
| `ASSIGNED` | `PICKED_UP`, `CANCELLED`, `FAILED` |
| `PICKED_UP` | `IN_DELIVERY`, `CANCELLED`, `FAILED` |
| `IN_DELIVERY` | `DELIVERED`, `FAILED` |
| `DELIVERED`, `CANCELLED`, `FAILED` | none (terminal) |

```bash
curl -X PATCH http://127.0.0.1:3000/orders/<id>/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"PICKED_UP"}'
```

Invalid transitions return `409`. When all orders assigned to a driver reach a terminal state, the driver becomes `AVAILABLE` again and can receive the next batch. Delivered orders increase `totalDeliveries` and a batch gets `completedAt`.

### Idempotency

Send `Idempotency-Key` on `POST /orders`, `/orders/:id/pay`, `/orders/:id/refund`, `/drivers`, and `/dispatch/process`. The response is stored and replayed for the same key and body (default 24 hours, also persisted in SQLite). Reusing a key with a different body returns `409`, and replays include `Idempotent-Replayed: true`.

```bash
curl -X POST http://127.0.0.1:3000/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-123' \
  -d @order.json
```

### Payments

`POST /orders` runs the configured gateway automatically (overridable with `paymentMethod`). The default mock fails when `totalAmount` is zero; the order is stored as `PENDING` with `paymentStatus: "FAILED"`, is not queued, and the response is `402`. Every attempt is stored in the ledger.

Set `PAYMENT_PROVIDER=http` to call an internal gateway, or `PAYMENT_PROVIDER=stripe` to create Stripe PaymentIntents (the `paymentMethod` value is used as the Stripe payment method id). Webhook events are verified and applied to the ledger at `POST /webhooks/payments`.

Retry:

```bash
curl -X POST http://127.0.0.1:3000/orders/<id>/pay \
  -H 'Content-Type: application/json' \
  -d '{"method":"card"}'
```

Retrying an already paid order returns `409`.

Refund a completed payment:

```bash
curl -X POST http://127.0.0.1:3000/orders/<id>/refund \
  -H 'Content-Type: application/json' \
  -d '{"method":"card"}'
```

A refund creates a negative `refund` transaction, sets `paymentStatus: "REFUNDED"`, and is excluded from `totalRevenue`. Orders without a completed payment return `409`.

```bash
curl http://127.0.0.1:3000/orders/<id>/payments
```

The gateway is defined by the `PaymentGateway` interface in `src/services/PaymentService.ts`; replace `MockPaymentGateway` with a real provider adapter before production use.

### Pagination and filtering

```bash
curl 'http://127.0.0.1:3000/orders?status=DELIVERED&limit=20&offset=0'
curl 'http://127.0.0.1:3000/batches?limit=20&offset=0'
```

`limit` is 1-200 (default 50) and `offset` is zero or greater. Responses include `total`, `limit`, and `offset`.

### Metrics

`GET /metrics` returns:

| Field | Meaning |
| --- | --- |
| `totalOrdersProcessed` | Orders that have been assigned to a driver |
| `totalBatchesCreated` | Number of batches produced |
| `averageProcessingTime` | Mean milliseconds from order creation to assignment |
| `averageDeliveryTime` | Mean milliseconds from assignment to delivery |
| `successRate` | Delivered / (delivered + cancelled + failed), `0` when no terminal orders |
| `totalRevenue` | Sum of delivered order amounts, excluding refunded orders |
| `activeDrivers` | Available drivers |
| `pendingOrders` | Current queue size |
| `timestamp` | Snapshot time |

## Realtime

The server exposes Socket.IO on the same port. Events:

| Event | Payload |
| --- | --- |
| `state` | `{ queueSize, drivers }` sent to each new connection |
| `order:created` | Order |
| `order:queued` | Order |
| `order:status` | `{ previousStatus, order }` |
| `payment:updated` | `{ status, order }` |
| `payment:recorded` | Payment transaction |
| `batch:assigned` | Batch |
| `batch:completed` | Batch |
| `driver:updated` | Driver |

```js
import { io } from 'socket.io-client';

const socket = io('http://127.0.0.1:3000', { auth: { token: process.env.API_KEY } });
socket.on('batch:assigned', (batch) => console.log(batch));
socket.on('order:status', ({ order }) => console.log(order.status));
```

Set `REDIS_URL` to attach the Redis adapter and share events between multiple service instances. Without it, each instance only broadcasts to its own clients.

## Persistence

Set `DB_PATH` to persist orders, drivers, batches, and payment transactions in SQLite:

```bash
DB_PATH=./data/dispatch.sqlite3 npm start
```

The store uses the built-in `node:sqlite` module (no native dependency), enables WAL mode, and reloads state at startup. Pending orders are re-queued in creation time order.

## Docker

```bash
docker compose up --build
```

This starts the API on port `3000` with a SQLite volume and a Redis instance for realtime fan-out. Provide `API_KEY` through the environment or a local `.env` file used by Compose:

```bash
API_KEY=change-me docker compose up --build
```

Build the image alone with `docker build -t fast-order-dispatch .`. The image runs as the unprivileged `node` user and ships a `/ready` health check.

## Auto dispatch

Set `AUTO_PROCESS_INTERVAL_MS=1000` to run a dispatch cycle on an interval instead of relying on `POST /orders` or `POST /dispatch/process`.

## Scripts

| Command | Description |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run dev` | Run from source with `ts-node` |
| `npm run lint` | Run ESLint over `src/` and `test/` |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the Jest suite |
| `npm run test:coverage` | Run Jest with coverage thresholds |

## Tests

The suite covers distance math, batch selection and capacity, multi-driver selection, order lifecycle transitions, driver release and updates, payments and refunds, SQLite restore, realtime broadcasts, Redis fan-out (when `REDIS_URL` is set), security middleware, configuration, pagination, and the HTTP API. It also covers idempotency replay/conflict, role and quota enforcement, audit entries, and webhook signatures. CI runs `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run test:coverage` on Node 24 with a Redis service.

## Limitations

- The default payment gateway is a mock. Real charges require `PAYMENT_PROVIDER=http` or `stripe` plus provider credentials and webhook secrets.
- Authentication uses static API keys with roles. There are no user accounts, token rotation, or external identity provider integration.
- Per-key quotas are enforced inside the rate-limit window only; they are not billing quotas.
- Redis distributes rate-limit counters and realtime events, but orders still live in the local store. SQLite persistence assumes a single writer instance; horizontal scaling requires a shared database.
- Webhook reconciliation matches by provider transaction id. Orders created before a provider id is recorded must be retried or reconciled manually.
