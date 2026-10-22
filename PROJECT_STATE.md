# PROJECT_STATE

Updated: 2026-10-22 13:15 Asia/Bangkok
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

## Current runtime

- Branch `main`, fix commit `76f5b9c`.
- Server: PID 1943, `node dist/index.js`, port 3000, built and restarted at 2026-10-22 13:13.
- Supervisor: PID 3164, `scripts/local-supervisor.sh` (restarted to load the Redis data-dir change).
- PostgreSQL: PID 32395, port 5432.
- Redis: PID 3200, 127.0.0.1:6379, data dir `$PREFIX/tmp/opencode` (`fod-redis.rdb`), outside the repo.
- Logs: `$PREFIX/tmp/opencode/fod-server.log`, `fod-supervisor.log`, `fod-redis.log`, `fod-boot.log`.
- Boot hook: `~/.termux/boot/30-fast-order-dispatch.sh` -> `scripts/termux-boot.sh` (outside repo; executed manually).
- LAN URL: `http://10.49.67.189:3000` (same network only).

## Last verification

- `npm run lint` PASS (exit 0)
- `npm run typecheck` PASS (exit 0)
- `npm run build` PASS (exit 0, `dist/index.js` regenerated)
- `npm test` 120 passed / 4 skipped (1 suite skipped: Postgres integration without `TEST_DATABASE_URL`)
- `node scripts/e2e-ui.js` E2E PASS twice consecutively after the harness fixes (latest order `order_b0fa16e6...`, admin READY -> ASSIGNED, UI -> DELIVERED, no console errors)
- Supervisor recovery: app kill -> restarted automatically (`/health` ok); Redis shutdown -> restarted in 20s with data dir `$PREFIX/tmp/opencode`; PostgreSQL reachable on 5432
- GitHub Actions run `39732959736` success on fix commit `76f5b9c` (build-and-test + docker)

## Files changed in this batch

- `scripts/e2e-ui.js` — clicks READY in the real admin UI, scopes admin assertions to the order under test, tolerates the driver card disappearing after DELIVERED, uses a DOM click for the horizontally scrolled table button
- `scripts/local-supervisor.sh` — Redis data dir moved to `$PREFIX/tmp/opencode` (`fod-redis.rdb`) so dumps stay out of the repo
- `.gitignore` — ignore `*.rdb`
- `STATUS.md` — short status summary
- `PROJECT_STATE.md` — this file

## Known limitations

- Production deploy not performed: no host/domain/credentials; cannot be completed without those external inputs.
- Reboot autostart is installed but not verified by an actual reboot; Termux:Boot must be opened once and Android battery settings may affect it.
- LAN access uses HTTP; service workers/push install on other devices require a secure context (HTTPS or localhost). `127.0.0.1` PWA works.
- Payments use the mock provider; no real charges.
- Driver rating stays `0.0/5` because no rating-capture workflow exists.
- The PostgreSQL integration Jest suite is skipped locally unless `TEST_DATABASE_URL` is set; CI runs it.
- Android can kill the supervisor itself under memory pressure: at 13:09 the supervisor, PostgreSQL, and Redis stopped while the app kept running. Manual supervisor restart recovered every service in under 20s, but Termux has no guaranteed respawn without root or a foreground service. Running Chromium (E2E) on this device increases memory pressure.

## Next actions

1. On the next natural reboot, confirm the supervisor and app come back automatically; if not, inspect `fod-boot.log` and Android battery restrictions.
2. Avoid running Chromium E2E while the device is under memory pressure; if the supervisor disappears, re-run `npm run supervisor` (idempotent via flock).
3. When a host/domain/credentials exist, follow `README.md` production deployment and re-verify the smoke test.
