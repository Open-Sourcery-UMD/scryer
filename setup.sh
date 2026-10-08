#!/usr/bin/env sh

set -eu

if command -v docker-compose >/dev/null 2>&1; then
  compose_cmd="docker-compose"
elif docker compose version >/dev/null 2>&1; then
  compose_cmd="docker compose"
else
  echo "Docker Compose is required to run Scryer."
  exit 1
fi

echo "Building Scryer containers..."
$compose_cmd build

echo "Starting Scryer services..."
$compose_cmd up -d

echo "Waiting for Scryer to become ready..."

attempt=0
max_attempts=30
api_port="${API_PORT:-8000}"

while [ "$attempt" -lt "$max_attempts" ]; do
  if curl -fsS "http://localhost:${api_port}/health" >/dev/null 2>&1 && \
    curl -fsS "http://localhost:3000" >/dev/null 2>&1; then
    echo "Scryer is ready at localhost:3000"
    exit 0
  fi

  attempt=$((attempt + 1))
  sleep 2
done

echo "Scryer started, but the readiness checks timed out. Check docker compose logs for details." >&2
exit 1
