# fast-order-dispatch
Advanced order dispatch system with batch processing, payment coordination, and real-time job management

## Start the service

```bash
npm run build
npm start
```

The service listens on `HOST`/`PORT` from `.env` (defaults to `0.0.0.0:3000`).
Order allocation is restricted to driver ID `1388246780`.

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

### Submit an order

Send an order to `POST /orders`. The service immediately attempts to assign it to the target driver. If that driver is unavailable or has no capacity, the order remains in `GET /orders/pending`.

## Test

```bash
npm test
```

Jest runs the unit tests under `test/` (distance math, batch processing, payments) plus an HTTP-level test that starts the Express app on an ephemeral port.
