# Project Status

Authoritative state: `PROJECT_STATE.md`

Updated: 2026-10-24 06:05 (Asia/Bangkok)

## Current state

- Branch: `main`, synced with `origin/main`
- Starting HEAD: `47e2bec` (`docs: record offer classification status`)
- Previously verified CI baseline: run `40025025770` green on `7290aea`
- Local server: running on `http://127.0.0.1:3000` from `dist/` (PostgreSQL), PID 18605; `/health` returns 200
- Supervisor: running detached (`scripts/local-supervisor.sh`), PID 18552; restarts app and databases on failure
- Shopee bridge: `http://127.0.0.1:4020` returns 200, but ADB `127.0.0.1:5555` is disconnected; 10 cached offers, no current events, 5s polling. Auto-accept is enabled but cannot operate without ADB. Supervisor now treats this as degraded dependency state and no longer restarts the bridge repeatedly.
- Reboot autostart: FOD hook `~/.termux/boot/30-fast-order-dispatch.sh` restored and manually exercised; bridge hook also installed
- LAN URL: `http://10.38.25.243:3000` (dynamic address)
- Logs: `/data/data/com.termux/files/usr/tmp/opencode/fod-{server,supervisor,redis,boot}.log`

## Completed

- Order lifecycle: PENDING -> READY -> ASSIGNED -> PICKED_UP -> IN_DELIVERY -> DELIVERED
- Dispatch only restaurant-ready orders; nearest-first batching, up to 4 orders per driver, pipelined top-up
- PostgreSQL persistence, auth roles/API keys, idempotency, audit log, rate limiting, payments/refunds, driver earnings/payouts, decline/pause, web push, Prometheus metrics, PWA UI
- Minimum delivery fee 28 THB (`MIN_DELIVERY_FEE`), enforced in API and UI
- Shopee Food Driver navigation handoff: `/shopee-driver.html` plus `/integrations/shopee-driver/links` and `/integrations/shopee-driver/deep-link` (navigation-only, no private API or order sync)
- Read-only Shopee bridge integration: `/integrations/shopee-bridge/{status,sync,screenshot}` and `/webhooks/shopee-bridge`; typed client/service, HMAC or loopback-only webhook, event dedupe, screenshot validation, admin panel, no open/accept proxy routes
- Unified Shopee activity feed: order notifications and regular notifications appear together in time order; linked orders are enriched with order details and rendered once
- Bridge console uses the same combined chronological feed; only explicit new-offer notifications can trigger its auto-accept path, and startup does not replay old notifications
- Web console API-key bootstrap (`?api_key=`/`#api_key=`) with validation and URL cleanup
- Production Docker/Caddy deployment files, prune script, OpenAPI docs
- CI fixes: Node 24, VAPID keys generated for smoke test, container logs always printed
- E2E harness: creates an order, clicks READY in the admin UI (real dispatch), advances only that order through the driver UI to `DELIVERED`, verifies persistence in admin, and cleans up in `finally`
- Local supervisor: health-checked app restart, PostgreSQL/Redis recovery, single-instance lock, Termux:Boot autostart with wake lock

## Verification (last run)

