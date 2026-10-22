# Project Status

Authoritative state: `PROJECT_STATE.md`

Updated: 2026-10-22 (Asia/Bangkok)

## Current state

- Branch: `main`, synced with `origin/main`
- HEAD: latest commit on `main` (see `git log --oneline -1`)
- CI: GitHub Actions green (`build-and-test` + `docker` smoke test)
- Local server: running on `http://127.0.0.1:3000` from `dist/` (PostgreSQL + Redis)
- Supervisor: running (`scripts/local-supervisor.sh`), restarts app and databases on failure
- Reboot autostart: `~/.termux/boot/30-fast-order-dispatch.sh` (Termux:Boot installed)
- Logs: `/data/data/com.termux/files/usr/tmp/opencode/fod-{server,supervisor,redis}.log`

## Completed

- Order lifecycle: PENDING -> READY -> ASSIGNED -> PICKED_UP -> IN_DELIVERY -> DELIVERED
- Dispatch only restaurant-ready orders; nearest-first batching, up to 4 orders per driver, pipelined top-up
- PostgreSQL persistence, auth roles/API keys, idempotency, audit log, rate limiting, payments/refunds, driver earnings/payouts, decline/pause, web push, Prometheus metrics, PWA UI
- Minimum delivery fee 28 THB (`MIN_DELIVERY_FEE`), enforced in API and UI
- Production Docker/Caddy deployment files, prune script, OpenAPI docs
- CI fixes: Node 24, VAPID keys generated for smoke test, container logs always printed
- E2E harness: clears leftover driver assignments before each run, advances only the order under test, verifies `DELIVERED`, and cleans up in `finally`
- Local supervisor: health-checked app restart, PostgreSQL/Redis recovery, single-instance lock, Termux:Boot autostart with wake lock

## Verification (last run)

- `npm run lint` pass
- `npm run typecheck` pass
- `npm run build` pass
- `npm test` 120 passed / 4 skipped (1 Postgres integration suite skipped without `TEST_DATABASE_URL`)
- `node scripts/e2e-ui.js` E2E PASS (home, PWA, customer, driver, admin; no console errors)
- Driver after E2E: `AVAILABLE`, 0 assigned, accepts new orders
- Supervisor: killed app -> restarted automatically; stopped Redis -> auto-started; stopped PostgreSQL -> auto-started; duplicate supervisor exits via lock
- GitHub Actions run `39660234902` success

## Remaining

- Production deployment to a real host: requires `DOMAIN`, public HTTPS origin, real `API_KEYS`, payment credentials, VAPID keys, PostgreSQL/Redis host, and a server with Docker.
- No code work is pending.

## Commands

```bash
npm run lint && npm run typecheck && npm run build
npm test
node scripts/e2e-ui.js
npm run supervisor
bash ~/.termux/boot/30-fast-order-dispatch.sh   # idempotent; safe to re-run
```

## Notes

- `.env` is gitignored and supplies local VAPID keys; production requires `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.
- Docker CI generates ephemeral VAPID keys; do not commit real keys.
- Private use only for Project ID `1388246780`.
- LAN access: `http://10.49.67.189:3000` (same network only); the boot hook lives outside the repo and requires the Termux:Boot app to be opened once.
- The supervisor holds a wake lock installed by the boot hook; reboot behavior could not be tested without restarting the device.
