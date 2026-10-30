#!/usr/bin/env sh

set -eu

cd "$(dirname "$0")"

if docker compose version >/dev/null 2>&1; then
  compose_cmd="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  compose_cmd="docker-compose"
else
  echo "Docker Compose is required to run Scryer." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for local readiness checks." >&2
  exit 1
fi

if [ -L .env ]; then
  echo "Refusing a symbolic-link .env file." >&2
  exit 1
fi
if [ ! -f .env ]; then
  umask 077
  cp .env.example .env
fi
chmod 600 .env

secret_count=$(grep -c '^POSTGRES_PASSWORD=' .env || true)
if [ "$secret_count" -eq 0 ]; then
  local_password=$(LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d '[:space:]')
  printf 'POSTGRES_PASSWORD=%s\n' "$local_password" >> .env
elif [ "$secret_count" -ne 1 ]; then
  echo "Expected exactly one POSTGRES_PASSWORD entry in .env." >&2
  exit 1
fi

file_password=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env)
effective_password=${POSTGRES_PASSWORD:-$file_password}
if ! printf '%s\n' "$effective_password" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "POSTGRES_PASSWORD must be a 64-character lowercase hex secret. Remove a weak value and rerun setup.sh." >&2
  exit 1
fi

file_api_port=$(sed -n 's/^API_PORT=//p' .env | tail -n 1)
api_port=${API_PORT:-${file_api_port:-8000}}
if ! printf '%s\n' "$api_port" | grep -Eq '^[1-9][0-9]{0,4}$'; then
  echo "API_PORT must be a valid numeric local port." >&2
  exit 1
fi

echo "Checking local Compose configuration..."
$compose_cmd config --quiet

echo "Building Scryer containers..."
$compose_cmd build

echo "Starting Scryer services..."
$compose_cmd up -d

echo "Waiting for Scryer to become ready..."

attempt=0
max_attempts=30
while [ "$attempt" -lt "$max_attempts" ]; do
  if $compose_cmd exec -T postgres sh -ec 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1"' 2>/dev/null | grep -qx 1 && \
    curl -fsS "http://127.0.0.1:${api_port}/health" >/dev/null 2>&1 && \
    curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "Scryer is ready at http://127.0.0.1:3000"
    exit 0
  fi

  attempt=$((attempt + 1))
  sleep 2
done

echo "Scryer started, but the readiness checks timed out. Check docker compose logs for details." >&2
exit 1
