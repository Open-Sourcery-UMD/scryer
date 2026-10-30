# Local Compose stack hardening design

## Purpose

Make the checked-in Compose stack safe and predictable for synthetic local development. The current stack uses a fixed database password, publishes PostgreSQL on every interface, treats a port check as database readiness, and runs the Next.js development server in a container. The legacy FastAPI entrypoint exposes only health routes; this work must not present it as the ciphertext sync API or as a public real-data service.

## Scope

- `setup.sh` creates a fresh 64-hex-character database password from local OS randomness when `.env` has none. It does not print the password. Existing weak or malformed values fail before containers start.
- Compose requires an explicit password. PostgreSQL is reachable only on the private Compose network; frontend and API host ports bind `127.0.0.1`.
- PostgreSQL readiness executes a real `SELECT 1` in the requested database. The backend depends on that health check; `setup.sh` checks it again before declaring ready.
- The frontend release image runs a successful Next.js build and starts `next start`. Its image does not run `next dev`.
- Fix the API host-port/container-port mismatch when `API_PORT` changes.
- Keep the named PostgreSQL volume so ordinary stop/restart preserves data. Never call `down -v` in setup.
- Update README and `.env.example` to match the current student-aid evidence product and local-only stack.

## Proof and limits

Tests render Compose with and without a secret, inspect service port bindings, health commands, and volume wiring; setup tests use fake Docker/curl commands and a temporary directory. The real Docker daemon is unavailable in this environment, so image builds, actual database persistence after restart, and full frontend/API/database operation remain unverified. No real records or remote services are used.
