#!/data/data/com.termux/files/usr/bin/bash
set -u

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"
LOG_DIR="${LOG_DIR:-$PREFIX/tmp/opencode}"
APP_LOG="$LOG_DIR/fod-server.log"
SUPERVISOR_LOG="$LOG_DIR/fod-supervisor.log"
LOCK_FILE="$LOG_DIR/fod-supervisor.lock"
PGDATA="${PGDATA:-$PREFIX/var/lib/postgresql}"
PGLOG="${PGLOG:-$PREFIX/var/log/postgresql.log}"
REDIS_LOG="$LOG_DIR/fod-redis.log"
INTERVAL="${SUPERVISOR_INTERVAL:-15}"

mkdir -p "$LOG_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

cd "$PROJECT_DIR" || exit 1

PORT="$(sed -n 's/^PORT=//p' .env 2>/dev/null | tail -1 | tr -d '[:space:]')"
PORT="${PORT:-3000}"

log() {
  printf '%s %s\n' "$(date -Iseconds)" "$*" >>"$SUPERVISOR_LOG"
}

ensure_postgres() {
  if pg_isready -q -h 127.0.0.1 -p 5432; then
    return
  fi
  log "starting postgres"
  pg_ctl -D "$PGDATA" -l "$PGLOG" -w -t 30 start >>"$SUPERVISOR_LOG" 2>&1 9>&- || log "postgres start failed"
}

ensure_redis() {
  if redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
    return
  fi
  log "starting redis"
  redis-server --daemonize yes --bind 127.0.0.1 --port 6379 --dir "$LOG_DIR" --dbfilename fod-redis.rdb --logfile "$REDIS_LOG" >>"$SUPERVISOR_LOG" 2>&1 9>&- || log "redis start failed"
}

app_running() {
  pgrep -xf "node dist/index.js" >/dev/null
}

start_app() {
  # The project selects DATABASE_URL or PGLITE_DATA_DIR exclusively. Remove
  # legacy shell variables so an old Termux session cannot override .env.
  env -u PGLITE_DATA_DIR -u DB_PATH node dist/index.js >>"$APP_LOG" 2>&1 < /dev/null 9>&- &
}

app_healthy() {
  curl -sf -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

failures=0
log "supervisor started (project=$PROJECT_DIR port=$PORT)"

while true; do
  ensure_postgres
  ensure_redis

  if app_running; then
    if app_healthy; then
      failures=0
    else
      failures=$((failures + 1))
      log "app health check failed ($failures/3)"
      if [ "$failures" -ge 3 ]; then
        log "restarting app after repeated health failures"
        pkill -xf "node dist/index.js" 2>/dev/null || true
        sleep 2
        failures=0
      fi
    fi
  else
    failures=0
    if [ ! -f dist/index.js ]; then
      log "dist/index.js missing; running build"
      npm run build >>"$SUPERVISOR_LOG" 2>&1 || log "build failed"
    fi
    if [ -f dist/index.js ]; then
      log "starting app"
      # Start the app in a detached process with only supported database
      # selectors. The wrapper avoids inheriting stale PGLite/SQLite settings.
      start_app
    fi
  fi

  sleep "$INTERVAL"
done
