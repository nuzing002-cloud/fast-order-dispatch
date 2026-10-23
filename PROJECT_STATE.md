# PROJECT_STATE

Updated: 2026-10-23 21:00 Asia/Bangkok
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
| 11 | CI build-and-test + Docker smoke test green | VERIFIED_COMPLETE | Run `40023297500` on `b65488c` success |
| 12 | Documentation for install/run/maintenance | VERIFIED_COMPLETE | `README.md`, `AGENTS.md`, `STATUS.md`, this file |
| 13 | Production deployment to a public host | BLOCKED | Requires server/host, domain, TLS origin, real API keys, payment credentials, VAPID keys, and hosting cost |
| 14 | Shopee Food Driver navigation handoff (`/shopee-driver.html`, `/integrations/shopee-driver/{links,deep-link}`) | VERIFIED_COMPLETE | API tests (`navigation-only`, 4 destinations, 400 on unknown), page served, live curl 200; no private Shopee API or order sync |
| 15 | Read-only Shopee bridge integration on port 4020 (status/orders/events/screenshot + optional webhook) | VERIFIED_COMPLETE | `ShopeeBridgeClient`/`ShopeeBridgeService`, API + UI tests, live 4020 sync and screenshot 200; no open/accept proxy routes |
| 16 | Show incoming order notifications and regular notifications in one Shopee activity feed | VERIFIED_COMPLETE | Admin UI fixture verified both in one time-sorted feed, with linked order displayed once |

## Current runtime

- Branch `main`, HEAD `b65488c` (`fix: unify Shopee order and notification feed`), pushed to `origin/main`.
- Server: PID 10769, `node dist/index.js`, port 3000, started by the supervisor at 20:53; `dist/` rebuilt from the current sources.
- Supervisor: PID 10753, `scripts/local-supervisor.sh` (app/PostgreSQL/Redis health loop).
- PostgreSQL: PID 5971, port 5432.
- Redis: PID 30796, 127.0.0.1:6379, data dir `$PREFIX/tmp/opencode` (`fod-redis.rdb`), outside the repo.
- Logs: `$PREFIX/tmp/opencode/fod-server.log`, `fod-supervisor.log`, `fod-redis.log`, `fod-boot.log`.
- Boot hooks: `~/.termux/boot/30-fast-order-dispatch.sh` (restored at 19:14, FOD after 5s) and `shopee-bridge.sh` (bridge after 45s); the FOD supervisor uses a lock so duplicate launches exit.
- LAN URL: `http://10.38.25.243:3000` (same network only; the address changes with the mobile network).
- Shopee bridge: `http://127.0.0.1:4020`, connected read-only, polling every 15s.
- Shopee handoff: `http://127.0.0.1:3000/shopee-driver.html`; API endpoints require `x-api-key` when `API_KEYS` is configured.
- Admin bridge panel: `http://127.0.0.1:3000/admin.html` (unified chronological Shopee order/notification feed, bridge status, heatmap screenshot).

## Last verification

- `npm run lint` PASS (exit 0)
- `npm run typecheck` PASS (exit 0)
- `npm run build` PASS (exit 0, `dist/` regenerated)
- `npm test -- --runInBand` PASS: 132 passed / 4 skipped, 20 suites passed + 1 skipped (Postgres integration without `TEST_DATABASE_URL`).
- `node scripts/e2e-ui.js` PASS: latest order `order_248cbcae-03f3-4357-a689-1b02ee81207e`, admin READY -> ASSIGNED, driver UI -> DELIVERED, `consoleErrors: []`.
- Unified feed browser fixture PASS: an order notification linked to `TEST12345` and a regular notification render as two chronological cards, with the order shown only once.
- Live bridge status: `configured=true`, `capability=read-only`, `reachable=true`, `lastError=null`, 2 orders, 9 events, screenshot available.
- Live screenshot: `GET /integrations/shopee-bridge/screenshot` -> 200 `image/png`, 653301 bytes.
- Live webhook: loopback POST -> `{ok:true,received:1,duplicates:0}`; repeat -> `duplicates:1`.
- Live command-route check: `/integrations/shopee-bridge/open` and `/accept` -> 404 (no write proxy exposed).
- Driver after E2E: `AVAILABLE`, `assignedOrders=[]`, `acceptsNewOrders=true`.
- Supervisor duplicate check after running the boot hook manually: still one supervisor (PID 21785) and one app (PID 23582).
- LAN health check on the new address: `http://10.38.25.243:3000/health` 200.
- GitHub Actions run `40023297500` success on `b65488c`.

