#!/data/data/com.termux/files/usr/bin/bash
set -u

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${LOG_DIR:-$PREFIX/tmp/opencode}"

mkdir -p "$LOG_DIR"
termux-wake-lock >/dev/null 2>&1 || true
sleep "${FOD_BOOT_DELAY:-5}"
setsid nohup "$SCRIPT_DIR/local-supervisor.sh" >>"$LOG_DIR/fod-boot.log" 2>&1 </dev/null &
