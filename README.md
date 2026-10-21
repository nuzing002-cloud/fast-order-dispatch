# fast-order-dispatch

Order dispatch service with batch processing, payment coordination, lifecycle tracking, realtime job management, and horizontally scalable PostgreSQL persistence.

## Features

- Batches up to 4 orders and assigns them to the configured driver pool (default driver ID `1388246780`)
- Dispatches only once the restaurant marks an order `READY`, nearest orders first
- Keeps feeding queued orders to a busy driver that still has free capacity, so work continues before the last delivery finishes
- Nearest-neighbour route optimization using Haversine distance
- Delivery ETA = travel time + longest restaurant preparation time in the batch
- Full order lifecycle with guarded transitions and automatic driver release
- Driver earnings ledger (delivery fee share), admin payouts, and payout history
- Drivers can decline an assigned order (returned to the queue) or pause new assignments
- Web Push notifications for new batches (VAPID, service worker) plus Socket.IO realtime
- Payments on order creation with retry, refund, and a persisted transaction ledger
- Pluggable payment providers: mock, generic HTTP gateway, or Stripe PaymentIntents
- Signed payment webhooks (Stripe or HMAC-SHA256) that reconcile the ledger
- Idempotency keys for order creation, retry, refund, driver registration, and dispatch
- Multiple API keys with roles (`admin`, `operator`, `viewer`) and per-key quotas
- Audit log for money and lifecycle changes (admin endpoint)
- Socket.IO realtime events with Redis fan-out across instances
- Redis-backed distributed rate limiting, security headers, and request logging
- Pagination and status filtering for orders and batches
- PostgreSQL persistence with forward-only migrations and multi-instance dispatch
- Embedded PGlite database for single-process local development and tests
- Stateless HTTP instances: concurrent dispatch is safe across replicas using `FOR UPDATE SKIP LOCKED`
- OpenAPI document at `/openapi.json` and self-hosted Swagger UI at `/docs` (works offline)
- JSON metrics at `/metrics` and Prometheus exposition at `/metrics/prometheus`
- Readiness probe and Docker deployment

## Requirements

- Node.js 24 or newer
- npm
- PostgreSQL 16 or newer (production)
- Redis 7 or newer (production, for realtime fan-out and shared rate limits)
- Docker (optional, for the container workflow)

## Quick start

```bash
npm ci
cp .env.example .env

# Full stack with PostgreSQL and Redis:
docker compose up -d postgres redis
npm run build
DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:5432/dispatch \
  REDIS_URL=redis://127.0.0.1:6379 npm start

# Or run from source with an embedded single-process PGlite database:
PGLITE_DATA_DIR=./data/pglite npm run dev
```

The service listens on `HOST`/`PORT` from the environment (defaults to `0.0.0.0:3000`).
Browse `http://127.0.0.1:3000/docs` for the interactive API reference.

## Web UI

The service ships a dependency-free web console in `public/`:

| Path | Purpose |
| --- | --- |
| `/` | Service status and links |
| `/customer.html` | Create an order, pay, track status, retry payment, cancel |
| `/driver.html` | Driver console: status, location, assigned jobs, delivery transitions |
| `/admin.html` | Metrics, orders, drivers, batches, dispatch, refunds, audit log |
| `/docs` | Swagger UI |

If `API_KEY` or `API_KEYS` is configured, enter a key in the top bar of any page. The key is kept in `localStorage` for that browser only and sent as `x-api-key`; Socket.IO uses it as the handshake token. Mutating screens need an `admin` or `operator` key, and `/audit` needs `admin`.

