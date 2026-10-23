# PROJECT_STATE

Updated: 2026-10-23 15:45 Asia/Bangkok
Purpose: single source of truth for project state, requirements, evidence, and remaining work.

## Goal

Deliver a working private order-dispatch system (Project ID `1388246780`) that runs on this Termux device, is usable through the web UI on localhost/LAN, survives process/service crashes, restarts after reboot, and has a green CI.

## Requirements and status

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Order lifecycle PENDING -> READY -> ASSIGNED -> PICKED_UP -> IN_DELIVERY -> DELIVERED | VERIFIED_COMPLETE | Jest lifecycle suites + E2E flow |
| 2 | Dispatch only READY orders, nearest-first, up to 4 per driver, pipelined top-up | VERIFIED_COMPLETE | `BatchProcessingService`/API tests + commit `3cd0f14` |
| 3 | PostgreSQL persistence, Redis realtime/rate limits, auth, idempotency, audit, payments, earnings, push, metrics, PWA | VERIFIED_COMPLETE | 120 passing tests; health reports `storage=postgres`, `redis=true` |
| 4 | Minimum delivery fee 28 THB | VERIFIED_COMPLETE | Config/API tests; commit `dff2607` |
| 5 | Web UI flows: customer, driver, admin, API docs | VERIFIED_COMPLETE | `node scripts/e2e-ui.js` PASS on 420x900 touch viewport |
| 6 | Local always-on supervisor (app + PostgreSQL + Redis, health-checked restart) | VERIFIED_COMPLETE | Killed app -> restarted; stopped Redis -> auto-started; stopped PostgreSQL -> auto-started; duplicate supervisor blocked by lock |
| 7 | Reboot autostart (Termux:Boot + wake lock) | IN_PROGRESS | `~/.termux/boot/30-fast-order-dispatch.sh` installed and executed manually; real reboot test not performed |
| 8 | Accessible from localhost and same LAN | VERIFIED_COMPLETE | `http://127.0.0.1:3000/health` 200; `http://10.49.67.189:3000/health` 200 |
| 9 | No stale test orders blocking driver capacity | VERIFIED_COMPLETE | Driver `AVAILABLE`, 0 assigned, accepts new orders |
| 10 | Deterministic self-cleaning E2E | VERIFIED_COMPLETE | Creates an order, clicks READY in the admin UI, drives the same order to DELIVERED by UI, verifies persistence, cleans up in `finally`; two consecutive PASS runs |
| 11 | CI build-and-test + Docker smoke test green | VERIFIED_COMPLETE | Runs `39724702773` (`11fd438`) and `39724903243` (`74e6c21`) both success |
| 12 | Documentation for install/run/maintenance | VERIFIED_COMPLETE | `README.md`, `AGENTS.md`, `STATUS.md`, this file |
| 13 | Production deployment to a public host | BLOCKED | Requires server/host, domain, TLS origin, real API keys, payment credentials, VAPID keys, and hosting cost |
| 14 | Shopee Food Driver navigation handoff (`/shopee-driver.html`, `/integrations/shopee-driver/{links,deep-link}`) | VERIFIED_COMPLETE | API tests (`navigation-only`, 4 destinations, 400 on unknown), page served, live curl 200; no private Shopee API or order sync |

## Current runtime

- Branch `main`, HEAD `4ab0e65` (Shopee handoff, pushed).
- Server: PID 5724, `node dist/index.js`, port 3000, built 2026-10-23 15:39 and started by the supervisor at 15:40.
- Supervisor: PID 5707, `scripts/local-supervisor.sh` (started 2026-10-23 15:40; app/PostgreSQL/Redis health loop).
- PostgreSQL: PID 27117 (plus workers), port 5432.
- Redis: PID 25723, 127.0.0.1:6379, data dir `$PREFIX/tmp/opencode` (`fod-redis.rdb`), outside the repo.
- Logs: `$PREFIX/tmp/opencode/fod-server.log`, `fod-supervisor.log`, `fod-redis.log`, `fod-boot.log`.
- Boot hook: `~/.termux/boot/30-fast-order-dispatch.sh` -> `scripts/termux-boot.sh` (outside repo; executed manually).
- LAN URL: `http://10.49.67.189:3000` (same network only).
- Shopee handoff: `http://127.0.0.1:3000/shopee-driver.html`; API endpoints require `x-api-key` when `API_KEYS` is configured.

