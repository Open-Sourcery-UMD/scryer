# Account Identity, Coverage, and Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the reference case with institution/account identity, then implement conservative bank-coverage and refund/deposit matching conclusions without conflating accounts or overallocating money.

**Architecture:** Keep the approved event DAG and exact money rules. Add explicit institution, term, and local account references to the case; every posted/refund/bank fact names its account. Coverage assertions and reviewed match decisions are new immutable events. Candidate generation is deterministic and bounded. No amount/date coincidence becomes an automatic confirmed match.

**Tech Stack:** Python 3.13 standard library, `unittest`, JSON Schema v1 local contract.

**Spec:** `docs/backend/domain-semantics.md`, `docs/backend/contracts/engine-v1.md`, and `docs/backend/reviews/2026-10-04-reference-self-review.md`.

## Global Constraints

- This is an internal pre-release schema correction, with synthetic fixtures only. There is no deployed data to migrate; future persistent stores still need versioned migrations.
- Financial JSON remains canonical signed i64 cents as strings. Source-backed matching is not document authentication.
- A bank transaction's date cannot establish full statement-period coverage. Coverage requires an explicit approved assertion tied to an account and half-open date interval.
- Candidate generation uses deterministic semantic operation/candidate caps and returns `COMPUTATION_LIMIT` when exceeded, never false no-match.
- User match decisions are journal events, cannot silently overallocate, and are reversible only through another reviewed event.

## Review Focus

- A bank credit from a different local account cannot satisfy a refund query for the selected account; Tasks 1 and 3 test this.
- A source-asserted period ending before the expected deposit window yields `INSUFFICIENT_COVERAGE`; Task 2 tests it.
- Two equal deposits remain `AMBIGUOUS` absent a reviewed decision; Task 3 tests it.
- Split deposits can be allocated exactly once, with remaining amount shown; Task 3 tests it.
- A candidate cap yields `COMPUTATION_LIMIT` rather than “no match”; Task 3 tests it.

---

### Task 1: Institution, term, and account identity

**Files:** Modify `scryer_reference/model.py`, `docs/backend/contracts/case-v1.schema.json`, `tests/reference/fixtures/golden-case.json`, `scryer_reference/scenarios.py`, `tests/reference/test_model.py`, `tests/reference/test_projection.py`, `tests/reference/test_receipt.py`.

**Interfaces:** `Case.institutions: tuple[Institution,...]`, `Case.terms: tuple[AcademicTerm,...]`, `Case.account_refs: tuple[AccountRef,...]`; `Fact.account_ref_id: str | None` and `Fact.term_id: str | None`. JSON top level replaces `termIds` with `institutions`, `terms`, and `accountRefs`. `Institution` has opaque `institutionId`; `AcademicTerm` has `termId`, `institutionId`, `schoolAccountRefId`, `startDate`, `endDateExclusive`; `AccountRef` has `accountRefId`, `kind` (`school` or `bank`), and nullable `institutionId`. An artifact may carry an optional account reference. Posted school/refund facts must use the term's school account, a bank credit must use a bank account and may have unknown term, and offer/pending/work-study may have null account.

- [x] Write failing tests for a valid single-institution fixture, unknown account, wrong account kind, a school account attached to another institution, a bank statement source/account mismatch, unknown-term bank credit, and term bounds. Update synthetic fixtures to include explicit identity fields.
- [x] Run targeted model/projection/receipt tests. The original parser rejected the new contract.
- [x] Extend parser/dataclasses/schema and update the generator. Project only facts on the requested term's school account; existing hand-calculated results remain exact.
- [x] Run targeted and full reference suite: 54 tests and 200 seeded synthetic receipt checks passed.
- [x] Inspect diff and commit `feat(reference): bind facts to institution and account` with task ID M2-5a and verification.

### Task 2: Explicit bank statement coverage

**Files:** Modify `scryer_reference/model.py`, `docs/backend/contracts/case-v1.schema.json`; create `scryer_reference/coverage.py`, `tests/reference/test_coverage.py`.

**Interfaces:** New `assert_coverage` event carries `coverageId`, `accountRefId`, `recordType`, `startDate`, `endDateExclusive`, `basis` (`source_asserted` or `user_asserted`), source reference, and review ID. `evaluate_bank_coverage(case: Case, heads: tuple[str,...], account_ref_id: str, start_date: str, end_date_exclusive: str) -> CoverageResult` returns `SUPPORTED_BY_UPLOADED_RECORDS`, `USER_ASSERTED`, or `INSUFFICIENT_COVERAGE` with the exact covered/missing intervals.

- [ ] Write failing tests for complete explicit period, user assertion, gap, wrong account, early end, and CSV extrema without any assertion.
- [ ] Run targeted tests. Expected: missing event/operation failure.
- [ ] Implement half-open interval validation and deterministic union; never infer completeness from observed bank transaction dates.
- [ ] Run targeted and full reference suite. Expected: exit 0.
- [ ] Inspect diff and commit `feat(reference): evaluate explicit bank coverage` with task ID M2-5b and verification.

### Task 3: Conservative matching and reviewed allocations

**Files:** Modify `scryer_reference/model.py`, `docs/backend/contracts/case-v1.schema.json`; create `scryer_reference/matching.py`, `tests/reference/test_matching.py`, synthetic matching fixtures.

**Interfaces:** `suggest_refund_deposits(case: Case, heads: tuple[str,...], refund_fact_id: str, bank_account_ref_id: str, candidate_limit: int = 1000, window_days: int = 30) -> MatchResult`. New `decide_match` journal event names one refund fact, one bank fact, nonnegative `allocatedMinor`, decision `confirm` or `reject`, and review ID. `MatchResult` carries explicit status, ordered candidate IDs, confirmed allocations, exact remaining minor units, coverage result, and reason codes. Candidate dates are from the refund-issued source date through day 30 inclusive by default; this is a search heuristic, not a payment deadline. `window_days` is bounded to 0–90; a missing refund source date prevents a confident time-window conclusion. Amount/date equality gives a suggestion only. No automatic confirmation is claimed in this profile.

- [ ] Write failing tests for one suggestion without confirmation, two equal candidates ambiguity, wrong account/term, split deposits, duplicate allocation, reviewed rejection, reversal/correction effect, a coverage gap, and candidate cap.
- [ ] Run targeted tests. Expected: missing operation/event failure.
- [ ] Implement bounded candidate filtering by term/account/currency/explicit date window; replay reviewed decisions causally and check refund/bank allocation sums before output.
- [ ] Run targeted and full reference suite. Expected: exit 0; no false definite nonpayment outcome.
- [ ] Inspect diff and commit `feat(reference): reconcile reviewed refund allocations` with task ID M2-5c and verification.

## Continuation gate

Update the release-corpus mapping and differential generator only after these named tests pass. C++ porting must not begin against an account-blind case contract. The Python reference is still incomplete until the remaining aid lifecycle, historical, receipt, and release-corpus scenarios are implemented and checked.