The console is an internal operations tool: it has no user accounts or server-side sessions. Put it behind your VPN, reverse-proxy auth, or an allowlist before exposing it publicly. The default payment provider stays `mock`; configure `http` or `stripe` for real charges.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | Set to `production` to enable startup safety checks |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins for HTTP and Socket.IO; `*` is development only |
| `API_KEY` | unset | Requires this key on protected routes and Socket.IO handshakes |
| `RATE_LIMIT_MAX` | `0` | Requests allowed per window per IP (`0` disables limiting; production requires > 0) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds |
| `TRUST_PROXY` | unset | Set to `1`/`true` behind a reverse proxy |
| `DISPATCH_DRIVER_IDS` | `1388246780` | Comma-separated drivers eligible for dispatch |
| `DISPATCH_BATCH_SIZE` | `4` | Maximum orders per dispatch batch (1-50) |
| `DRIVER_SHARE_PERCENT` | `80` | Share of the delivery fee credited to the driver (0-100) |
| `VAPID_PUBLIC_KEY` | unset | Web Push public key; required in production |
| `VAPID_PRIVATE_KEY` | unset | Web Push private key; required in production |
| `VAPID_SUBJECT` | `mailto:ops@example.com` | VAPID contact subject |
| `DATABASE_URL` | unset | PostgreSQL connection string; required in production |
| `DATABASE_SSL` | `false` | Set `true` to require verified TLS; add a private CA with `NODE_EXTRA_CA_CERTS` |
| `DATABASE_POOL_MAX` | `10` | Maximum PostgreSQL pool size per instance |
| `PGLITE_DATA_DIR` | unset | Embedded PGlite data directory for local development; rejected in production |
| `REDIS_URL` | unset | Enables the Socket.IO Redis adapter and shared rate limits; required in production |
| `AUTO_PROCESS_INTERVAL_MS` | unset | Runs the dispatcher automatically at this interval (minimum 100) |
| `API_KEYS` | unset | Comma-separated `token:role[:limit]` entries |
| `IDEMPOTENCY_TTL_MS` | `86400000` | How long idempotency keys are retained |
| `PAYMENT_PROVIDER` | `mock` | `mock`, `http`, or `stripe` (production requires `http` or `stripe`) |
| `PAYMENT_GATEWAY_URL` | unset | Required when `PAYMENT_PROVIDER=http` |
| `PAYMENT_GATEWAY_API_KEY` | unset | Bearer token for the HTTP gateway |
| `PAYMENT_WEBHOOK_SECRET` | unset | HMAC secret for generic webhooks |
| `STRIPE_SECRET_KEY` | unset | Required when `PAYMENT_PROVIDER=stripe` |
| `STRIPE_WEBHOOK_SECRET` | unset | Stripe signing secret for `/webhooks/payments` |
| `STRIPE_API_BASE` | `https://api.stripe.com` | Override for Stripe-compatible APIs |

Without database configuration all state is kept in memory and is lost on restart (audit entries and idempotency keys included). This mode is intended for tests and throwaway development only. Set `DATABASE_URL` for PostgreSQL, or `PGLITE_DATA_DIR` for persistent local development without a server.

When `NODE_ENV=production`, startup fails fast unless auth keys, explicit CORS origins, a positive rate limit, a non-mock payment provider with a webhook secret, `DATABASE_URL`, `REDIS_URL`, and `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are configured. Production also rejects `PGLITE_DATA_DIR` and the removed `DB_PATH` setting.

Generate VAPID keys once with `npx web-push generate-vapid-keys` and keep them stable; with no keys in development the server generates an ephemeral pair at startup. Browser push requires a secure context (HTTPS or `localhost`).

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
| `PATCH` | `/drivers/:id` | Update location, status, capacity, rating, or `acceptsNewOrders` |
| `GET` | `/drivers/:id/earnings` | Earnings summary and payout history |
| `GET` | `/payouts` | List payouts (admin) |
| `POST` | `/payouts` | Pay out all pending earnings for a driver (admin) |
| `GET` | `/push/public-key` | VAPID public key for browser subscriptions |
| `POST` | `/push/subscribe` | Register a driver's browser push subscription |
| `POST` | `/push/unsubscribe` | Remove a browser push subscription |
| `GET` | `/orders` | List orders (`status`, `limit`, `offset`) |
| `GET` | `/orders/pending` | Orders waiting in the dispatch queue |
| `GET` | `/orders/:id` | Fetch one order |
| `POST` | `/orders` | Create an order, charge it, and try to dispatch |
| `POST` | `/orders/:id/pay` | Retry payment for an unpaid order |
| `POST` | `/orders/:id/refund` | Refund a completed payment |
| `GET` | `/orders/:id/payments` | Payment ledger for an order |
| `PATCH` | `/orders/:id/status` | Advance the order lifecycle |
| `POST` | `/orders/:id/decline` | Driver declines an assigned order; it returns to the queue |
| `POST` | `/dispatch/process` | Run one dispatch cycle manually |
| `GET` | `/batches` | List batch assignments (`limit`, `offset`) |
| `GET` | `/metrics` | Dispatch metrics (JSON) |
| `GET` | `/metrics/prometheus` | Dispatch and process metrics (Prometheus text) |
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
    "maxOrdersPerBatch": 4
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

A successful call returns `201` with the order, payment transaction, and queue size. New orders stay `PENDING` until the restaurant marks them `READY`; only then are they queued and dispatched.

### Order lifecycle

```text
PENDING ──► READY ──► ASSIGNED ──► PICKED_UP ──► IN_DELIVERY ──► DELIVERED
   │          │           │             │              │
   ├──► CANCELLED / FAILED ◄┴────────────┴──────────────┘
