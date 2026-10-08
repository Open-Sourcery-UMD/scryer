# M8-5b authenticated historical base inspection

**Goal:** When a stale upload names an expected server revision, retrieve that retained encrypted revision and validate it in the browser as a candidate common base. Keep the current local and remote branches unchanged. The package is a candidate because a server response alone does not prove local derivation or freshness.

**Task ID and risk:** M8-5b, HIGH. **Requirements:** S-60, S-69. **Depends on:** M7-5 historical ciphertext read and M8-4 preview. **Files:** `client/sync/transport.ts`, `client/sync/conflict.ts`, focused client/Chrome tests, the synthetic browser/API/PostgreSQL journey, and backend contract/evidence ledgers.

**Design:** Extend conflict results with `ancestor`, a tagged union: `not_requested` when no server base was named, `unavailable` when the named historical revision returns tenant-scoped `404`, and `available` with exact bounded ciphertext, strong ETag, and matching revision. Other HTTP failures retain their existing retryable/permanent classification. Reject malformed or wrong-bound `200` responses. The preview decrypts an available ancestor under the same unlocked account root and semantic validator, returns its case/ledger in browser memory, and rechecks the saved pending operation and local ciphertext identity after every inspection. An invalid ancestor fails typed; it is never silently treated as absent.

**Alternatives reviewed:** Treating a matching revision ID as a proven common ancestor would overclaim; the local branch may have diverged from unrelated content under a reused ID. Making the server compare plaintext violates the privacy boundary. Hiding a missing historical revision would mislead reviewers. The tagged state keeps the uncertainty explicit.

**Interface:** `SyncResult` conflict carries `ancestor: {status:'not_requested'|'unavailable'} | {status:'available'; revisionId:string; etag:string; ciphertextBody:string}`. `ConflictPreview` returns a matching tagged state, with `branch: ConflictBranch` only when available. The existing analysis remains read-only and does not infer a merge from this field.

**Invariants:** An available ancestor revision equals the saved expected server revision; its exact canonical package binds account, case, revision, and ETag; the browser verifies every AES-GCM tag and semantic case; no preview writes, acknowledges, or sends plaintext; unavailable is distinct from invalid or unauthorized.

**Tests and command:** First run a failing transport test for historical retrieval and state tags, then a failing real Chrome test for authenticated ancestor preview and invalid ancestor refusal. Extend the synthetic browser/API/PostgreSQL conflict journey to verify that `rev-two` is recovered as the candidate base. Run `cd client && npm run typecheck && npm test && npm run build:browser`, `SCRYER_BROWSER_BIN=<local Chrome> npm run test:browser`, and the synthetic local integration with the private PostgreSQL socket and local libpq path. All commands must exit 0. Review the diff and make a local commit.

**Done when:** The real local stack's encrypted historical base is validated in Chrome, missing bases remain explicit, malformed bases fail closed, and a focused review has no unresolved Critical or Important defect. Reviewed merge, common-ancestor proof, and server freshness remain open.
