# Project Status

Authoritative state: `PROJECT_STATE.md`

Updated: 2026-10-23 (Asia/Bangkok)

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
- Shopee Food Driver navigation handoff: `/shopee-driver.html` plus `/integrations/shopee-driver/links` and `/integrations/shopee-driver/deep-link` (navigation-only, no private API or order sync)
- Web console API-key bootstrap (`?api_key=`/`#api_key=`) with validation and URL cleanup
- Production Docker/Caddy deployment files, prune script, OpenAPI docs
- CI fixes: Node 24, VAPID keys generated for smoke test, container logs always printed
- E2E harness: creates an order, clicks READY in the admin UI (real dispatch), advances only that order through the driver UI to `DELIVERED`, verifies persistence in admin, and cleans up in `finally`
- Local supervisor: health-checked app restart, PostgreSQL/Redis recovery, single-instance lock, Termux:Boot autostart with wake lock

## Verification (last run)

- `npm run lint` pass
- `npm run typecheck` pass
- `npm run build` pass
- `npm test` 121 passed / 4 skipped, 19 suites passed + 1 skipped (Postgres integration suite skipped without `TEST_DATABASE_URL`)
- `node scripts/e2e-ui.js` E2E PASS twice consecutively after cache bump to `fod-v3` (home, PWA, admin READY -> dispatch, customer, driver -> DELIVERED, admin persistence; no console errors); use `E2E_API_KEY`/`API_KEY` when auth is enabled
- Shopee deep-link endpoint live check -> 200 (`foody://driver/rn/@shopee-rn/main/TRANSACTIONS`)
- Driver after E2E: `AVAILABLE`, 0 assigned, accepts new orders
- Supervisor restarted the app after kill; `/health` 200; PostgreSQL and Redis up; duplicate supervisor exits via lock
- GitHub Actions run `39732959736` success (prior fix commit `76f5b9c`); CI for this batch watched after push

## Remaining

- Commit/push the Shopee handoff batch and confirm CI is green.
- Production deployment to a real host: requires `DOMAIN`, public HTTPS origin, real `API_KEYS`, payment credentials, VAPID keys, PostgreSQL/Redis host, and a server with Docker.
- Reboot autostart still needs a real reboot to confirm.
- Shopee order/status synchronization is out of scope for the deep-link handoff; it needs an authorized Shopee Partner API/webhook.

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
- Android may kill the supervisor under memory pressure (observed once while running Chromium E2E, alongside PostgreSQL/Redis). Re-run `npm run supervisor` to recover; it is idempotent.
- Redis persistence now lives in `$PREFIX/tmp/opencode/fod-redis.rdb`, not the repo.