```

| From | To |
| --- | --- |
| `PENDING` | `READY`, `CANCELLED`, `FAILED` |
| `READY` | `CANCELLED`, `FAILED` (dispatch assigns automatically) |
| `ASSIGNED` | `PICKED_UP`, `CANCELLED`, `FAILED` |
| `PICKED_UP` | `IN_DELIVERY`, `CANCELLED`, `FAILED` |
| `IN_DELIVERY` | `DELIVERED`, `FAILED` |
| `DELIVERED`, `CANCELLED`, `FAILED` | none (terminal) |

```bash
curl -X PATCH http://127.0.0.1:3000/orders/<id>/status \
  -H 'Content-Type: application/json' \
  -d '{"status":"PICKED_UP"}'
```

Invalid transitions return `409`. A `PENDING` order becomes dispatchable with `PATCH /orders/<id>/status` and `{"status":"READY"}`. While a driver still has free capacity, the dispatcher keeps assigning the nearest queued orders before the last delivery finishes. When all assigned orders reach a terminal state, the driver becomes `AVAILABLE` again. Delivered orders increase `totalDeliveries` and a batch gets `completedAt`.

### Idempotency

Send `Idempotency-Key` on `POST /orders`, `/orders/:id/pay`, `/orders/:id/refund`, `/drivers`, and `/dispatch/process`. The response is stored and replayed for the same key and body (default 24 hours, persisted in PostgreSQL). Claims and responses are shared across instances: a request that is still in flight is polled, a completed response is replayed, and a stale claim is reclaimed after 60 seconds. Reusing a key with a different body returns `409`, and replays include `Idempotent-Replayed: true`.

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

### Prometheus

`GET /metrics/prometheus` returns the same dispatch values plus process uptime, resident memory, and heap usage using the Prometheus text exposition format. Counters are suffixed `_total`; averages are gauges in milliseconds; revenue is exposed as `dispatch_revenue_thb`.

```bash
curl -H "x-api-key: $API_KEY" http://127.0.0.1:3000/metrics/prometheus
```

Example scrape configuration:

```yaml
scrape_configs:
  - job_name: fast-order-dispatch
    metrics_path: /metrics/prometheus
    static_configs:
      - targets: ["orders.example.com"]
    authorization:
      credentials: your-api-key
```

The endpoint is protected by the same API key and rate-limit rules as `/metrics`.

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
| `earning:created` | Driver earning created on delivery |
| `payout:created` | Payout recorded by an admin |

```js
import { io } from 'socket.io-client';

const socket = io('http://127.0.0.1:3000', { auth: { token: process.env.API_KEY } });
socket.on('batch:assigned', (batch) => console.log(batch));
socket.on('order:status', ({ order }) => console.log(order.status));
```

Set `REDIS_URL` to attach the Redis adapter and share events between multiple service instances. Without it, each instance only broadcasts to its own clients. Redis is required in production.

## Persistence

PostgreSQL stores orders, drivers, batches, order-to-batch links, payments, audit entries, and idempotency records. Forward-only migrations run automatically at startup under a PostgreSQL advisory lock, so multiple instances can start concurrently.

```bash
DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:5432/dispatch npm start
```

Dispatch is safe across replicas. A batch transaction locks queued orders with `FOR UPDATE SKIP LOCKED`, then locks an available driver, so two instances never assign the same order. Transactions always acquire locks in the same order (orders, then drivers) to avoid deadlocks.

For local development without PostgreSQL:

```bash
PGLITE_DATA_DIR=./data/pglite npm run dev
```

PGlite is a single-process embedded build of PostgreSQL. It is rejected when `NODE_ENV=production`.

## Docker

```bash
docker compose up --build
```

This starts PostgreSQL, Redis, and the API on port `3000`. PostgreSQL data lives in the `postgres-data` volume, and the app waits for both dependencies to become healthy. Provide `API_KEY` through the environment or a local `.env` file used by Compose:

```bash
API_KEY=change-me docker compose up --build
```

Build the image alone with `docker build -t fast-order-dispatch .`. The image runs as the unprivileged `node` user and ships a `/ready` health check.

## Production deployment

`docker-compose.prod.yml` runs the API behind Caddy, which provisions and renews TLS certificates automatically. Only Caddy publishes ports 80/443; the app stays on the private network.

```bash
cp .env.production.example .env.production
# edit every value: DOMAIN, CORS_ORIGIN, API_KEYS, POSTGRES_*,
# DATABASE_URL, REDIS_URL, and payment credentials
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

