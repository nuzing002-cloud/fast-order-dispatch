# PROJECT_STATE

Updated: 2026-10-22 11:55 Asia/Bangkok
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
| 10 | Deterministic self-cleaning E2E | VERIFIED_COMPLETE | Targets the order under test, verifies DELIVERED, cleans up in `finally`; commit `1c6aed3` |
| 11 | CI build-and-test + Docker smoke test green | VERIFIED_COMPLETE | Runs `39724702773` (`11fd438`) and `39724903243` (`74e6c21`) both success |
| 12 | Documentation for install/run/maintenance | VERIFIED_COMPLETE | `README.md`, `AGENTS.md`, `STATUS.md`, this file |
| 13 | Production deployment to a public host | BLOCKED | Requires server/host, domain, TLS origin, real API keys, payment credentials, VAPID keys, and hosting cost |

## Current runtime

- Branch `main`, implementation commit `11fd438`; this state file is updated in the following docs commit.
- Server: PID 7845, `node dist/index.js`, port 3000, restarted from the latest build at 2026-10-22 11:52.
- Supervisor: PID 32696, `scripts/local-supervisor.sh`.
- PostgreSQL: port 5432 (auto-recovered).
- Redis: 127.0.0.1:6379 (auto-recovered).
- Logs: `$PREFIX/tmp/opencode/fod-server.log`, `fod-supervisor.log`, `fod-redis.log`, `fod-boot.log`.
- Boot hook: `~/.termux/boot/30-fast-order-dispatch.sh` -> `scripts/termux-boot.sh` (outside repo; executed manually).
- LAN URL: `http://10.49.67.189:3000` (same network only).

## Last verification

- `npm run lint` PASS (exit 0)
- `npm run typecheck` PASS (exit 0)
- `npm run build` PASS (exit 0, `dist/index.js` regenerated)
- `npm test` 120 passed / 4 skipped (1 suite skipped: Postgres integration without `TEST_DATABASE_URL`)
- `node scripts/e2e-ui.js` E2E PASS, no console errors
- Supervisor recovery tests PASS:
  - `kill <app>` -> new PID 334, `/health` ok
  - stop Redis -> `PONG` again
  - `pg_ctl stop -m fast` -> `accepting connections` again
  - second supervisor invocation exits 0 (flock)
- GitHub Actions run `39724702773` success on commit `11fd438` (build-and-test + docker)
- GitHub Actions run `39724903243` success on docs commit `74e6c21` (build-and-test + docker)
- App restarted from the latest `dist/` after commit; new PID 7845, `/health` ok

## Files changed in this batch

- `scripts/local-supervisor.sh` — process/service supervisor
- `scripts/termux-boot.sh` — boot entrypoint (wake lock + supervisor)
- `scripts/e2e-ui.js` — deterministic driver flow and cleanup
- `package.json` — `npm run supervisor`
- `README.md` — Termux always-on runtime docs
- `AGENTS.md` — autonomous execution rules
- `STATUS.md` — short status summary
- `PROJECT_STATE.md` — this file
- `~/.termux/boot/30-fast-order-dispatch.sh` — Termux:Boot wrapper (outside repo)

## Known limitations

- Production deploy not performed: no host/domain/credentials; cannot be completed without those external inputs.
- Reboot autostart is installed but not verified by an actual reboot; Termux:Boot must be opened once and Android battery settings may affect it.
- LAN access uses HTTP; service workers/push install on other devices require a secure context (HTTPS or localhost). `127.0.0.1` PWA works.
- Payments use the mock provider; no real charges.
- Driver rating stays `0.0/5` because no rating-capture workflow exists.
- The PostgreSQL integration Jest suite is skipped locally unless `TEST_DATABASE_URL` is set; CI runs it.

## Next actions

1. On the next natural reboot, confirm the supervisor and app come back automatically; if not, inspect `fod-boot.log` and Android battery restrictions.
2. When a host/domain/credentials exist, follow `README.md` production deployment and re-verify the smoke test.
