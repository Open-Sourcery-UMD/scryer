# M8 encrypted branch preview implementation plan

> **For agentic workers:** Use the existing local-only plan and test workflow. The user authorized documented design review and local execution without repeated approval pauses.

**Goal:** Let a browser verify and inspect both sides of a stale sync conflict without replacing either branch or acknowledging its pending outbox.

**Architecture:** `syncCase` already returns the exact authorized encrypted remote head after `412`. A new headless `previewSyncConflict` function validates that artifact, asks `LocalRepository` to decrypt and semantically validate the remote package with the unlocked account root, and returns the local and remote reviewed cases plus their maximal event heads. The preview performs no writes. A later reviewed merge protocol must establish domain rules and atomically supersede pending requests; this task does not choose a winner.

**Tech Stack:** TypeScript 5.9.3, WebCrypto, IndexedDB v2, local Chrome 154, synthetic cases only.

**Spec:** `docs/backend/contracts/sync-v1.md`, `docs/backend/contracts/storage-v1.md`, `docs/backend/domain-semantics.md`, and this plan.

## Global constraints and design review

- Keep all decrypted financial facts in browser memory; send no preview values to the ciphertext server.
- Reject a changed account/case/revision/ETag, noncanonical or oversized remote body, failed AES-GCM authentication, invalid decrypted case/ledger, or a stale local pending operation with typed codes. Bind the conflict artifact to the exact saved manifest digest, operation ID, and server revision precondition; compare the local ciphertext digest across inspection to detect reused revision IDs.
- Validate the remote under the repository's injected semantic validator. The Chrome test validator is synthetic; M4 C++/WASM browser validation remains blocked.
- Snapshot the first pending operation, local revision, and ciphertext digest, then recheck them after remote validation. Treat a local-read failure during root rotation as stale. A later commit must repeat preconditions because this is only a read-only preview.
- Do not change the outbox, case, anchor, root, or key-use budget. Keep server CAS and reviewed merge as separate work.
- Alternatives considered: automatic last-writer-wins loses approved history; automatic event union can hide same-ID/source conflicts and lacks a recorded review; server plaintext merge violates the privacy boundary. The selected preview exposes both authenticated branches and makes no decision.

## Task M8-4 — Authenticated local conflict preview

**Requirements:** S-57, S-59, S-60, S-69. **Depends on:** M8-3 and M7-9.

**Files:** `client/sync/conflict.ts` owns artifact validation and preview; `client/storage/repository.ts` exposes read-only validation of one remote encrypted package; `tests/browser/test_conflict_preview.mjs` exercises the actual browser; `tests/sync/test_client_integration.mjs` checks a real local API conflict artifact; update sync/storage contracts, task ledger, status, and verification evidence.

**Interfaces:** `previewSyncConflict(repo: LocalRepository, caseId: string, conflict: SyncResult): Promise<ConflictPreview>`. `ConflictPreview` returns the unchanged pending operation identity and revision ID, current local revision and validated case/ledger, remote revision and validated case/ledger, and sorted maximal event-head IDs. The repository's `inspectRemoteCase(package, caseId, revisionId)` authenticates and semantically validates a candidate without writing it.

**Invariants:** (1) the first pending operation still has the conflict's operation ID, revision, manifest digest, and server precondition; (2) the remote body is exact canonical JSON with its account/case/revision bound to the returned ETag; (3) both branches pass the same case/ledger validator; (4) a preview never acknowledges or replaces ciphertext; (5) a change to local revision, ciphertext digest, or first pending operation during validation returns `STALE_CONFLICT_PREVIEW`.

- [x] Write a failing Chrome test for two divergent encrypted branches sharing one account root, including preserved local outbox and no record mutation.
- [x] Add tamper, wrong-root, wrong account/case/revision/ETag, noncanonical/oversize, invalid semantic case, and stale-local refusals. The initial module-missing red test failed; focused regressions also failed before the operation-binding fix.
- [x] Implement read-only remote package inspection and `previewSyncConflict` with bounded parsing and typed errors.
- [x] Extend the synthetic Chrome/FastAPI/PostgreSQL conflict journey to preview the server-returned encrypted branch locally.
- [x] Run TypeScript typecheck/headless tests, complete Chrome suite, local browser/API/PostgreSQL integration, and inspect the diff.
- [x] Request focused automated review and fix Important findings. The reviewer found no remaining Critical or Important issues; make one coherent local commit with the exact evidence above.

**Done when:** The real Chrome and local service conflict artifact is decrypted and validated only in the browser, both branches remain available, and all refusal tests leave the local case and outbox unchanged. Reviewed branch merge, remote root rotation, real JWT verification, and M4 browser WASM remain open.