Point `DOMAIN` at the server and allow inbound HTTP/HTTPS. `CORS_ORIGIN` must be the public HTTPS origin (or a comma-separated list); production startup rejects `*`.

`DATABASE_URL` must point at the Compose `postgres` service and use the same database, user, and password as `POSTGRES_*`. URL-encode special characters in the password (for example `@` becomes `%40`). Multiple app replicas can share the same PostgreSQL and Redis; run them behind an orchestrator or load balancer rather than publishing the app port directly.

With `NODE_ENV=production` the process refuses to start unless:

- `API_KEYS`/`API_KEY` contains a non-placeholder key of at least 16 characters
- `CORS_ORIGIN` names explicit origins
- `RATE_LIMIT_MAX` is greater than zero
- `PAYMENT_PROVIDER` is `http` or `stripe` and the matching webhook secret is set
- `DATABASE_URL` is set and `PGLITE_DATA_DIR` is not
- `REDIS_URL` is set

## Backups

Create a compressed PostgreSQL dump:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U dispatch -d dispatch -Fc > "dispatch-$(date +%F).dump"
```

Restore into the running database (stop application writes first):

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U dispatch -d dispatch --clean --if-exists < dispatch-2026-10-20.dump
```

Adjust `-U`/`-d` if `POSTGRES_USER` or `POSTGRES_DB` differ. Test restores against a copy, and use provider snapshots or point-in-time recovery when running on managed PostgreSQL.

## Maintenance

Expired idempotency keys and old audit entries accumulate over time. Run the prune script from a scheduler (daily or weekly):

```bash
DATABASE_URL=postgres://dispatch:dispatch@127.0.0.1:5432/dispatch \
  AUDIT_RETENTION_DAYS=90 npm run db:prune
```

`AUDIT_RETENTION_DAYS` defaults to 90 and must be at least 1. The script deletes idempotency rows whose `expires_at` has passed and audit entries older than the retention window. It prints deleted row counts as JSON. In the production Compose stack:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T app \
  npm run db:prune
```

## Auto dispatch

Set `AUTO_PROCESS_INTERVAL_MS=500` to run a dispatch cycle twice per second. `PATCH /orders/<id>/status` with `READY` also triggers an immediate dispatch, and `POST /dispatch/process` remains available for manual runs.

## Scripts

| Command | Description |
| --- | --- |
| `npm run clean` | Remove the compiled `dist/` directory |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run dev` | Run from source with `ts-node` |
| `npm run lint` | Run ESLint over `src/` and `test/` |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the Jest suite |
| `npm run test:coverage` | Run Jest with coverage thresholds |
| `npm run db:prune` | Delete expired idempotency keys and old audit entries |

## Tests

The suite covers distance math, batch selection and capacity, multi-driver selection, order lifecycle transitions, driver release and updates, payments and refunds, realtime broadcasts, Redis fan-out (when `REDIS_URL` is set), security middleware, configuration guards, CORS enforcement, pagination, and the HTTP API. It also covers idempotency replay/conflict, role and quota enforcement, audit entries, and webhook signatures.

The PostgreSQL adapter is exercised against embedded PGlite in the default suite. When `TEST_DATABASE_URL` is set, a real PostgreSQL integration suite additionally verifies migrations, transaction rollback, concurrent dispatch across two connection pools, and cross-instance idempotency. That suite truncates the dispatch tables, so point it only at a disposable test database. CI runs `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, and `npm run test:coverage` on Node 24 with PostgreSQL 16 and Redis 7 services, then smoke-tests the production image against both services.

## Limitations

- The default payment gateway is a mock. Real charges require `PAYMENT_PROVIDER=http` or `stripe` plus provider credentials and webhook secrets.
- Authentication uses static API keys with roles. There are no user accounts, token rotation, or external identity provider integration.
- Per-key quotas are enforced inside the rate-limit window only; they are not billing quotas.
- Horizontal scaling requires PostgreSQL plus Redis. Without Redis, rate limits and realtime events stay local to each instance. In-memory and PGlite modes are single-process only.
- Schema migrations are forward-only. Take a PostgreSQL backup before deploying changes that alter tables.
- Idempotency claims older than 60 seconds are considered stale and can be reclaimed, so a request that runs longer than that may be executed more than once.
- Webhook reconciliation matches by provider transaction id. Orders created before a provider id is recorded must be retried or reconciled manually.
