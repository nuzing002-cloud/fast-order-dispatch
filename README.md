# fast-order-dispatch

Order dispatch service with batch processing, payment coordination, lifecycle tracking, and realtime job management.

## Features

- Batches up to 3 orders and assigns them only to driver ID `1388246780`
- Nearest-neighbour route optimization using Haversine distance
- Delivery ETA = travel time + longest restaurant preparation time in the batch
- Full order lifecycle with guarded transitions and automatic driver release
- Payment step on order creation (mock gateway) with a retry endpoint
- Realtime Socket.IO events, with optional Redis fan-out across instances
- Optional SQLite persistence using the built-in `node:sqlite` module
- Request validation, structured HTTP errors, and a metrics endpoint

## Requirements

- Node.js 24 or newer
- npm

## Setup

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

The service listens on `HOST`/`PORT` from the environment (defaults to `0.0.0.0:3000`).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `CORS_ORIGIN` | `*` | CORS origin for HTTP and Socket.IO |
| `DB_PATH` | unset | Enables SQLite persistence at this file path |
| `REDIS_URL` | unset | Enables the Socket.IO Redis adapter for multiple instances |
| `AUTO_PROCESS_INTERVAL_MS` | unset | Runs the dispatcher automatically at this interval (minimum 100) |

Without `DB_PATH` all state is kept in memory and is lost on restart.

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Service status, storage mode, queue size |
| `GET` | `/drivers` | List drivers |
| `POST` | `/drivers` | Register a driver |
| `GET` | `/orders` | List all orders |
| `GET` | `/orders/pending` | Orders waiting in the dispatch queue |
| `GET` | `/orders/:id` | Fetch one order |
| `POST` | `/orders` | Create an order, charge it, and try to dispatch |
| `POST` | `/orders/:id/pay` | Retry payment for an unpaid order |
| `PATCH` | `/orders/:id/status` | Advance the order lifecycle |
| `POST` | `/dispatch/process` | Run one dispatch cycle manually |
| `GET` | `/batches` | List batch assignments |
| `GET` | `/metrics` | Dispatch metrics |

Errors use `{ "error": "message" }` with status `400`, `402`, `404`, `409`, or `500`.

### Register the target driver

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

Only drivers with this ID receive orders. Any other registered driver is kept but never selected.

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

A successful call returns `201` with the order, payment transaction, batch, queue size, and `assignedToTargetDriver`. If the target driver is unavailable or full, the order stays in `GET /orders/pending`.

### Payments

`POST /orders` runs the mock gateway automatically (overridable with `paymentMethod`). The mock fails when `totalAmount` is zero; the order is stored as `PENDING` with `paymentStatus: "FAILED"`, is not queued, and the response is `402`.

Retry with:

```bash
curl -X POST http://127.0.0.1:3000/orders/<id>/pay \
  -H 'Content-Type: application/json' \
  -d '{"method":"card"}'
```

Retrying an already paid order returns `409`.

### Order lifecycle

```text
PENDING ──► ASSIGNED ──► PICKED_UP ──► IN_DELIVERY ──► DELIVERED
   │            │             │              │
   ├──► CANCELLED / FAILED ◄──┴──────────────┘
```

Allowed transitions:

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

### Metrics

`GET /metrics` returns:

| Field | Meaning |
| --- | --- |
| `totalOrdersProcessed` | Orders that have been assigned to a driver |
| `totalBatchesCreated` | Number of batches produced |
| `averageProcessingTime` | Mean milliseconds from order creation to assignment |
| `averageDeliveryTime` | Mean milliseconds from assignment to delivery |
| `successRate` | Delivered / (delivered + cancelled + failed), `0` when no terminal orders |
| `totalRevenue` | Sum of delivered order amounts |
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
| `batch:assigned` | Batch |
| `batch:completed` | Batch |
| `driver:updated` | Driver |

```js
import { io } from 'socket.io-client';

const socket = io('http://127.0.0.1:3000');
socket.on('batch:assigned', (batch) => console.log(batch));
socket.on('order:status', ({ order }) => console.log(order.status));
```

Set `REDIS_URL` to attach the Redis adapter and share events between multiple service instances.

## Persistence

Set `DB_PATH` to persist orders, drivers, and batches in SQLite:

```bash
DB_PATH=./data/dispatch.sqlite3 npm start
```

The store uses the built-in `node:sqlite` module (no native dependency), enables WAL mode, and reloads state at startup. Pending orders are re-queued in creation time order.

## Auto dispatch

Set `AUTO_PROCESS_INTERVAL_MS=1000` to run a dispatch cycle on an interval instead of relying on `POST /orders` or `POST /dispatch/process`.

## Scripts

| Command | Description |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server |
| `npm run dev` | Run from source with `ts-node` |
| `npm test` | Run the Jest suite |
| `npm run test:coverage` | Run Jest with coverage |

## Tests

The suite covers distance math, batch selection and capacity, order lifecycle transitions, driver release, payments, SQLite restore, realtime broadcasts, and the HTTP API. CI runs `npm ci`, `npm run build`, and `npm test` on Node 24.

## Limitations

- The payment gateway is a mock; no external provider is called.
- There is no authentication or rate limiting yet.
- With the default in-memory store, state is not shared between processes.
