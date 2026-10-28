# PROJECT_STATE

Updated: 2026-10-25 03:33 Asia/Bangkok
Purpose: single source of truth for project state, requirements, evidence, and remaining work.

## Goal

Deliver a working private order-dispatch system (Project ID `1388246780`) that runs on this Termux device, is usable through the web UI on localhost/LAN, survives process/service crashes, restarts after reboot, and has a green CI.

## Requirements and status

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Order lifecycle PENDING -> READY -> ASSIGNED -> PICKED_UP -> IN_DELIVERY -> DELIVERED | VERIFIED_COMPLETE | Jest lifecycle suites + E2E flow |
| 2 | Dispatch only READY orders, nearest-first, up to 4 per driver, pipelined top-up | VERIFIED_COMPLETE | `BatchProcessingService`/API tests + commit `3cd0f14` |
| 3 | PostgreSQL persistence, Redis realtime/rate limits, auth, idempotency, audit, payments, earnings, push, metrics, PWA | VERIFIED_COMPLETE | 132 passing tests; health reports `storage=postgres` |
| 4 | Minimum delivery fee 28 THB | VERIFIED_COMPLETE | Config/API tests; commit `dff2607` |
| 5 | Web UI flows: customer, driver, admin, API docs | VERIFIED_COMPLETE | `node scripts/e2e-ui.js` PASS twice on 420x900 touch viewport |
| 6 | Local always-on supervisor (app + PostgreSQL + Redis, health-checked restart) | VERIFIED_COMPLETE | Killed app -> restarted; stopped Redis -> auto-started; stopped PostgreSQL -> auto-started; duplicate supervisor blocked by lock |
| 7 | Reboot autostart (Termux:Boot + wake lock) | PARTIAL | Hook `~/.termux/boot/30-fast-order-dispatch.sh` restored and executed manually; duplicate supervisor still blocked; real reboot not performed |
| 8 | Accessible from localhost and same LAN | VERIFIED_COMPLETE | `http://127.0.0.1:3000/health` 200; `http://10.38.25.243:3000/health` 200 (LAN IP is dynamic) |
| 9 | No stale test orders blocking driver capacity | VERIFIED_COMPLETE | Driver `AVAILABLE`, 0 assigned, accepts new orders after E2E |
| 10 | Deterministic self-cleaning E2E | VERIFIED_COMPLETE | Creates an order, clicks READY in the admin UI, drives the same order to DELIVERED by UI, verifies persistence, cleans up in `finally`; latest run `order_dc041782-...` PASS with zero console errors |
| 11 | CI build-and-test + Docker smoke test green | VERIFIED_COMPLETE | Run `40025025770` on `7290aea` success |
| 12 | Documentation for install/run/maintenance | VERIFIED_COMPLETE | `README.md`, `AGENTS.md`, `STATUS.md`, this file |
| 13 | Production deployment to a public host | BLOCKED | Requires server/host, domain, TLS origin, real API keys, payment credentials, VAPID keys, and hosting cost |
| 14 | Shopee Food Driver navigation handoff (`/shopee-driver.html`, `/integrations/shopee-driver/{links,deep-link}`) | VERIFIED_COMPLETE | API tests (`navigation-only`, 4 destinations, 400 on unknown), page served, live curl 200; no private Shopee API or order sync |
| 15 | Shopee bridge integration on port 4020 (status/orders/events/screenshot + optional webhook) | PARTIAL | Bridge HTTP endpoint is healthy, but Android ADB at `127.0.0.1:5555` is unavailable; live device data cannot currently refresh |
| 16 | Show incoming order notifications and regular notifications in one Shopee activity feed | VERIFIED_COMPLETE | Admin and bridge-console browser fixtures show both together; linked orders appear once; PWA cache is `fod-v5` |
| 17 | Distinguish actionable new offers from ordinary order-related notifications | VERIFIED_COMPLETE | Explicit offer classifier filters 22 false order records, suppresses startup replay, and limits auto-accept to new offers |

