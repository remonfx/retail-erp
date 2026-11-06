#!/usr/bin/env bash
# RetailCore — one-command local trial on macOS / Linux. Requires Docker running.
set -euo pipefail
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo "Install Docker first: https://www.docker.com/products/docker-desktop/"; exit 1; }
secret() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40; }
if [ ! -f .env ]; then
  printf 'POSTGRES_PASSWORD=postgres\nJWT_SECRET=%s\nMFA_ENCRYPTION_KEY=%s\nCORS_ORIGINS=http://localhost:3000,http://localhost:1420\n' "$(secret)" "$(secret)" > .env
  echo "Created .env with random secrets"
fi
docker compose up -d --build
echo "Waiting for the API..."
for _ in $(seq 60); do curl -fsS http://localhost:4000/ready >/dev/null 2>&1 && break; sleep 3; done
if [ "$(docker compose exec -T postgres psql -U postgres -d retailcore -tAc "select count(*) from core_user where email='demo@retailcore.app'" | tr -d '[:space:]')" = "0" ]; then
  docker compose run --rm seed
fi
echo
echo "Back-office: http://localhost:3000   (demo@retailcore.app / DemoPassw0rd!2026)"
echo "POS:         http://localhost:1420   (create a device in Settings > Devices)"
