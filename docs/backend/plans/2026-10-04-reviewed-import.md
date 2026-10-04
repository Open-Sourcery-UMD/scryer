# Reviewed Local Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This assignment authorizes local inline implementation and commits; no subagents are authorized in the current session.

**Goal:** Build a bounded browser-safe CSV and manual import path that produces preserved proposals and commits approved case history only after explicit review.

**Architecture:** A strict byte/CSV preflight and a pinned browser parser create deterministic source-positioned proposals. A pure review transaction constructs the next v1 case and requires a production validator callback before returning it. UI and encrypted storage consume these headless results later.

**Tech Stack:** TypeScript 5.9.3, d3-dsv 3.0.1, Node 25 local test runtime, native C++ CLI as an independent validation boundary in tests. Cached packages only; no runtime network.

**Spec:** `docs/backend/contracts/import-v1.md`, `docs/backend/contracts/case-v1.schema.json`, `docs/backend/domain-semantics.md`, and ADR 0004.

## Global Constraints

- Synthetic fixtures only; no real financial records or remote product calls.
- Raw input ≤20 MiB, rows ≤100000, columns ≤256, decoded field ≤65536 UTF-8 bytes, total decoded cells ≤1000000.
- Money is checked i64 cents, serialized as canonical decimal strings; no floating point.
- No proposal has a financial effect before an explicit reviewed approval.
- Source positions and raw amount strings remain unchanged; CSV transaction extrema do not imply statement coverage.
- The case validator is mandatory at the review boundary; M4 browser integration remains blocked by unavailable WASM tooling until separately verified.
- Every task has a red-green cycle, focused self-review, relevant full suite, and one meaningful local commit.

## Review Focus

1. A quoted newline and comma must preserve one logical row and stable source position (Task 1).
2. Dense delimiters or a huge decoded field must fail before large row allocations (Task 1).
3. An ambiguous debit/credit row must not be approved as a deposit (Tasks 1–2).
4. Reimporting unchanged bytes must not create another approved event; equal rows from different positions remain distinct (Task 2).
5. A failed validation or canceled import must leave the original approved case untouched (Tasks 2–4).

## File map

| File | Responsibility |
| --- | --- |
| `client/package.json`, `client/package-lock.json`, `client/tsconfig.json` | Offline-installed pinned parser and typecheck/test entrypoints. |
| `client/import/errors.ts`, `limits.ts`, `csv.ts`, `money.ts`, `bank.ts` | Typed input failures, byte/field bounds, strict CSV parsing, exact cents, and bank proposals. |
| `client/import/types.ts`, `review.ts`, `manual.ts` | Case-compatible types and atomic reviewed commands. |
| `client/import/worker.ts` | Bounded browser worker dispatch/cancellation and no partial commit. |
| `tests/client/` | Synthetic parser, review, native-validation, and real-browser tests. |

## Task 1 — Bounded bank CSV proposals

**Requirements:** S-33, S-34, S-35, S-36, S-45; depends on M2-4. **Interfaces:** `extractBankCsv(bytes, metadata, mapping): Promise<ExtractedBatch>`; `ImportError.code`; explicit signed or split amount mapping. **Risk:** high, untrusted file input.

- [x] Pin cached d3-dsv/TypeScript dependencies and write failing tests for BOM, CRLF/LF, quoted newline/comma/quote, duplicate/missing headers, malformed UTF-8/quotes, exact money, repeated equal rows, 20 MiB/100000-row/256-column/64 KiB/1000000-cell limits, and no inferred coverage.
- [x] Run the tests expecting the missing extractor.
- [x] Implement strict bounded preflight, parser handoff, deterministic artifact/proposal IDs and source locations, and nullable unresolved proposals.
- [x] Run typecheck, focused and reference/native suites, inspect privacy/source identity, and commit M5-1.

## Task 2 — Atomic reviewed import

**Requirements:** S-17, S-40, S-41, S-42, S-45; depends on Task 1. **Interfaces:** `reviewImport(case,ledger,batch,decisions,command,validateCase): Promise<{case:CaseV1,ledger:ImportLedger,applied:boolean}>`; exact decision/event shapes in the contract. **Risk:** critical, financial journal integrity.

- [x] Write failing tests for full decision coverage, approved edited cents, rejected/debit rows, malformed IDs/heads/time, native case-validation failure, unchanged reimport, changed reimport conflict, and two equal legitimate row positions.
- [x] Run tests expecting missing review command and later a missing ledger-consistency check.
- [x] Implement all-or-nothing new-case construction with a mandatory validator, preserving original proposal bytes and source references.
- [x] Run native CLI case validation on the result, repeat import/metamorphic tests, typecheck, and commit M5-2.

## Task 3 — Manual and unsupported-document path

**Requirements:** S-37, S-38, S-39, S-40, S-45; depends on Task 2. **Interfaces:** `manualFact` and `detectSource` return typed `SUPPORTED_CSV`, `MANUAL_REQUIRED`, or `UNSUPPORTED_INPUT` outcomes; no claimed UMD layout selector. **Risk:** high, false source confidence.

- [x] Write failing tests for reviewed manual bank/school/refund facts, conservative PDF routing, source-authenticity limitations, and invalid manual corrections.
- [x] Run tests expecting missing interfaces.
- [x] Implement conservative detection and manual command using the same validator; document UMD format compatibility as `BLOCKED_EXTERNAL`. Precise scanned/encrypted/corrupt PDF diagnostics remain open because this slice has no PDF parser.
- [x] Run focused, native/reference, and type checks; commit M5-3.

## Task 4 — Browser worker and release scenarios

**Requirements:** S-34, S-36, S-42, S-44, S-45; depends on Tasks 1–3. **Interfaces:** typed worker messages with copied input and abort/cancel states; output remains proposals until review transaction. **Risk:** high, browser memory and lifecycle.

- [x] Write actual-browser tests for file reads, worker disposal/cancellation, repeated imports, malformed input, size limits, and no partial approved history from extraction.
- [x] Run browser tests expecting the missing worker.
- [x] Implement worker boundary and integration harness, including explicit source-unavailable status after another-device simulation.
- [x] Run browser/native/reference suites, update RC-12/13/17/24/44 and release evidence only where proven, then commit M5-4. Browser-side native/WASM validation and durable storage remain open.

## Gate to M6

M5 is `VERIFIED_LOCAL` only when declared formats and reviewed commands pass in a real browser, native/WASM validation is connected where required, and unsupported UMD layouts remain explicitly blocked. If M4's compiler gate remains blocked, complete and commit headless Tasks 1–3 while leaving this browser-integrated gate open.
