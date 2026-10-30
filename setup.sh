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

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required to inspect the resolved Compose volume." >&2
  exit 1
fi

validate_env_format() {
  awk '
    /^[[:space:]]*($|#)/ { next }
    /^API_PORT=[0-9]+$/ { api++; next }
    /^POSTGRES_PASSWORD=[0-9a-f]+$/ { secret++; next }
    { invalid = 1; exit }
    END { if (invalid || api > 1 || secret > 1) exit 1 }
  ' .env
}

if [ -L .env ]; then
  echo "Refusing a symbolic-link .env file." >&2
  exit 1
fi
if [ -e .env ] && [ ! -f .env ]; then
  echo "Refusing a non-file .env path." >&2
  exit 1
fi
if [ -f .env ] && ! validate_env_format; then
  echo ".env must contain only comments, API_PORT=digits, and one canonical POSTGRES_PASSWORD=hex entry." >&2
  exit 1
fi
if [ "${POSTGRES_PASSWORD+x}" = x ] && { [ ! -f .env ] || ! grep -q '^POSTGRES_PASSWORD=' .env; }; then
  echo "Set POSTGRES_PASSWORD in .env before using a shell override; setup.sh will not store an unexpected shell secret." >&2
  exit 1
fi

if [ ! -f .env ] || ! grep -q '^POSTGRES_PASSWORD=' .env; then
  # Compose resolves the project name, so its volume name may differ from this folder's name.
  # This placeholder exists only for config rendering; it is never stored or used to start services.
  placeholder=0000000000000000000000000000000000000000000000000000000000000000
  if ! volume_name=$(POSTGRES_PASSWORD="$placeholder" $compose_cmd config --format json |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["volumes"]["postgres_data"]["name"])'); then
    echo "Could not resolve the PostgreSQL volume from Compose configuration." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1 || ! volume_names=$(docker volume ls --format '{{.Name}}'); then
    echo "Could not inspect local Docker volumes; start Docker and rerun setup.sh." >&2
    exit 1
  fi
  if printf '%s\n' "$volume_names" | grep -Fxq "$volume_name"; then
    echo "An existing PostgreSQL volume has no matching password in .env. Restore its original .env or rotate the database password explicitly; no data was changed." >&2
    exit 1
  fi

  if [ ! -f .env ]; then
    umask 077
    cp .env.example .env
  fi
  local_password=$(LC_ALL=C od -An -N32 -tx1 /dev/urandom | tr -d '[:space:]')
  printf '\nPOSTGRES_PASSWORD=%s\n' "$local_password" >> .env
fi
chmod 600 .env

file_password=$(sed -n 's/^POSTGRES_PASSWORD=//p' .env)
if ! printf '%s\n' "$file_password" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "POSTGRES_PASSWORD must be a 64-character lowercase hex secret. Remove a weak value and rerun setup.sh." >&2
  exit 1
fi
if [ "${POSTGRES_PASSWORD+x}" = x ] && [ "$POSTGRES_PASSWORD" != "$file_password" ]; then
  echo "Shell POSTGRES_PASSWORD differs from .env; unset it or restore the matching value." >&2
  exit 1
fi

file_api_port=$(sed -n 's/^API_PORT=//p' .env | tail -n 1)
api_port=${API_PORT:-${file_api_port:-8000}}
if ! printf '%s\n' "$api_port" | grep -Eq '^[1-9][0-9]{0,4}$' || [ "$api_port" -gt 65535 ]; then
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
  if $compose_cmd exec -T postgres sh -ec 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM pg_hba_file_rules WHERE type LIKE '\''host%'\'' AND auth_method = '\''trust'\'')"' 2>/dev/null | grep -qx 1 && \
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
