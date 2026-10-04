# ADR 0005 — Signed, transaction-local PostgreSQL tenant context

Status: selected for the local sync database; validated on PostgreSQL 15.11 only. The intended PostgreSQL 16 image, API token boundary, and full lifecycle path remain unverified.

## Problem

A plain custom setting such as `SET scryer.account_id = 'acct-b'` is caller-writable by the ordinary PostgreSQL application role. An RLS policy that trusts only that setting would allow a SQL injection or an untrusted query to impersonate another account. Query filters in Python alone do not add a database boundary.

## Decision

Every tenant-owned table has forced RLS and a policy invoking `scryer_private.tenant_ok(account_id)`. The application role is not an owner, superuser, or `BYPASSRLS` role. A 32-byte random context key is generated outside Git, supplied separately to the API process and to a private database table, and unavailable to the application database role. After verifying an OIDC token and current account state, the API starts a database transaction, obtains that transaction's ID, and sets transaction-local account ID, transaction ID, and HMAC-SHA-256 over `accountId + "\n" + txid`. The private `SECURITY DEFINER` validator checks the account, transaction ID, and MAC before RLS exposes or accepts a row. It uses a fixed search path and static SQL. The settings disappear when the transaction ends.

The migration/administrative identity owns the schema and can update the private key. The ordinary role has no access to the key or schema-migration record. The deletion-job table is forced-RLS but withheld from the ordinary role until a separate worker identity and lifecycle protocol are implemented. Migration files are applied by one checksum-recording transactional authority; changed applied files and unknown future versions fail closed.

## Evidence and limits

`scripts/verify-sync-db.sh` creates a fresh, private Unix-socket PostgreSQL cluster when given a local binary path, then runs disposable-database tests. Six direct application-role tests observed: missing context denies rows; fake settings deny; a wrong key denies; changing a signed account to another denies; transaction replay denies; connection reuse without renewed context denies; own rows can be read and written while cross-tenant writes fail. Four migration tests observed fresh/repeat apply, changed-file rejection, failed-migration rollback with forward repair, and unknown future-version rejection. These are synthetic local tests, not a security audit.

This protects tenant rows against a caller who can issue SQL as the app role but cannot read the context key. It does not protect against compromise of the API process or its key, a malicious migration/administrative role, a forged OIDC token accepted by a broken verifier, or all timing/error side channels. The service must validate the token before signing a context and must keep the key out of logs, browser responses, and SQL parameters exposed to untrusted callers. Key rotation, backup/restore, independent human review, and PostgreSQL 16 compatibility remain release gates.

Per-tenant database login roles were rejected for v1 because creating, rotating, and revoking database credentials for every user would make the local stack more complex. An unsigned custom GUC was rejected because any app-role SQL caller can set it. A `SECURITY DEFINER` CRUD-only API remains an alternative but requires a larger stored-procedure surface and careful authorization of every operation.
