# Project Rules

Order dispatch API. Private use for Project ID `1388246780` only.

## Session start

1. Read `STATUS.md` and `git status` / `git log --oneline -5` before acting.
2. Continue from the recorded state; do not re-investigate what is already documented.
3. When the user says to finish, fix, or clear remaining work, do all of it without asking for confirmation and without stopping mid-way.

## Stack

- Node.js >= 24, TypeScript, Express, Jest
- PostgreSQL (PGlite for local tests), Redis for rate limits and realtime fan-out
- Vanilla HTML/JS PWA in `public/`
- Docker/Caddy production deployment

## Conventions

- Config comes from environment variables in `src/config.ts`; document new variables in `.env.example`, `.env.production.example`, `README.md`, and tests.
- Keep production guards in `validateProductionConfig`; update the Docker smoke test when a new required variable is added.
- Do not add code comments unless requested.
- Preserve existing error shapes, status codes, and OpenAPI definitions.
- Never commit secrets; `.env*` files are ignored except the example files.

## Definition of done

Run and pass all of these before reporting:

```bash
npm run lint
npm run typecheck
npm run build
npm test
node scripts/e2e-ui.js   # requires the server on 127.0.0.1:3000 and Chromium
```

Then:

1. Update `STATUS.md` with the new state, verification results, and remaining work.
2. Commit with a concise conventional-commit message and push to `origin/main`.
3. Watch CI with `gh run watch --exit-status`; fix failures until green.

## Runtime

- Restart the local server after changing `dist/`:

```bash
pkill -f "node dist/index.js"
setsid nohup node dist/index.js >> /data/data/com.termux/files/usr/tmp/opencode/fod-server.log 2>&1 < /dev/null & disown
curl -s http://127.0.0.1:3000/health
```

- Production deployment needs real credentials and a host; it is not part of routine code work.