## Current runtime

- Branch `main` at `3de8566`, synced with `origin/main`; this batch records a runtime/ADB restore and a docs-only update.
- Server: PID 1404, `node dist/index.js`, port 3000, served by the detached supervisor; `/health` returns 200 with `storage=postgres`, `queueSize=0`.
- Supervisor: PID 1024, `scripts/local-supervisor.sh` (app/PostgreSQL/Redis health loop).
- PostgreSQL: PID 1241, port 5432. Redis: PID 1386, 127.0.0.1:6379, data dir `$PREFIX/tmp/opencode` (`fod-redis.rdb`), outside the repo.
- Logs: `$PREFIX/tmp/opencode/fod-server.log`, `fod-supervisor.log`, `fod-redis.log`, `fod-boot.log`.
- Boot hooks: `~/.termux/boot/30-fast-order-dispatch.sh` (restored at 19:14, FOD after 5s) and `shopee-bridge.sh` (bridge after 45s); the FOD supervisor uses a lock so duplicate launches exit.
- ADB: `127.0.0.1:5555` connected to `CPH2237`; bridge reports `adb.ok=true` and polls every 5s.
- LAN URL: `http://10.38.25.243:3000` (same network only; the address changes with the mobile network).
- Shopee bridge: `http://127.0.0.1:4020` returns 200 with ADB connected; 16 cached offers, one non-offer event (`Driver กำลังทำงาน`), no new offer since reconnect; screenshot cache is still from `2026-10-24T18:34Z`. Auto-open and auto-accept remain enabled.
- Shopee bridge supervisor/app: PIDs 2814/2858. Source lives in `/data/data/com.termux/files/home/shopee-bridge` (not a Git worktree).
- Android Phantom Process Killer trimmed Termux child processes at 2026-10-25 03:06 local and killed the copilot CLI. `settings_enable_monitor_phantom_procs=false` and `max_phantom_processes=2147483647` were set via ADB; `com.termux`, `com.termux.boot`, and `com.termux.api` are battery-whitelisted. The user controls any further system changes.
- Shopee handoff: `http://127.0.0.1:3000/shopee-driver.html`; API endpoints require `x-api-key` when `API_KEYS` is configured.
- Admin bridge panel: `http://127.0.0.1:3000/admin.html` (unified chronological Shopee order/notification feed, bridge status, heatmap screenshot).

## Last verification

- 2026-10-25 03:25-03:28 local verification after restoring ADB and services:
- `npm run lint` PASS (exit 0); `npm run typecheck` PASS (exit 0); `npm run build` PASS (exit 0, `dist/` regenerated).
- `npm test -- --runInBand` PASS: 132 passed / 4 skipped, 20 suites passed + 1 skipped (Postgres integration without `TEST_DATABASE_URL`).
- `node scripts/e2e-ui.js` PASS: order `order_9350ec55-6dc9-420e-946e-1582d2ecfb68`, admin READY -> ASSIGNED, driver UI -> DELIVERED, `consoleErrors: []`, shots in `$PREFIX/tmp/fod-e2e`.
- Current FOD `/health` -> 200 (`storage=postgres`, `queueSize=0`); bridge `/health` -> 200 with `adb.ok=true`; `adb devices -l` lists `127.0.0.1:5555 device CPH2237`.
- Bridge events after reconnect: one non-offer notification (`Driver กำลังทำงาน`); no new offer was available to validate auto-accept.
- Historical: bridge supervisor syntax check PASS; previously observed for 35 seconds with ADB offline and the bridge PID remained stable, with a single degraded-state log instead of restart churn.
- Unified feed browser fixture PASS with live Shopee data (10 activity cards); installed browser cache contains only `fod-v5`.
- Bridge console fixture PASS: one linked new offer and one regular notification appear in one time-sorted table, order number displayed once.
- Bridge classifier checks PASS: explicit new-order phrases match; customer messages, pickup-ready notices, and routine driver notifications do not.
- Previous bridge check reduced the order list from 32 to 10 after filtering false order classifications; ADB has since reconnected.
- Driver location tracking browser test PASS (geolocation permission/watch, API update, stop); original driver coordinates restored.
- `/push/public-key` returns HTTP 200 with a configured key (re-checked 2026-10-25 03:28).
- Current bridge integration status shows `configured=true`, `capability=read-only`, `reachable=true`, `lastRefreshSucceeded=true`, 16 cached orders, and a cached screenshot from before reconnect.
- Previous screenshot check: `GET /integrations/shopee-bridge/screenshot` -> 200 `image/png`, 653301 bytes.
- Previous webhook check: loopback POST -> `{ok:true,received:1,duplicates:0}`; repeat -> `duplicates:1`.
- Previous command-route check: `/integrations/shopee-bridge/open` and `/accept` -> 404 (no write proxy exposed).
- Driver after E2E: `AVAILABLE`, `assignedOrders=[]`, `acceptsNewOrders=true`.
- Controlled app termination previously recovered automatically; current FOD supervisor/app remain running, `/health` HTTP 200.
- LAN health check on the new address: `http://10.38.25.243:3000/health` 200.
- GitHub Actions run `40025025770` success on `7290aea`.

