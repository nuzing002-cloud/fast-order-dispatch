# Project Status

Updated: 2026-10-22 (Asia/Bangkok)

## Current state

- Branch: `main`, synced with `origin/main`
- HEAD: `9e5b80f` ci: supply VAPID keys for container smoke test and always show logs
- CI: GitHub Actions green (`build-and-test` + `docker` smoke test)
- Local server: running on `http://127.0.0.1:3000` from `dist/` (PostgreSQL + Redis)
- Server log: `/data/data/com.termux/files/usr/tmp/opencode/fod-server.log`

## Completed

- Order lifecycle: PENDING -> READY -> ASSIGNED -> PICKED_UP -> IN_DELIVERY -> DELIVERED
- Dispatch only restaurant-ready orders; nearest-first batching, up to 4 orders per driver, pipelined top-up
- PostgreSQL persistence, auth roles/API keys, idempotency, audit log, rate limiting, payments/refunds, driver earnings/payouts, decline/pause, web push, Prometheus metrics, PWA UI
- Minimum delivery fee 28 THB (`MIN_DELIVERY_FEE`), enforced in API and UI
- Production Docker/Caddy deployment files, prune script, OpenAPI docs
- CI fixes: Node 24, VAPID keys generated for smoke test, container logs always printed

## Verification (last run)

- `npm run lint` pass
- `npm run typecheck` pass
- `npm run build` pass
- `npm test` 120 passed / 4 skipped (1 Postgres integration suite skipped without `TEST_DATABASE_URL`)
- `node scripts/e2e-ui.js` E2E PASS (home, PWA, customer, driver, admin; no console errors)
- GitHub Actions run `39658853440` success

## Remaining

- Production deployment to a real host: requires `DOMAIN`, public HTTPS origin, real `API_KEYS`, payment credentials, VAPID keys, PostgreSQL/Redis host, and a server with Docker.
- No code work is pending.

## Commands

```bash
npm run lint && npm run typecheck && npm run build
npm test
node scripts/e2e-ui.js
setsid nohup node dist/index.js >> /data/data/com.termux/files/usr/tmp/opencode/fod-server.log 2>&1 < /dev/null & disown
```

## Notes

- `.env` is gitignored and supplies local VAPID keys; production requires `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.
- Docker CI generates ephemeral VAPID keys; do not commit real keys.
- Private use only for Project ID `1388246780`.
