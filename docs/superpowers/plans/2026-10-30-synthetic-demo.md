# Synthetic Evidence Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an account-free, source-linked synthetic demo in the existing Next.js app, with figures reproduced from the native C++ engine.

**Architecture:** A local script records the native engine's versioned `demo` response as a checked-in JSON snapshot. The frontend renders that snapshot and performs exact formatting only. A drift test compares it with a fresh native run, while the release build produces static pages.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node.js tests, C++20 native CLI, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-10-30-synthetic-demo-design.md`

## Global Constraints

- All records are synthetic; no personal financial data or credentials enter the repository.
- `amountMinor` stays a decimal string until exact `BigInt` display formatting.
- The sample does not claim source authenticity, entitlement, or a confirmed refund-to-bank match.
- Work stays in the existing `backend-local` linked worktree; no remote operations.

## Review Focus

- A changed engine result must make the checked-in snapshot test fail. Task 1 tests this.
- Negative or large money values must be displayed without floating-point loss. Task 1 tests this.
- The unreviewed proposal must not appear as an approved change. Task 2 checks the displayed source set.
- A bank credit must not be labeled as a confirmed refund match. Task 2 checks copy.
- The page must always identify its sample data and limits. Task 2 checks rendered output.

---

### Task 1: Reproducible demo data and exact display money

**Files:**
- Create: `scripts/generate-demo-snapshot.mjs`
- Create: `frontend/data/demo-result.json`
- Create: `frontend/lib/format-money.ts`
- Create: `tests/frontend/test_demo_contract.mjs`
- Create: `tests/frontend/test_format_money.mjs`

**Interfaces:**
- Consumes: native CLI `{"schemaVersion":"1","operation":"demo"}` response.
- Produces: `frontend/data/demo-result.json` with `schemaVersion`, `engineVersion`, `operation`, and `result`; `formatUsdMinor(value: string): string`.

- [ ] **Step 1:** Write `test_demo_contract.mjs` to compare the checked-in JSON with a fresh native `demo` response and assert `150000`, `90000`, `-60000`, two `-30000` contributions, and distinct refund/bank observation facts.
- [ ] **Step 2:** Run `make -C engine cli && node --test tests/frontend/test_demo_contract.mjs`; expect failure because the snapshot is absent.
- [ ] **Step 3:** Implement the generator, run it, and rerun the same test; expect pass.
- [ ] **Step 4:** Write `test_format_money.mjs` for zero, positive, negative, and a value beyond JavaScript's exact integer range; run it and expect missing-module failure.
- [ ] **Step 5:** Implement `formatUsdMinor`, rerun both tests, and expect pass.
- [ ] **Step 6:** Commit only this task's files with `feat(demo): bind synthetic evidence to native engine`.

### Task 2: Public homepage and evidence demo

**Files:**
- Modify: `frontend/app/layout.tsx`
- Modify: `frontend/app/page.tsx`
- Modify: `frontend/app/globals.css`
- Create: `frontend/app/demo/page.tsx`
- Create: `tests/frontend/test_demo_render.mjs`

**Interfaces:**
- Consumes: `demo-result.json` and `formatUsdMinor` from Task 1.
- Produces: static `/` and `/demo` pages with navigation, source-linked attribution, a separate refund/bank distinction, and clear synthetic/limitation labels.

- [ ] **Step 1:** Write a build-output test that expects the homepage mission and the demo's synthetic label, exact before/after amounts, two causes, source inspector, and limitations.
- [ ] **Step 2:** Run the test against the current build; expect missing demo route/content.
- [ ] **Step 3:** Implement the pages and responsive styling. Display native receipt references and approved review IDs; do not display the unreviewed proposal as a fact.
- [ ] **Step 4:** Run frontend lint, optimized build, and the render test; expect pass.
- [ ] **Step 5:** Commit only this task's files with `feat(frontend): add source-linked synthetic aid demo`.

### Task 3: Reproducible local build commands and handoff

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/README.md`
- Modify: `docs/backend/status.md`
- Modify: `docs/backend/verification.md`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: local `npm run build` that avoids the sandbox Turbopack port-bind failure, and documented synthetic-demo verification commands.

- [ ] **Step 1:** Reproduce the current `npm run build` failure under the local sandbox; the baseline failure is recorded in the session.
- [ ] **Step 2:** Set the build script to Next's supported `--webpack` mode; add a `test:demo` command that builds the native CLI and runs the frontend contract and render tests.
- [ ] **Step 3:** Run `npm run lint`, `npm run build`, `npm run test:demo`, the Python reference suite, and headless client suite; expect all exit 0.
- [ ] **Step 4:** Document exact commands, source revision, and the remaining WASM/JWT/real-data limitations; commit explicit paths with `chore(frontend): make demo verification reproducible`.