## Files changed in this batch

- `PROJECT_STATE.md`, `STATUS.md` — 2026-10-25 runtime/ADB restore, Phantom Process Killer note, and fresh verification results (docs only)
- `docs/shopee-partner-api-research.md` — official V2 marketplace API/auth/webhook research; no public Food Driver offer API found, so Food Driver integration remains blocked pending Shopee confirmation
- `src/integrations/ShopeeBridgeClient.ts` — typed read-only HTTP client for bridge health/events/orders/screenshot with SSRF-safe URL validation, timeouts, size limits, and PNG verification
- `src/integrations/ShopeeBridgeService.ts` — cached polling snapshot, event dedupe, screenshot cache, read-only status model
- `scripts/e2e-ui.js` — loads local `.env` for the API key and selects an admin key from `API_KEYS`
- `src/index.ts` — `/integrations/shopee-bridge/{status,sync,screenshot}` and HMAC/loopback-limited `/webhooks/shopee-bridge`; lifecycle start/stop and startup log flags
- `src/config.ts` — `SHOPEE_BRIDGE_URL`, `SHOPEE_BRIDGE_SYNC_MS`, `SHOPEE_BRIDGE_TIMEOUT_MS`, `SHOPEE_BRIDGE_WEBHOOK_SECRET` parsing/validation
- `public/admin.html`, `public/admin.js`, `public/styles.css` — Thai admin panel for bridge connection, ADB state, unified Shopee order/notification activity, heatmap, manual sync
- `public/driver.html`, `public/driver.js` — foreground location tracking with explicit start/stop and throttled updates
- `public/sw.js` — `fod-v5` cache invalidates stale installed-PWA assets
- `/data/data/com.termux/files/home/shopee-bridge/server.js` — classify only explicit new offers for auto-accept/voice alerts, avoid ambiguous notification taps, suppress startup replay, and hide legacy false-order records
- `/data/data/com.termux/files/home/shopee-bridge/console.html` — combine order details and regular notifications in a single chronological activity table
- `scripts/local-supervisor.sh` — avoids inheriting unsupported database override environment variables
- `src/config.ts`, `src/integrations/ShopeeBridgeService.ts` — configurable bridge freshness and offline/stale reporting
- `PROJECT_STATE.md`, `STATUS.md` — updated verification and unified-feed state
- `public/sw.js` — cache `fod-v5` to invalidate stale installed-PWA assets
- `src/openapi.ts` — documents the four bridge endpoints
- `test/ShopeeBridge.test.ts` — client/service/API/webhook/security/screenshot coverage
- `test/Config.test.ts` — bridge env parsing and validation coverage
- `test/api.test.ts` — cache version and unified activity feed markup assertions
- `.env.example`, `.env.production.example`, `README.md` — configuration and operational documentation
- `STATUS.md`, `PROJECT_STATE.md` — this update
- `/data/data/com.termux/files/home/shopee-bridge/supervisor.sh` — treats ADB disconnection as a degraded dependency instead of repeatedly restarting a healthy HTTP bridge

