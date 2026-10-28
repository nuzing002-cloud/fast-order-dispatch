# Project Status

Authoritative state: `PROJECT_STATE.md`

Updated: 2026-10-28 17:34 (Asia/Bangkok)

## Current state

- Branch: `main`; previous pushed HEAD `ba7787f`; this change adds the KPI queue-wait fix, regression test, and docs
- CI: latest green runs are `40662630710` (`75df64d`) and `40666331472` (`ba7787f`); check this change's run after push
- Local server: `http://127.0.0.1:3000` from rebuilt `dist/` (PostgreSQL), PID 19515; `/health` 200 (`queueSize=0`); KPI live `avgQueueWaitMs=58ms` (was structurally 0)
- Supervisor: detached `scripts/local-supervisor.sh`, PID 22368; PostgreSQL PID 22386 and Redis PID 22402
- ADB: `127.0.0.1:5555` connected (`CPH2237`; `adb shell` OK); `service.adb.tcp.port=5555`; bridge reports `adb.ok=true`; non-root `persist.adb.tcp.port` is denied
- Shopee bridge: `http://127.0.0.1:4020` 200; supervisor/app PIDs 25522/15634; 27 offer records (23 failed, 2 accepted, 2 missed), 1 active notification, 1s poll; auto-open/auto-accept enabled; local supervisor watchdog reconnects ADB every 10s when lost
- Missed offer: latest offer at 2026-10-28 16:45:31 local reused the failed key `0|...|0|null|10371`; it was dismissed at 16:54 with no auto-accept attempt; local `server.js` now treats a changed notification `when` as a fresh offer and resets attempt state
- Reboot autostart: FOD hook `~/.termux/boot/30-fast-order-dispatch.sh` and bridge hook installed but still not verified by a real reboot
- LAN URL: `http://10.40.184.249:3000` (current; `10.38.25.243` no longer responds; dynamic address)
- Logs: `/data/data/com.termux/files/usr/tmp/opencode/fod-{server,supervisor,redis,boot}.log`
- System: Phantom Process Killer disabled via ADB (`settings_enable_monitor_phantom_procs=false`, `max_phantom_processes=2147483647`); Termux packages battery-whitelisted; the user controls further system changes

## Completed

- Order lifecycle: PENDING -> READY -> ASSIGNED -> PICKED_UP -> IN_DELIVERY -> DELIVERED
- Dispatch only restaurant-ready orders; nearest-first batching, up to 4 orders per driver, pipelined top-up
- Admin KPI reporting v1: admin-only `GET /metrics/kpi`, validated date range, success/on-time/duration metrics, refund-excluded revenue, daily and per-driver tables in the admin UI
- KPI queue wait fixed: `queuedAt` now survives ASSIGNED/status transitions, so `avgQueueWaitMs` is measured (live 58ms) instead of structurally 0; regression test added
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
- Bridge ADB watchdog: detects `adb-not-ok`, retries `adb connect 127.0.0.1:5555` every 10s, and logged automatic recovery after a forced disconnect

## Verification (last run)

