# M8-5a read-only branch analysis

**Goal:** Give a reviewer deterministic, browser-only evidence about divergent approved histories before any merge is attempted. This is not a merge command or permission to publish either branch.

**Task ID and risk:** M8-5a, HIGH. **Requirements:** S-16, S-60, S-69. **Depends on:** M8-4 authenticated conflict preview. The analyzer consumes a validated `ConflictPreview` and never accesses the network, storage, or encryption keys. Its output is a set of opaque IDs and issue codes; the two complete branches remain in the preview for actual review.

**Design choice:** Compare events by ID and canonical JSON structure, independent of object member enumeration order. Report shared events, local-only events, and remote-only events. Flag same-ID/different-payload collisions, two branch-only approvals for one fact ID, branch-only corrections of one fact, and branch-only match decisions concerning the same refund, including different bank credits. Report non-event case and review-ledger differences for later resolution. Sort every output by code and ID for deterministic results. Do not infer that shared events prove a complete common ancestor: the case also contains non-event metadata, and the app has not recorded a verified ancestor package. Do not union arrays, select a winner, commit a local revision, or acknowledge a sync operation.

**Alternatives reviewed:** Automatic event union is unsafe because same IDs, corrections, match decisions, and non-event metadata can conflict. Last-writer-wins would discard approved history. Server-side analysis would expose plaintext. A conservative read-only report allows review while preserving both encrypted branches.

**Interface:** `analyzeConflictPreview(preview: ConflictPreview): ConflictAnalysis` in `client/sync/analysis.ts`. `ConflictAnalysis` contains sorted `sharedEventIds`, `localOnlyEventIds`, `remoteOnlyEventIds`, `differentCaseFields`, `differentLedger`, and typed `issues` with only opaque IDs. Bad or structurally inconsistent preview inputs fail `INVALID_CONFLICT_PREVIEW`; the real preview path has already authenticated and semantically validated each branch.

**Files:** `client/sync/analysis.ts`, `tests/client/test_conflict_analysis.mjs`, the existing Chrome conflict test, and the sync contract, requirements, task, status, and verification ledgers.

**Invariants:** Analysis is pure and deterministic for the same validated branches; it never returns monetary values or source text; a same-ID/different-payload event is never classified as shared; concurrent changes are flagged rather than resolved; no analysis result is a merge authorization.

**Tests:** Synthetic divergent case branches with independent object-key ordering produce stable common/unique sets. A changed event under one ID, cross-branch approval of the same fact, concurrent correction, and repeated match decision each produce a distinct issue. Changed artifacts/proposals or review ledger are reported, not auto merged. Swapping local/remote preserves symmetric issue identities. No output includes source text or amounts.

**Verification command and expected result:** `cd client && npm run typecheck && npm test && npm run build:browser`, then `SCRYER_BROWSER_BIN=<local Chrome> npm run test:browser`; all commands exit 0, with 35 headless and 34 Chrome tests. Inspect `git diff --check`, review the diff, and commit locally. The previous Chrome/API/PostgreSQL gate remains valid because this slice has no transport or database change.

**Done when:** The unit and actual Chrome tests show deterministic ID-only branch analysis, all tests pass, a focused reviewer has no unresolved Critical/Important finding, and one local commit records the slice. The reviewed merge remains open.

**Open gate:** A future reviewed resolution needs an explicit common-ancestor contract, decisions for every issue and metadata difference, native/WASM semantic validation, atomic preservation of the losing branch, and a new server CAS precondition. M8 remains `IN_PROGRESS`.