## Last verification

- `npm run lint` PASS (exit 0, 2026-10-23 15:39)
- `npm run typecheck` PASS (exit 0)
- `npm run build` PASS (exit 0, `dist/` regenerated)
- `npm test` 121 passed / 4 skipped, 19 suites passed + 1 skipped (Postgres integration without `TEST_DATABASE_URL`)
- `node scripts/e2e-ui.js` E2E PASS twice consecutively after the service-worker cache bump (`fod-v3`); latest order `order_2947634a...` reached ASSIGNED from the admin READY click and DELIVERED from the driver UI, no console errors. Use `E2E_API_KEY` or `API_KEY` when the server has auth enabled.
- Live Shopee endpoint check: `GET /integrations/shopee-driver/deep-link?destination=transactions` -> 200 with `foody://driver/rn/@shopee-rn/main/TRANSACTIONS`
- Driver after E2E: `AVAILABLE`, `assignedOrders=[]`, `acceptsNewOrders=true`
- Supervisor restarted the app after `pkill` and `/health` returned 200 (`storage=postgres`, `redis=true` in the startup log)
- GitHub Actions run `39926659575` success on `4ab0e65` (`build-and-test` + `docker` smoke test)

## Files changed in this batch

- `src/integrations/ShopeeDriverLinks.ts` — typed navigation-only deep-link catalog (`home`, `notification`, `order-detail`, `transactions`) with validated destination parsing
- `src/index.ts` — `GET /integrations/shopee-driver/links` and `/deep-link` endpoints; audit signature accepts the authenticated request type
- `src/openapi.ts` — documents both integration endpoints
- `public/shopee-driver.html` — companion page that opens the declared `foody://` links
- `public/common.js` — API-key bootstrap from `?api_key=`/`#api_key=` (stored and stripped from the URL) and key validation before saving
- `public/sw.js` — cache `fod-v3`, precache the Shopee page, bypass `/integrations/`
- `scripts/e2e-ui.js` — optional `API_KEY`/`E2E_API_KEY` header and pre-seeded `localStorage` key
- `test/api.test.ts` — coverage for link catalog, destination fallback/validation, page serving, cache version
- `README.md` — Shopee handoff usage plus authenticated curl examples
- `package.json` — `dev` runs `ts-node --files`
- `STATUS.md`, `PROJECT_STATE.md` — this update

## Known limitations

- Production deploy not performed: no host/domain/credentials; cannot be completed without those external inputs.
- Reboot autostart is installed but not verified by an actual reboot; Termux:Boot must be opened once and Android battery settings may affect it.
- LAN access uses HTTP; service workers/push install on other devices require a secure context (HTTPS or localhost). `127.0.0.1` PWA works.
- Payments use the mock provider; no real charges.
- Driver rating stays `0.0/5` because no rating-capture workflow exists.
- The PostgreSQL integration Jest suite is skipped locally unless `TEST_DATABASE_URL` is set; CI runs it.
- Android can kill the supervisor itself under memory pressure (observed on 2026-10-22 while running Chromium E2E). Re-run `npm run supervisor` to recover; Termux has no guaranteed respawn without root or a foreground service. Running Chromium (E2E) increases memory pressure.
- Shopee handoff is navigation-only: it resolves only when the Shopee Food Driver app (`com.shopee.foody.driver.th`) is installed, and it does not read orders or sync statuses. Real synchronization needs an authorized Shopee Partner API/webhook.
- `?api_key=` bootstrap briefly exposes the key to the first request/history entry; it is stored in `localStorage` and stripped from the address bar immediately. Prefer pasting the key into the key bar.
- The Shopee page is not linked from the main navigation; open `/shopee-driver.html` directly or add a nav link later.

## Next actions

1. On the next natural reboot, confirm the supervisor and app come back automatically; if not, inspect `fod-boot.log` and Android battery restrictions.
2. Avoid running Chromium E2E while the device is under memory pressure; if the supervisor disappears, re-run `npm run supervisor` (idempotent via flock).
3. When a host/domain/credentials exist, follow `README.md` production deployment and re-verify the smoke test.