## Known limitations

- Production deploy not performed: no host/domain/credentials; cannot be completed without those external inputs.
- Reboot autostart is installed but not verified by an actual reboot; Termux:Boot must be opened once and Android battery settings may affect it. The FOD hook had been left disabled during bridge setup and was restored in this batch.
- ADB wireless endpoint `127.0.0.1:5555` is connected to `CPH2237` at this checkpoint, but no new offer has arrived since reconnect; live notifications, screenshot refresh, and the auto-accept gesture are still unverified. Auto-accept remains enabled and may act once an eligible offer appears.
- The Shopee integration is strictly read-only: bridge events and orders are displayed only and never create/assign/accept orders in this system. Real order sync needs an authorized Shopee Partner API/webhook plus an order-match/confirmation flow.
- Official Shopee Open Platform research is recorded in `docs/shopee-partner-api-research.md`: marketplace shop-order APIs and order-status pushes exist, but no public ShopeeFood/Food Driver offer API was found in the reviewed V2 catalog. Food Driver integration remains blocked pending written confirmation of an authorized API and account eligibility from Shopee; no private app endpoints, cookies, or tokens are in scope.
- Six historical offer records still show `accept control not found`; no active new offer was available to validate the actual accept gesture after tightening classification. Do not treat auto-accept as verified until an authorized live offer reaches the matching UI control.
- Bridge changes above are local only because `shopee-bridge` is not a Git worktree; they are running under its supervisor but cannot be pushed with the FOD repository.
- The heatmap appears only after the bridge's area check has produced `/area/latest.png`; bridge data is cached in memory and re-polled after a restart.
- Without `SHOPEE_BRIDGE_WEBHOOK_SECRET`, the webhook accepts loopback sources only; with a secret, senders must HMAC-sign the raw body.
- LAN access uses HTTP and the LAN IP is dynamic; service workers/push install on other devices require a secure context (HTTPS or localhost). `127.0.0.1` PWA works.
- Payments use the mock provider; no real charges.
- Driver rating stays `0.0/5` because no rating-capture workflow exists.
- The PostgreSQL integration Jest suite is skipped locally unless `TEST_DATABASE_URL` is set; CI runs it.
- On 2026-10-25 03:06 Android Phantom Process Killer trimmed Termux child processes and killed the copilot CLI. The monitor is now disabled via ADB and Termux packages are battery-whitelisted, but the device has 4 GB physical RAM (about 8 GB with RAM Expansion) and heavy swap; running multiple AI CLIs plus PostgreSQL/Redis can still make it unresponsive. The user controls further system changes.
- Android can kill the supervisor under memory pressure (observed on 2026-10-22 while running Chromium E2E). Re-run `npm run supervisor` to recover; Termux has no guaranteed respawn without root or a foreground service.
- A full local test run can occasionally flake the Redis adapter test under parallel load; isolated and repeated runs pass.

## Next actions

1. Verify the auto-accept gesture with a real new offer while ADB stays connected; do not rely on it until the matching UI control is confirmed.
2. On the next natural reboot, confirm the FOD supervisor and app return automatically, and that the bridge hook also starts; inspect `fod-boot.log` and `shopee-bridge/boot.log`.
3. Keep the admin bridge panel open to verify live status; use the 4020 console area check when a newer heatmap is needed.
4. When a host/domain/credentials exist, follow `README.md` production deployment and re-verify the smoke test.
5. Obtain written Shopee confirmation of a supported, authorized Food Driver API, scopes, event types, and region eligibility before designing any Food Driver connector; see `docs/shopee-partner-api-research.md`.
6. Before adding any write actions, implement Shopee order matching, duplicate detection, and explicit confirmation; do not proxy raw tap/accept commands.
