# Native C++20 Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This assignment has already authorized local inline execution and local commits; no optional approval pause is needed. No subagents are authorized by the current session.

**Goal:** Build a deterministic C++20 native engine and CLI that reproduces the frozen Python reference corpus, then extend it to the remaining required native operations without sending plaintext to a server.

**Architecture:** A hostile-input JSON boundary validates size, nesting, duplicate keys, and version before constructing owned typed domain objects. Pure query functions operate only on the validated event DAG and return stable semantic values. One native CLI links the same core that M4 will compile to WASM; Python stays an independent differential oracle.

**Tech Stack:** Apple clang 21.0.0 with C++20 and `make` locally; pinned, vendored nlohmann/json 3.12.0 single header only after SHA-256 and license verification; a portable, licensed SHA-256 implementation or dependency pinned before receipt work. No CMake or Emscripten is currently on PATH. The [official nlohmann release](https://github.com/nlohmann/json/releases/tag/v3.12.0) publishes the expected `json.hpp` SHA-256 `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63`.

**Spec:** `docs/backend/contracts/case-v1.schema.json`, `docs/backend/contracts/engine-v1.md`, `docs/backend/domain-semantics.md`, `docs/backend/requirements.yaml`, and the 33-operation synthetic manifest at `tests/reference/corpus/manifest.json`.

## Global Constraints

- Local-only work and commits; no push, remote CI, deployment, real financial data, or third-party source upload.
- Cross-language money is signed 64-bit exact cents serialized as canonical decimal strings; no binary float.
- Case documents are bounded to 20 MiB and 200000 events; any lower parser limit needs a recorded rationale before implementation.
- All semantic operations take explicit case, heads/cutoff, and options; no hidden clock, network, randomness, or global mutable state.
- Invalid or over-limit work returns a typed incomplete/error result and never a financial no-match claim.
- Native and WASM share production source; M4 separately proves WASM/browser parity.
- Every task ends with a red-green test cycle, focused self-review, full currently runnable suite, and one meaningful local commit.

## Review Focus

1. Duplicate JSON keys or deeply nested input must return typed rejection without stack exhaustion (Task 2 tests).
2. A source correction on a divergent DAG branch must not be silently selected by event ID or timestamp (Task 3 tests).
3. Large exact-cent sums must report overflow before narrowing, including intermediate totals (Tasks 1 and 4 tests).
4. Parent-directed refunds and unknown bank holders must not become student-bank suggestions (Task 6 tests).
5. A valid old receipt must remain reproducible after later corrections, while explicit reanalysis produces a distinct digest (Task 5 tests).

---

## File map and ownership

| File or directory | Responsibility |
| --- | --- |
| `engine/Makefile` | Reproducible local native targets; no networked build step. |
| `engine/vendor/` | Pinned JSON/hash source, license, checksum record. |
| `engine/include/scryer/error.hpp`, `money.hpp`; `engine/src/money.cpp` | Stable typed failures and checked cent conversion/arithmetic. |
| `engine/include/scryer/json_boundary.hpp`; `engine/src/json_boundary.cpp` | Hostile-input parsing, duplicate/depth/size rejection, canonical JSON output. |
| `engine/include/scryer/case.hpp`; `engine/src/case.cpp` | Owned domain records, cross references, event DAG, causal snapshots. |
| `engine/include/scryer/projection.hpp`; `engine/src/projection.cpp` | School surplus, historical heads, exact attribution. |
| `engine/include/scryer/receipt.hpp`; `engine/src/receipt.cpp` | Canonical receipt and explicit historical reproduction/reanalysis. |
| `engine/include/scryer/coverage.hpp`, `matching.hpp`, `lifecycle.hpp` and matching `src/` files | Bank coverage, reviewed allocations, aid lifecycle and gross/net evidence. |
| `engine/include/scryer/api.hpp`; `engine/src/api.cpp`, `engine/src/cli.cpp` | Versioned operations and file/stdin CLI boundary. |
| `tests/engine/` | Small native unit programs, hostile-input cases, fixed corpus runner, seeded differential harness. |

## Task 1 — Exact native money and build skeleton

**Interfaces:** `parse_minor(std::string_view)->int64_t`, `parse_us_decimal(std::string_view)->int64_t`, `checked_add(int64_t,int64_t)->int64_t`, `checked_negate(int64_t)->int64_t`; errors carry a stable code without private input text.

- [x] Write `tests/engine/test_money.cpp` and a minimal `engine/Makefile` test target for canonical zero, malformed signs/leading zeros, US commas/parentheses, precision rejection, i64 limits, addition overflow, and `INT64_MIN` negation.
- [x] Compile/run the test expecting missing money declarations: `make -C engine test-money` exits nonzero for the intended missing interface.
- [x] Implement `error.hpp`, `money.hpp`, and `money.cpp` using only C++20 standard library; no floating point or locale dependency.
- [x] Run `make -C engine test-money`, then the Python reference suite; require both exit 0.
- [x] Self-review signed overflow and string-view lifetimes; commit Task M3-1.

## Task 2 — Bounded JSON boundary and pinned parser

**Interfaces:** `using Json = nlohmann::json` in `json_boundary.hpp`; `parse_document(std::string_view)->Json`, `canonical_json(const Json&)->std::string`, with exact duplicate-key, UTF-8, depth, size, and number-type checks. Use nlohmann/json only if the downloaded header matches the pinned SHA-256 and license; do not relax validation to accommodate its defaults.

- [x] Write `tests/engine/test_json_boundary.cpp`: duplicate key fails, 65-level nesting fails at documented max 64, malformed UTF-8 fails, 20 MiB bound fails, semantically equivalent object key order produces identical canonical bytes.
- [x] Run `make -C engine test-json` expecting failure before implementation.
- [x] Download the public release asset under existing network controls, verify checksum/license, record source/version; on denied download keep this task `BLOCKED_TOOLING` and continue independent native money work.
- [x] Implement bounded preflight plus duplicate-key parse callback; keep source strings owned and reject JSON numeric money at case validation.
- [x] Run focused native test, Python suite, and sanitizer target if the local runtime supports it; commit Task M3-2.

## Task 3 — Strict case parser and causal snapshots

**Interfaces:** `using Heads = std::span<const std::string>` in `case.hpp`; `parse_case(const Json&)->Case`, `snapshot(const Case&, Heads)->std::vector<const Event*>`, `heads_as_known(const Case&, std::string_view utc)->HistoryResult`. Mirror `case-v1.schema.json` fields and stable Python error categories.

- [x] Write tests for the golden case, absent references, duplicate IDs, term/account/recipient/proposal bindings, duplicate review IDs, cycle/missing parent, event permutation, and incomparable correction branches.
- [x] Run native tests expecting failures.
- [x] Implement owned records and deterministic topological order; reject unknown fields, bad dates/instants, noncanonical money, unsupported currency, and invalid causal links.
- [x] Extend `scryer_reference/scenarios.py` with `generate_raw_case(seed: int)->dict` while preserving `generate_case(seed: int)->Case`, then run native focused tests and 200 generated raw-case validation comparisons; commit Task M3-3 after self-review.

## Task 4 — Projection, history, and attribution

**Interfaces:** `project_school_surplus(const Case&, Heads, term_id)->Projection`, `compare_school_surplus(const Case&, Heads before, Heads after, term_id)->Comparison`; `HistoryResult` from Task 3 maps cutoffs to heads without imposing global clock order.

- [x] Add golden 150000→90000 tests, corrected-source 90000→70000→100000 tests, canceled charge, overflow, manual-source status, unrelated evidence, and divergent correction tests.
- [x] Run focused native tests expecting failures.
- [x] Implement checked per-fact signed contributions and exact delta attribution using immutable snapshot inputs.
- [x] Compare all fixed project/compare/history operations to `tests/reference/corpus/manifest.json`; run 200 seeded differential cases; commit Task M3-4.

## Task 5 — Canonical receipts and historical reproduction

**Interfaces:** `make_receipt(const Case&, Heads, term_id, producer_version)->Json`, `reproduce_receipt(const Case&, const Json&)->Json`, `reanalyze_receipt(const Case&, const Json&, Heads)->ReanalysisResult`.

- [x] Add independent expected digest cases from the manifest, tampered arithmetic/source/unknown-version negatives, and old-receipt-after-correction tests.
- [x] Run focused tests expecting failures.
- [x] Pin a portable licensed SHA-256 implementation, verify NIST vectors, and emit canonical ASCII JSON matching the Python receipt subset exactly.
- [x] Compare receipt bytes and digests across all fixed receipts; run independent Python checker on native output; commit Task M3-5.

## Task 6 — Coverage, matching, and aid lifecycle

**Interfaces:** `evaluate_bank_coverage`, `suggest_refund_deposits`, and `project_aid_lifecycle` mirror the Python reference result fields; every output includes stable status, exact amounts, and reason/finding codes.

- [x] Add source period/retraction, split/overallocated deposits, recipient mismatch/unknown/exception, annual aid, work-study, gross/fee/net, and missing-fee tests from the named fixtures.
- [x] Run focused tests expecting failures.
- [x] Implement bounded interval union, per-account matching with reviewed allocations, and evidence-only aid lifecycle; preserve uncertainty and typed limits.
- [x] Compare all fixed coverage/matching/lifecycle operations and 200 seeded supported cases; commit Task M3-6.

## Task 7 — Complete native operation surface and CLI

**Interfaces:** `evaluate(const Request&)->Response` supports capability/schema inspection, validate, current/historical/timeline, comparison, coverage, matching, discrepancy queue, source/calculation traversal, receipt, batch, and synthetic demo. CLI has `--help`, `--version`, `--input`, `--output`, stdin/stdout, typed nonzero failures, and no partial success output. Freeze each request/response variant in `docs/backend/contracts/engine-v1.md` before its implementation.

- [x] Add CLI integration tests for all named operations, error exit codes, 20 MiB input limit, stdout atomicity, explicit output paths, and the complete synthetic $1,500→$900 demo.
- [x] Run tests expecting the missing CLI executable; the first run failed at that boundary.
- [x] Implement only contract-defined semantics; unsupported domain cases return typed unsupported/incomplete errors, never placeholder success.
- [x] Run all 33 fixed corpus operations through the native CLI, 200 seeded differential cases, sanitizer build, and repeatability check; record native-only limits and commit Task M3-7.

## Gate to M4

M3 is `VERIFIED_LOCAL` only after every required native operation has executable evidence, the complete fixed corpus matches, receipt checker validates native receipts, and the native CLI is buildable without network access. Record measured runtime/memory and unresolved requirements. M4 then compiles these same sources to WASM and proves real-browser behavior; no native result alone closes the browser release gate.
