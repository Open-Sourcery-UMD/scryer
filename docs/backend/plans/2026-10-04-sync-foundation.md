# Ciphertext sync foundation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the existing encrypted browser outbox a strict, versioned server contract and a PostgreSQL tenant boundary before exposing sync routes.

**Architecture:** The server accepts exact prepared ciphertext chunk bodies, then atomically publishes a manifest only after every chunk digest and the assembled package digest match. PostgreSQL retains ciphertext and opaque IDs; a transaction-scoped signed tenant context protects every tenant table under a nonowner application role. Authentication will supply the account identity, never a body field.

**Tech Stack:** Python 3.14, FastAPI 0.141.1, psycopg 3.3.5, PostgreSQL 15.11 for available local tests (release target 16 remains unverified), browser TypeScript and WebCrypto.

**Spec:** `docs/backend/contracts/storage-v1.md`, `docs/backend/contracts/crypto-v1.md`, `docs/backend/decisions/0003-identity-and-sync.md`, and sections 11–13 of the user-supplied backend brief.

## Global constraints

- Local-only synthetic data. No remote services, Docker images, or publication.
- No plaintext financial fields or payloads in server tables, routes, or logs.
- Account identity comes from a verified token plus current server account state; a body account ID can only be checked for equality.
- The browser's persisted outbox body and idempotency key are replayed byte-for-byte.
- The application database role cannot own tenant tables, bypass RLS, or read its tenant-context MAC key.
- No API success claim until token verification, database integration, and real local identity service are tested.

## Review focus

1. Duplicate JSON members or noncanonical encodings masquerading as the same request: Task 1 rejects them byte-for-byte.
2. A chunk from another account, case, revision, or package: Task 1 binds every field and Task 3 checks authenticated account identity.
3. Caller-controlled PostgreSQL `SET` spoofing an account: Task 2 checks missing, fake, and replayed signed context under the real app role.
4. A manifest arriving without all chunks or with one changed chunk: Task 3 refuses publication and preserves the old head.
5. A cached idempotent success after deletion: Task 3 checks lifecycle before replay.

---

### Task 1: Exact sync wire contract

**Files:** Create `docs/backend/contracts/sync-v1.md`, `sync/protocol.py`, `tests/sync/test_protocol.py`; update `docs/backend/decisions/0003-identity-and-sync.md` for observed browser/server size-profile differences.

**Interfaces:** `parse_chunk(body: bytes, expected_account: str) -> ChunkRequest`; `parse_manifest(body: bytes, expected_account: str) -> ManifestRequest`; `assemble_package(manifest: ManifestRequest, chunks: Sequence[ChunkRequest]) -> bytes`; `parse_precondition(value: str | None, creating: bool) -> str | None`; `request_digest(method: str, path: str, body: bytes, precondition: str | None) -> str`.

- [x] Write tests for exact keys/order, duplicate keys, canonical base64url, bounded sizes, wrong account, missing/changed/out-of-order chunks, and create/update preconditions.
- [x] Observe those tests fail for missing production interfaces.
- [x] Implement strict parser and assembler that reproduces the browser's canonical package bytes, then rerun targeted tests.
- [x] Run the complete existing Python and browser-relevant suites; inspect diff and commit a coherent M7-1 change.

### Task 2: Signed tenant context and forced RLS

**Files:** Create `migrations/0001_sync.sql`, `sync/db_context.py`, `sync/migrate.py`, `tests/sync/test_rls.py`, `tests/sync/test_migrations.py`, and a small isolated local test-cluster runner under `scripts/`; update the sync contract and local operations note.

**Interfaces:** `begin_tenant_transaction(conn, account_id: str, context_key: bytes)` sets transaction-local account, transaction ID, and HMAC. SQL function `scryer_private.tenant_ok(text)` validates those values before RLS grants access.

- [x] Write real PostgreSQL tests for no context, forged `SET`, replay across transactions, authorized own-row access, cross-tenant read/write denial, and role attributes.
- [x] Observe the missing migration/context code fail those tests.
- [x] Add migration, roles/grants/policies, and context helper; run the same tests on the private Unix-socket PostgreSQL cluster.
- [x] Record that PostgreSQL 15.11 is the available test target and PostgreSQL 16 remains a separate compatibility gate; inspect diff and commit M7-2.

### Task 3: Atomic opaque revision store

**Files:** Create `sync/store.py`, `tests/sync/test_store.py`; extend migration only with a new forward migration if Task 2 has already been applied to a shared database.

**Interfaces:** `stage_chunk(conn, account_id, idempotency_key, body) -> Receipt`; `commit_manifest(conn, account_id, idempotency_key, body, precondition) -> Receipt`; `get_head(conn, account_id, case_id) -> Head`; `delete_case(conn, account_id, case_id, precondition, idempotency_key) -> Receipt`.

- [ ] Write integration tests for lost response retry, key/content conflict, concurrent same-key requests, absent/stale head, missing or corrupt staged chunk, quota race, and delete/retry nonresurrection.
- [ ] Observe the intended failures; implement short transactions with account-row locking, revision/CAS checks, immutable idempotency results, and quota accounting.
- [ ] Run targeted and full tests, inspect the complete diff, and commit M7-3.

### Task 4: Token boundary and versioned HTTP API

**Files:** Create `sync/auth.py`, `sync/api.py`, `tests/sync/test_api.py`; adapt `main.py`; pin the maintained JWT verifier in the Python dependency lock.

**Interfaces:** A validated OIDC access token yields `(issuer, subject, audience)` and a server-derived opaque account ID. `/v1` routes return typed JSON errors and never ingest plaintext. Generated OpenAPI from FastAPI is the authoritative HTTP schema.

- [ ] Write API and token tests for forged/expired/wrong-audience/wrong-issuer/algorithm-confusion inputs, account disablement, body bounds, CORS, 401/409/412/413/428/429, and no sensitive response caching.
- [ ] Observe failures; implement with a pinned maintained verifier and trusted JWKS endpoint, then run tests with the real local provider.
- [ ] Keep this task `BLOCKED_TOOLING` if the verifier or provider cannot be installed/run locally; do not substitute a mock token for the release gate.

### Task 5: Official client transport and local operations

**Files:** Create `client/sync/`, tests in `tests/browser/` and `tests/sync/`; update `docker-compose.yml`, Dockerfiles, local setup/runbooks, and verification entrypoints.

**Interfaces:** The client consumes saved `PreparedSync` steps without re-encryption; only an authenticated successful manifest response may call `ackSync`.

- [ ] Test two synthetic accounts/devices, exact retry, stale conflict preservation, offline edits, account deletion, restart, backup/restore, and provider revocation limits.
- [ ] Run all available real-service and real-browser checks, then publish an honest local support matrix and commit M7-4/M8 foundations.

## Self-review

The plan follows the existing browser chunk/manifest bytes rather than defining an incompatible single-package API. The 8 MiB server envelope ceiling is narrower than the browser's 32 MiB local case ceiling, so larger cases remain local-only with an explicit sync error. The signed-context design must be tested against direct app-role SQL before calling RLS effective. A real OIDC provider and maintained verifier remain mandatory; passing the protocol or SQL tests alone cannot close M7.