## Files changed in this batch

- `src/integrations/ShopeeBridgeClient.ts` — typed read-only HTTP client for bridge health/events/orders/screenshot with SSRF-safe URL validation, timeouts, size limits, and PNG verification
- `src/integrations/ShopeeBridgeService.ts` — cached polling snapshot, event dedupe, screenshot cache, read-only status model
- `src/index.ts` — `/integrations/shopee-bridge/{status,sync,screenshot}` and HMAC/loopback-limited `/webhooks/shopee-bridge`; lifecycle start/stop and startup log flags
- `src/config.ts` — `SHOPEE_BRIDGE_URL`, `SHOPEE_BRIDGE_SYNC_MS`, `SHOPEE_BRIDGE_TIMEOUT_MS`, `SHOPEE_BRIDGE_WEBHOOK_SECRET` parsing/validation
- `public/admin.html`, `public/admin.js`, `public/styles.css` — Thai admin panel for bridge connection, ADB state, unified Shopee order/notification activity, heatmap, manual sync
- `PROJECT_STATE.md`, `STATUS.md` — updated verification and unified-feed state
- `public/sw.js` — cache `fod-v4`
- `src/openapi.ts` — documents the four bridge endpoints
- `test/ShopeeBridge.test.ts` — client/service/API/webhook/security/screenshot coverage
- `test/Config.test.ts` — bridge env parsing and validation coverage
- `test/api.test.ts` — cache version assertion
- `.env.example`, `.env.production.example`, `README.md` — configuration and operational documentation
- `STATUS.md`, `PROJECT_STATE.md` — this update

## Known limitations

- Production deploy not performed: no host/domain/credentials; cannot be completed without those external inputs.
- Reboot autostart is installed but not verified by an actual reboot; Termux:Boot must be opened once and Android battery settings may affect it. The FOD hook had been left disabled during bridge setup and was restored in this batch.
- The Shopee integration is strictly read-only: bridge events and orders are displayed only and never create/assign/accept orders in this system. Real order sync needs an authorized Shopee Partner API/webhook plus an order-match/confirmation flow.
- Bridge events currently reflect the bridge's auto-accept attempts (including `auto-accept-failed`), not successful Shopee orders. The two live orders have no `orderNo`/fare because automatic accept failed.
- The heatmap appears only after the bridge's area check has produced `/area/latest.png`; bridge data is cached in memory and re-polled after a restart.
- Without `SHOPEE_BRIDGE_WEBHOOK_SECRET`, the webhook accepts loopback sources only; with a secret, senders must HMAC-sign the raw body.
- LAN access uses HTTP and the LAN IP is dynamic; service workers/push install on other devices require a secure context (HTTPS or localhost). `127.0.0.1` PWA works.
- Payments use the mock provider; no real charges.
- Driver rating stays `0.0/5` because no rating-capture workflow exists.
- The PostgreSQL integration Jest suite is skipped locally unless `TEST_DATABASE_URL` is set; CI runs it.
- Android can kill the supervisor under memory pressure (observed on 2026-10-22 while running Chromium E2E). Re-run `npm run supervisor` to recover; Termux has no guaranteed respawn without root or a foreground service.
- A full local test run can occasionally flake the Redis adapter test under parallel load; isolated and repeated runs pass.

## Next actions

1. On the next natural reboot, confirm the FOD supervisor and app return automatically, and that the bridge hook also starts; inspect `fod-boot.log` and `shopee-bridge/boot.log`.
2. Keep the admin bridge panel open to verify live status; use the 4020 console area check when a newer heatmap is needed.
3. Optionally start the bridge with `WEBHOOK_URL=http://127.0.0.1:3000/webhooks/shopee-bridge` (+ secret) for immediate event display instead of waiting for the 15s poll.
4. When a host/domain/credentials exist, follow `README.md` production deployment and re-verify the smoke test.
5. Before adding any write actions, implement Shopee order matching, duplicate detection, and explicit confirmation; do not proxy raw tap/accept commands.
