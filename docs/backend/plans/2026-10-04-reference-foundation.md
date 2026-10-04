# Independent Reference Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independently testable Python oracle for exact money, immutable knowledge snapshots, school-surplus projection, change attribution, and verifiable receipts.

**Architecture:** Use a small standard-library package `scryer_reference` that validates untrusted JSON into immutable typed records. Projection operates on the transitive closure of explicit journal heads, not wall-clock order. A separate receipt checker recomputes arithmetic and reference integrity from the supplied case without importing a production engine.

**Tech Stack:** Python 3.13 standard library, `unittest`, JSON Schema as a human/tooling contract; no package download for this slice.

**Spec:** `docs/backend/domain-semantics.md` and `docs/backend/contracts/engine-v1.md`.

## Global Constraints

- V1 accepts USD only; JSON cents are canonical decimal strings in signed i64 range.
- No floats, inferred term split, inferred refund entitlement, or unreviewed proposal effects.
- Every knowledge query names journal head IDs; replay of fixed events is permutation invariant.
- Concurrent corrections are not ordered by ID/time; they yield an explicit contradiction.
- All fixtures are synthetic; no product runtime or test needs external network access.

## Review Focus

- An event with a missing parent or cycle must be rejected before financial evaluation; Task 2 tests both.
- The minimum signed i64 cannot be negated or made positive; Task 1 tests it.
- A correction branch tie must not be broken by lexicographic event ID; Task 3 tests it.
- Unrelated `refund_issued` and bank facts must not change school surplus attribution; Task 3 tests it.
- A receipt with a valid digest but changed arithmetic must fail the independent checker; Task 4 tests it.

---

### Task 1: Exact money

**Files:** Create `scryer_reference/money.py`, `scryer_reference/__init__.py`, `tests/reference/test_money.py`.

**Interfaces:** `parse_minor_units(text: str) -> int`, `parse_us_decimal(text: str) -> int`, `checked_add(left: int, right: int) -> int`, `checked_negate(value: int) -> int`. `MoneyError(ValueError)` carries a stable code and no financial input echo.

- [ ] Write tests with literal expectations for `"6500.00" → 650000`, `"(300.00)" → -30000`, `"1,234.56" → 123456`, `"0" → 0`, and invalid `"-0"`, `"01"`, `"1.234"`, malformed grouping, i64 overflow, and minimum-i64 negation.
- [ ] Run `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/reference -p 'test_money.py' -v`. Expected: missing module or function is the reason for failure.
- [ ] Implement the narrow parser with digit checks and checked integer operations; never convert via float.
- [ ] Run the same command and the full current reference suite. Expected: exit 0.
- [ ] Inspect the staged diff and commit `feat(reference): enforce exact USD cents` with task ID M2-1 and verification in the body.

### Task 2: Versioned immutable journal

**Files:** Create `scryer_reference/model.py`, `tests/reference/test_model.py`, `docs/backend/contracts/case-v1.schema.json`.

**Interfaces:** `load_case_json(document: str) -> Case`, `snapshot_events(case: Case, heads: tuple[str, ...]) -> tuple[Event, ...]`. `Case`, `Event`, `Fact`, `Correction`, and `SourceRef` are frozen dataclasses. Duplicate JSON keys, unknown fields, malformed dates/IDs, missing references/parents, cycles, and duplicate fact IDs are errors.

- [ ] Write tests for a literal minimal case, duplicate key, missing parent, cycle, duplicate event/fact ID, bad artifact reference, and permuted event input yielding the same snapshot order.
- [ ] Run targeted tests. Expected: missing parser/records failure.
- [ ] Implement strict parse and iterative or bounded DAG validation. Event order in input must not control snapshot semantics.
- [ ] Run targeted and full current reference suite. Expected: exit 0.
- [ ] Inspect diff and commit `feat(reference): validate approved event journal` with task ID M2-2 and verification.

### Task 3: Projection and exact change attribution

**Files:** Create `scryer_reference/projection.py`, `tests/reference/test_projection.py`, `tests/reference/fixtures/golden-case.json`.

**Interfaces:** `project_school_surplus(case: Case, heads: tuple[str, ...], term_id: str) -> Projection`; `compare_school_surplus(case: Case, before_heads: tuple[str, ...], after_heads: tuple[str, ...], term_id: str) -> Comparison`. Projections have typed status, optional integer amount, sorted fact IDs, and limitation codes; comparisons have exact signed per-fact contributions.

- [ ] Write the hand-calculated golden: before `150000`, after `90000`, delta `-60000`, grant correction `-30000`, new charge `-30000`. Add offer-only, pending-only, work-study, unreviewed proposal, duplicate source-position, event permutation, unrelated refund/bank fact, and incomparable correction tests.
- [ ] Run targeted tests. Expected: missing projection/behavior failure.
- [ ] Implement per-fact current state from causal corrections; return contradiction on incomparable correction maxima. Use checked arithmetic for totals and deltas.
- [ ] Run targeted and full current reference suite. Expected: exit 0.
- [ ] Inspect diff and commit `feat(reference): project and attribute school surplus` with task ID M2-3 and verification.

### Task 4: Receipts, checker, and seeded scenarios

**Files:** Create `scryer_reference/receipt.py`, `scryer_reference/check_receipt.py`, `scryer_reference/scenarios.py`, `tests/reference/test_receipt.py`.

**Interfaces:** `make_school_surplus_receipt(case: Case, heads: tuple[str, ...], term_id: str) -> dict[str, object]`; `check_receipt(case: Case, receipt: dict[str, object]) -> CheckResult`; `generate_case(seed: int) -> Case`. Receipt core has version, metric, heads, fact/source references, arithmetic steps, status, limitations, and SHA-256 digest over canonical ASCII JSON. Checker does not call `project_school_surplus` or a production engine.

- [ ] Write tests for honest golden receipt, changed amount with recomputed digest, altered digest, missing fact/source reference, unsupported version, and repeatability for a fixed seed.
- [ ] Run targeted tests. Expected: missing receipt/checker failure.
- [ ] Implement canonical serialization, deterministic generator, and independent step-by-step checker.
- [ ] Run targeted and full reference suite. Expected: exit 0; tamper tests fail the manipulated receipt.
- [ ] Inspect diff and commit `feat(reference): verify derivation receipts` with task ID M2-4 and verification.

## Self-review and continuation

Cross-check exact names, money range, event kinds, canonicalization, and expected values against the spec before each task. A plan defect gets a written ruling in the local ledger and a focused correction. After Task 4, the next dependency-ready work is C++ native implementation and a fuller matching/coverage corpus; do not claim the entire reference domain or backend is complete from these four tasks alone.
