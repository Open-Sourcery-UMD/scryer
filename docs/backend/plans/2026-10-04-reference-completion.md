# Reference Completion Before C++ Porting

**Goal:** Close the remaining reference-contract gaps before freezing the native engine's input and golden corpus.

**Boundary:** Python reference and synthetic local tests only. No hosted data, publication, or UI. The case schema is unreleased and has no persistent production data; shape corrections are explicit and tested. M3 depends on this plan, not merely on initial matching tests.

## Review decisions

- A case and every approved monetary fact name `USD`; unsupported or mixed currency is rejected before aggregation or matching. Corrections and allocations inherit their referenced fact currency.
- Lifecycle stages are independent evidence observations. A later stage does not manufacture an earlier stage. Offer/accepted/pending/balance snapshots do not enter posted school surplus.
- “As known” queries use a caller supplied approved journal head or a declared UTC cutoff mapping. Divergent eligible heads yield ambiguity; device timestamps are not treated as global truth.
- Synthetic release scenarios must contain hand checked expected values and adversarial negatives. Current unverified UMD format compatibility stays blocked.

### Task 1 — M2-6a: Explicit currency binding

**Requirements:** S-14, S-15, S-17, S-24. **Depends on:** M2-5c.

**Files:** `scryer_reference/model.py`, `projection.py`, `receipt.py`, `check_receipt.py`, `scenarios.py`, `docs/backend/contracts/case-v1.schema.json`, `tests/reference/fixtures/golden-case.json`, and reference tests.

**Interface:** Case has `currency: "USD"`; every approved monetary fact has `currency: "USD"`. Receipts, projections, and match results carry currency. Proposal linkage is M2-6b.

- [x] Write failing tests for accepted USD, unsupported case currency, unsupported fact currency, in-memory mixed currency, receipt currency tampering, and exact unchanged golden arithmetic.
- [x] Run failing focused tests: the old parser rejected the new contract, and the old projection accepted an in-memory mixed case.
- [x] Extend strict parser/schema, fixtures/generator, projection, matching preconditions, and independent receipt checker.
- [x] Run focused and full reference tests, seeded receipt checks, JSON parse, and diff checks.
- [x] Inspect staged diff and commit `feat(reference): reject unsupported financial currency` with M2-6a and observed verification.

### Task 2 — M2-6b: Link approved facts to reviewed proposals

**Requirements:** S-14, S-17, S-24. **Depends on:** M2-6a.

**Files:** `scryer_reference/model.py`, `scenarios.py`, case schema, synthetic fixtures, and reference tests.

**Interface:** A parser proposal records its parser/mapping versions, raw source value, source location, and optional normalized proposed cents. An approved fact may reference that proposal; its source artifact/location must agree. A null proposal link means explicit manual transcription from an artifact or a manually entered fact. Reviewed edits preserve both proposed and approved values.

- [x] Write failing tests for reviewed edits, source mismatch, missing proposal, one-proposal duplicate approval, unreviewed proposals, and parser/mapping version bounds.
- [x] Extend strict schema, parser, receipt, and independent checker without allowing proposal-only monetary effects.
- [x] Run goldens, full suite, seeded checks, and commit a passing change.

### Task 3 — M2-6c: Aid lifecycle evidence and findings

**Requirements:** S-18, S-19, S-21, S-22, S-24. **Depends on:** M2-6b.

**Files:** case contract/model, `scryer_reference/lifecycle.py`, finding contract, synthetic fixtures, `tests/reference/test_lifecycle.py`.

**Interface:** `AidItem(aidItemId, institutionId, termId|null, recipientKind)` stores a local explicit relationship, not institutional authentication. `Fact.aidItemId` is nullable; only linked aid offer, acceptance, pending, work-study offer, and school credit facts enter an item lifecycle. Annual items have a null term and cannot be allocated to a term implicitly. `project_aid_lifecycle(case, heads, term_id, aid_item_id)` returns observed stages, exact posted cents, and stable finding/next-action codes. Multiple offer snapshots without an explicit correction remain ambiguous. It must not infer eligibility, a mandatory sequence, or an expected refund from surplus alone.

- [x] Freeze role and aid-item schema with negative tests for no implicit annual-to-term split, work-study, parent recipient, pending replacement, balance snapshot, and out-of-order evidence.
- [x] Implement lifecycle evidence projection and deterministic finding/next-action codes with approved fact/source links.
- [x] Test corrected/canceled/split aid and multiple terms; run full suite and commit coherent passing change.

### Task 4 — M2-6d: Historical mapping and release corpus

**Requirements:** S-16, S-19, S-22, S-23, S-24, S-26. **Depends on:** M2-6c.

**Files:** `scryer_reference/history.py`, scenario corpus, receipt/checker extensions, reference tests, `docs/backend/verification.md`.

**Interface:** `heads_as_known(case, cutoff_utc)` returns an explicit unique approved head or typed ambiguity; historical queries retain schema/rule/engine versions and source identities. Reanalysis under a later rule is a separate operation.

- [ ] Add hand checked current/historical goldens and event enumeration permutation tests distinct from changed review histories.
- [ ] Test simultaneous/incomparable branches, uncertain timestamps, corrections, source reimport, repeated equal movements, and interaction limits.
- [ ] Build a deterministic seeded corpus manifest and expected results for native/WASM parity; record unsupported scenarios as open requirements.
- [ ] Run reference and corpus gates, inspect diff, and commit a passing, reviewable change.