- 2026-10-28 17:28-17:34 verification after the KPI queue-wait and bridge offer-key fixes:
- `npm run lint` PASS; `npm run typecheck` PASS; `npm run build` PASS; server rebuilt and restarted (PID 19515)
- `npm test -- --runInBand` PASS: 138 passed / 4 skipped, 21 suites passed + 1 skipped (Postgres integration suite skipped without `TEST_DATABASE_URL`)
- `node scripts/e2e-ui.js` PASS: order `order_0fa07dc8-04a3-4fe2-ae09-8792fd4a1636`, admin READY -> ASSIGNED, driver UI -> DELIVERED, `consoleErrors: []`, PWA assets OK
- KPI live: admin `GET /metrics/kpi?days=1` 200; `avgQueueWaitMs=58` (non-zero), 25 delivered, 3,182 THB revenue, 682 THB fees
- Bridge offer-key fix verified by loading the real `upsertOrder` source with a seeded failed record: new `when` -> `status=new`, `acceptAttemptedAt=null`, `error=null`; same `when` -> preserved `attempting`
- Bridge restarted with the fix (app PID 15634); `/health` 200, `adb.ok=true`, cache current
- Previous 2026-10-28 16:05-16:42 verification after merging KPI, bumping the PWA cache, and restoring ADB:
- `npm run lint` pass; `npm run typecheck` pass; `npm run build` pass; server rebuilt and restarted
- `npm test -- --runInBand` 137 passed / 4 skipped, 21 suites passed + 1 skipped (Postgres integration suite skipped without `TEST_DATABASE_URL`)
- `node scripts/e2e-ui.js` E2E PASS; order `order_a4b2915a-925f-4502-a823-e09a943a3b52` DELIVERED, `consoleErrors: []`, PWA assets OK
- KPI live: admin-only `GET /metrics/kpi` 200; 2026-10-28 range returned 2 delivered, 256 THB revenue, 56 THB fees; KPI markup is served by `/admin.html`; service worker cache is `fod-v6`
- FOD `/health` 200 (`storage=postgres`, `queueSize=0`); bridge `/health` 200 with `adb.ok=true`, current poll, 27 cached orders, 0 active offers, auto-accept enabled
- ADB restored: `adb devices` shows `127.0.0.1:5555 device CPH2237`; `adb shell` returned `ADB_OK`; `service.adb.tcp.port=5555`
- Watchdog test: `adb disconnect 127.0.0.1:5555` -> supervisor logged `ADB reconnect: connected` and bridge returned to `adb.ok=true` within ~10s
- Historical 2026-10-25 03:25-03:28 verification after restoring ADB/services:
- `npm run lint` pass; `npm run typecheck` pass; `npm run build` pass
- `npm test -- --runInBand` 132 passed / 4 skipped, 20 suites passed + 1 skipped (Postgres integration suite skipped without `TEST_DATABASE_URL`)
- `node scripts/e2e-ui.js` E2E PASS; order `order_9350ec55-6dc9-420e-946e-1582d2ecfb68` DELIVERED, `consoleErrors: []`, shots in `$PREFIX/tmp/fod-e2e`
- At that checkpoint, FOD `/health` 200 (`storage=postgres`, `queueSize=0`); bridge `/health` 200 with `adb.ok=true`; `adb devices -l` showed `127.0.0.1:5555 device CPH2237`
- Bridge events after reconnect: one non-offer notification (`Driver กำลังทำงาน`); no new offer to validate auto-accept
- `/push/public-key` 200; `/drivers` 200 with the target driver `AVAILABLE`
- Historical: browser fixture confirmed one linked order notification plus one ordinary notification as two cards without duplication; bridge-console fixture confirmed one table with no duplicated order number; classifier checks reject customer messages and pickup-ready notices
- Historical: an earlier bridge check reduced the order list from 32 false-positive-inclusive records to 10 offer records; ADB has since reconnected
- Historical: live browser rendered the bridge activity and upgraded the service-worker cache to the then-current `fod-v5` (now `fod-v6`)
- Simulated driver geolocation test passed through permission, watch, API persistence, and stop; saved driver coordinates were restored afterward
- Supervisor restart test passed after terminating the app; `/health` recovered and driver was `AVAILABLE` with zero assigned jobs
- Bridge live: status 200 read-only/reachable, sync 200, screenshot 200 `image/png` 653301 bytes, webhook dedupe `duplicates=1`, open/accept routes 404
- Shopee deep-link endpoint live check -> 200 (`foody://driver/rn/@shopee-rn/main/TRANSACTIONS`)
- Driver after E2E: `AVAILABLE`, 0 assigned, accepts new orders
- Supervisor restarted the app after kill; `/health` 200; PostgreSQL and Redis up; duplicate supervisor exits via lock; boot hook re-run kept a single supervisor
- LAN health check -> 200 on `http://10.38.25.243:3000/health`
- GitHub Actions run `40025025770` success (commit `7290aea`)
- Historical: bridge `/health` was 200 with ADB `device not found` before the 2026-10-25 reconnect; `adb devices -l` now shows `127.0.0.1:5555 device CPH2237`
- Bridge supervisor syntax PASS and remained at one stable app PID for 35 seconds while ADB was unavailable

## Remaining

- Production deployment to a real host: requires `DOMAIN`, public HTTPS origin, real `API_KEYS`, payment credentials, VAPID keys, PostgreSQL/Redis host, and a server with Docker.
- Real reboot test for the FOD and bridge boot hooks (installed and exercised manually, but no reboot performed).
- ADB is connected and the watchdog recovers lost connections, but the 16:45 offer was missed before the key-reuse fix. Verify the next live offer reaches `attemptAutoAccept` and the accept control; re-enable/re-pair Wireless debugging after reboot or if it is turned off.
- Shopee order/status synchronization is out of scope for the read-only bridge handoff; it needs an authorized Shopee Partner API/webhook plus order matching, duplicate detection, and confirmation before any write action.
- Official V2 API research is documented in `docs/shopee-partner-api-research.md`. Marketplace shop-order APIs and order-status push exist, but no public ShopeeFood/Food Driver offer API was found in the reviewed Open Platform catalog. Do not build a Food Driver connector unless Shopee confirms supported APIs, permissions, and account eligibility in writing.
- 19 of 27 offer records still show `accept control not found` (23 failed, 2 accepted, 2 missed). No live offer has arrived since the 17:28 key-reuse fix, so successful auto-accept is not yet confirmed.
- The KPI audit's Medium/Low items still need triage. The High queue-wait bug is fixed and covered by a regression test.
- Bridge source is outside the FOD Git worktree; its current changes are local and not pushed.
- Shopee Food Driver API access is an external blocker pending written confirmation from Shopee; the research document lists the official references and questions to resolve.

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
- Phone: CPH2237, Android 13, not rooted. Shizuku+ is installed without Device Owner. **Never enable Device Owner/Dhizuku mode**; it previously caused the banking app to block access and was removed/reinstalled to recover.
- The bridge is local-only and not in the FOD Git worktree; its missed-offer key-reuse fix is running but cannot be pushed with this repo.
- LAN access uses a dynamic address (`10.40.184.249` at this check; `10.38.25.243` no longer responds); the FOD boot hook lives outside the repo and requires the Termux:Boot app to be opened once.
- The supervisor holds a wake lock installed by the boot hook; reboot behavior could not be tested without restarting the device.
- On 2026-10-25 03:06 Android Phantom Process Killer trimmed Termux children and killed the copilot CLI; the monitor is disabled via ADB and Termux packages are battery-whitelisted. The device has 4 GB physical RAM (about 8 GB with RAM Expansion) and heavy swap, so multiple AI CLIs plus PostgreSQL/Redis can still make it unresponsive. The user controls further system changes.
- Android may kill the supervisor under memory pressure (observed once while running Chromium E2E, alongside PostgreSQL/Redis). Re-run `npm run supervisor` to recover; it is idempotent.
- Redis persistence lives in `$PREFIX/tmp/opencode/fod-redis.rdb`, not the repo.
- The Shopee integration is intentionally read-only; do not add raw tap/accept proxy routes without a reviewed order-match and confirmation flow.