- `npm run lint` pass
- `npm run typecheck` pass
- `npm run build` pass
- `npm test -- --runInBand` 132 passed / 4 skipped, 20 suites passed + 1 skipped (Postgres integration suite skipped without `TEST_DATABASE_URL`)
- `node scripts/e2e-ui.js` E2E PASS; latest order `order_bfff9b80-1dc7-4062-b467-eaee000bb178` DELIVERED, `consoleErrors: []`; runner now loads `.env` and selects the admin API key itself
- Browser fixture confirms one linked order notification and one ordinary notification appear together as two cards without duplicating the order
- Bridge-console fixture confirms an offer and ordinary notification in one table with no duplicated order number; classifier checks reject customer messages and pickup-ready notices
- Previous bridge check reduced the order list from 32 false-positive-inclusive records to 10 offer records; ADB has since disconnected
- Live browser rendered the bridge activity and upgraded the service-worker cache from the old version to `fod-v5`
- Simulated driver geolocation test passed through permission, watch, API persistence, and stop; saved driver coordinates were restored afterward
- Supervisor restart test passed after terminating the app; `/health` recovered and driver was `AVAILABLE` with zero assigned jobs
- Bridge live: status 200 read-only/reachable, sync 200, screenshot 200 `image/png` 653301 bytes, webhook dedupe `duplicates=1`, open/accept routes 404
- Shopee deep-link endpoint live check -> 200 (`foody://driver/rn/@shopee-rn/main/TRANSACTIONS`)
- Driver after E2E: `AVAILABLE`, 0 assigned, accepts new orders
- Supervisor restarted the app after kill; `/health` 200; PostgreSQL and Redis up; duplicate supervisor exits via lock; boot hook re-run kept a single supervisor
- LAN health check -> 200 on `http://10.38.25.243:3000/health`
- GitHub Actions run `40025025770` success (commit `7290aea`)
- Current bridge `/health` 200 with ADB `device not found`; `adb devices -l` is empty and connection to `127.0.0.1:5555` is refused
- Bridge supervisor syntax PASS and remained at one stable app PID for 35 seconds while ADB was unavailable

## Remaining

- Production deployment to a real host: requires `DOMAIN`, public HTTPS origin, real `API_KEYS`, payment credentials, VAPID keys, PostgreSQL/Redis host, and a server with Docker.
- Real reboot test for the FOD and bridge boot hooks (installed and exercised manually, but no reboot performed).
- Restore Android Wireless debugging/ADB pairing or update `ADB_SERIAL` to the currently paired endpoint before relying on live Shopee bridge data; until then notifications, screenshots, and auto-accept cannot operate.
- Shopee order/status synchronization is out of scope for the read-only bridge handoff; it needs an authorized Shopee Partner API/webhook plus order matching, duplicate detection, and confirmation before any write action.
- Six historical offer records still show `accept control not found`. No live offer was available to verify the accept control after the classifier fix, so successful auto-accept is not yet confirmed.
- Bridge source is outside the FOD Git worktree; its current changes are local and not pushed.

## Commands

```bash
npm run lint && npm run typecheck && npm run build
npm test
node scripts/e2e-ui.js
npm run supervisor
bash ~/.termux/boot/30-fast-order-dispatch.sh   # idempotent; safe to re-run
```

Bridge checks:

```bash
KEY=$(sed -n 's/^API_KEYS=\([^:]*\).*/\1/p' .env)
curl -H "x-api-key: $KEY" http://127.0.0.1:3000/integrations/shopee-bridge/status
curl -X POST -H "x-api-key: $KEY" -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:3000/integrations/shopee-bridge/sync
curl -H "x-api-key: $KEY" http://127.0.0.1:3000/integrations/shopee-bridge/screenshot -o area.png
```

## Notes

- `.env` is gitignored and supplies local VAPID keys plus `SHOPEE_BRIDGE_URL=http://127.0.0.1:4020`; production requires `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.
- Docker CI generates ephemeral VAPID keys; do not commit real keys.
- Private use only for Project ID `1388246780`.
- LAN access uses a dynamic address (`10.38.25.243` at this check); the FOD boot hook lives outside the repo and requires the Termux:Boot app to be opened once.
- The supervisor holds a wake lock installed by the boot hook; reboot behavior could not be tested without restarting the device.
- Android may kill the supervisor under memory pressure (observed once while running Chromium E2E, alongside PostgreSQL/Redis). Re-run `npm run supervisor` to recover; it is idempotent.
- Redis persistence lives in `$PREFIX/tmp/opencode/fod-redis.rdb`, not the repo.
- The Shopee integration is intentionally read-only; do not add raw tap/accept proxy routes without a reviewed order-match and confirmation flow.
