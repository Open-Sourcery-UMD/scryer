# Local Compose Stack Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove unsafe defaults and make the synthetic local Compose stack reproducible and honestly checked.

**Architecture:** Keep the existing three-service development shape. Generate a unique local database secret in `setup.sh`, require it in Compose, use a PostgreSQL query for readiness, bind public ports to loopback, and build/start Next.js in production mode. Tests use Compose's daemon-free config renderer and fake setup commands.

**Tech Stack:** POSIX shell, Docker Compose, PostgreSQL 16, FastAPI, Next.js 16, Python unittest.

**Spec:** `docs/superpowers/specs/2026-10-30-local-stack-hardening.md`

## Global Constraints

- Local-only, synthetic-data stack; no public service claim, push, deployment, or real financial records.
- Do not fetch dependencies or start a remote service.
- Full runtime verification requires a Docker daemon and remains open when unavailable.

## Review Focus

- A missing password must fail direct `docker compose config` before a database starts.
- An existing weak password must fail `setup.sh` without running `up`.
- Changing the host API port must not change the backend's container listener.
- PostgreSQL must not publish a host port; named volume must survive normal restart.
- A green frontend or API health endpoint must not be mistaken for a successful database query.

---

### Task 1: Secret and service-boundary contract

**Files:**
- Modify: `docker-compose.yml`, `.env.example`, `setup.sh`
- Create: `tests/local_stack/test_compose.py`, `tests/local_stack/test_setup.py`

**Interfaces:**
- Consumes: Compose CLI and local shell tools `od`, `tr`, `curl`.
- Produces: `.env` containing `POSTGRES_PASSWORD=<64 lowercase hex>` and daemon-free Compose config requiring that value.

- [ ] **Step 1: Write failing tests** for missing secret, loopback/no-database bindings, database SQL health, generated secret, and weak-secret refusal.
- [ ] **Step 2: Run `python3 -m unittest discover -s tests/local_stack -p 'test_*.py' -v`** and observe contract failures.
- [ ] **Step 3: Implement Compose and setup behavior** exactly as the spec states; do not source `.env` as shell code.
- [ ] **Step 4: Run the local-stack tests and `docker compose config --quiet` with a synthetic secret**; require all tests to pass.
- [ ] **Step 5: Commit explicit paths** with `fix(local): harden Compose secrets and readiness`.

### Task 2: Build and documentation contract

**Files:**
- Modify: `frontend/Dockerfile`, `Dockerfile.backend`, `README.md`, `frontend/README.md`
- Modify: `tests/local_stack/test_compose.py`
- Modify: `docs/backend/status.md`, `docs/backend/verification.md`

**Interfaces:**
- Consumes: Task 1 Compose contract and current Next.js `build`/`start` scripts.
- Produces: an image definition that builds frontend assets before starting the production server and a README that does not claim hosted or real-data readiness.

- [ ] **Step 1: Add a failing image-contract test** for `npm run build` and production start, and for a fixed 8000 backend listener.
- [ ] **Step 2: Run the local-stack tests** and observe the image-contract failure.
- [ ] **Step 3: Update Dockerfiles and current README** with the local-only setup, stop/restart, and limitations.
- [ ] **Step 4: Run local-stack tests, frontend build/lint/demo tests, Python reference, and client tests**; record that Docker daemon integration remains blocked.
- [ ] **Step 5: Commit explicit paths** with `chore(local): document and build the synthetic stack`.
