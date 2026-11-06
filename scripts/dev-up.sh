#!/usr/bin/env bash
# Starts local PostgreSQL/Redis (if installed as services), migrates, and runs API + worker + web + POS (dev).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${LOG_DIR:-/tmp/retailcore}"; mkdir -p "$LOG"
export DATABASE_URL="${DATABASE_URL:-postgres://rc_app:rc_app_dev_password@localhost:5432/rc_dev}"
export DATABASE_OWNER_URL="${DATABASE_OWNER_URL:-postgres://postgres:postgres@localhost:5432/rc_dev}"
(service postgresql start || true) >/dev/null 2>&1
(redis-server --daemonize yes || true) >/dev/null 2>&1
sleep 1
cd "$ROOT/apps/api" && npx tsx src/migrate.ts
nohup npx tsx src/server.ts > "$LOG/api.log" 2>&1 &
nohup npx tsx src/worker.ts > "$LOG/worker.log" 2>&1 &
cd "$ROOT/apps/web" && { [ -d .next ] || npx next build; } && nohup npx next start -p 3000 > "$LOG/web.log" 2>&1 &
cd "$ROOT/apps/pos-desktop" && nohup npx vite --port 1420 > "$LOG/pos.log" 2>&1 &
sleep 5
curl -fsS http://localhost:4000/health && echo " API ok — web http://localhost:3000 — POS http://localhost:1420"
