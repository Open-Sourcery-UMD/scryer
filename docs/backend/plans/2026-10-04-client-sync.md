# Headless browser sync execution plan

**Goal:** Transmit the encrypted IndexedDB outbox to `/v1` without re-encrypting, silently replacing a divergent server head, losing an offline edit, or persisting an access token. This plan extends Task 5 of `2026-10-04-sync-foundation.md`; real JWT verification remains a separate M7 gate.

**Interfaces:** `LocalRepository.prepareSync(caseId)` yields ordered immutable body strings and saved idempotency keys. `ackSync(operationId, confirmedRevisionId)` atomically removes only a confirmed operation and makes its local successor expect that committed server revision. `syncCase(repo, caseId, { baseUrl, accessToken, fetchImpl, signal })` returns a typed committed, idle, conflict, retryable, or permanent result. It never hands ciphertext to a semantic server route.

**Invariants:**

- A client sends a saved `step.body` string and key verbatim; `JSON.stringify` is never applied to an outgoing saved body.
- A manifest response is acknowledged only after its status, typed receipt, package digest, revision ID, and ETag agree with the saved manifest.
- A crash after server commit but before local acknowledgment leaves the old outbox operation for exact idempotent retry.
- Acknowledging one operation and setting the successor's expected server revision happen in one IndexedDB transaction. A later offline edit cannot reuse an old create precondition or skip its predecessor.
- A stale `412` preserves the local branch and surfaces the authorized encrypted remote head for reviewed conflict handling. It never overwrites the local case or calls `ackSync`.
- Authentication, malformed response, quota, and semantic conflict failures retain the outbox. Only bounded transport failures and documented `429`/`503` responses receive bounded retry with jitter.
- The configured API origin is HTTPS, or exact loopback HTTP for local tests; requests carry a memory-only bearer token, omit cookies, disable redirects, and use `no-store`.

## M8-1 — Durable outbox succession

**Requirements:** S-59, S-60, S-69. **Depends on:** M6-3 and M7-3. **Files:** `client/storage/repository.ts`, `tests/browser/test_storage.mjs`, `docs/backend/contracts/storage-v1.md`.

1. Add a failing Chrome test with two approved local revisions queued before any server acknowledgment. Confirm the second begins with an unresolved/old server precondition.
2. Require `ackSync` to receive the confirmed revision ID. In one `outbox` readwrite transaction validate the operation/revision, remove it, and set only the immediate next local sequence's expected server revision. Preserve all rows if any check fails.
3. Test a simulated transaction failure, duplicate acknowledgment, close/reopen after acknowledgment, and a later third edit. Verify no queued body or idempotency key changes.
4. Run client typecheck, headless suite, real Chrome storage suite, and inspect the staged diff before a local commit.

## M8-2 — Exact HTTP transport

**Requirements:** S-59, S-60, S-63, S-64, S-69. **Depends on:** M8-1 and M7-4a. **Files:** `client/sync/transport.ts`, `tests/client/test_sync_transport.mjs`, TypeScript build includes, sync contract and error catalog.

1. Write failures for unsafe origins, wrong authenticated account, changed or malformed saved responses, retryable network faults, `429`/`503` backoff, `401`/`409`/`413` stop, and `412` conflict preservation.
2. Send prepared chunks sequentially and manifest with an exact create/update precondition. Validate the account response before writing. Never follow a redirect or send cookies. Bound and validate all small receipts; preserve a saved operation on any nonvalidated response.
3. On `412`, fetch the encrypted remote head with the same token, return it as a conflict artifact, and keep the local queue. On success, call `ackSync` with the confirmed revision, then re-read the queue and continue through the offline chain.
4. Run offline TypeScript typecheck, headless tests, and real-browser tests; commit a coherent verified transport slice.

## M8-3 — Real local browser/API/database integration

**Requirements:** S-59, S-60, S-69. **Depends on:** M8-2. **Files:** local synthetic test fixture under `tests/sync/` and browser harness, operations/verification documentation.

Exercise actual Chrome fetch and IndexedDB against a loopback FastAPI process and disposable PostgreSQL database with a clearly marked unit-only token verifier. Verify exact outbox bytes in the database, a lost response followed by reload/retry, two distinct account identities, stale-head preservation, and deletion refusal. This establishes browser/API/DB transport behavior, **not** real JWT validity. Repeat after a real Keycloak access-token verifier is available; only that later test can close authenticated sync.

## Design review

The prior outbox stores each revision's initial expected server head, but consecutive offline edits can be queued before any response. Sending every saved `null` precondition as create would falsely conflict after the first upload. Changing the next request's precondition only in memory would lose the relationship on restart. The atomic acknowledgment-to-successor update resolves both while retaining exact body and idempotency key bytes. Remote divergence still returns `412` and requires reviewed resolution; no rule here chooses a financial-history winner.
