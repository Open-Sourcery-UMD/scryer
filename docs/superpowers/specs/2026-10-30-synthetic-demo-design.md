# Synthetic evidence demo design

## Intent

Implement the account-free synthetic demo required by S-54 in the December
2026 Scryer plan. A visitor should understand how a changed aid record and a
new charge changed the school-account surplus, and why a school-issued refund
and an observed bank credit are distinct pieces of evidence. The demo must
make clear that its records are fictional and that Scryer has not established
legal entitlement or authenticated a school or bank document.

## Scope and constraints

- This slice is a public, read-only sample. It accepts no personal files and
  creates no account or hosted financial data.
- The C++20 `demo` operation is the source of the displayed arithmetic,
  attribution, receipt, and source references. The checked-in snapshot is
  reproducible from the native engine and compared with it in tests.
- Browser financial computation for personal cases remains the WebAssembly
  milestone S-29. A static sample must never be presented as that milestone.
- Display minor-unit values exactly; never convert money to JavaScript
  floating point.
- Use the existing Next.js application and available local dependencies.
  Keep the page keyboard readable and responsive without relying on color
  alone for evidence status.
- Preserve the local-only and synthetic-data rules in `AGENTS.md`.

## Approaches

1. **Hand-code sample amounts in React.** Fast, but values can diverge from
   the engine and repeat the current mock-dashboard problem.
2. **Generate a versioned static snapshot from the native engine.** This
   yields a fast account-free page and gives CI a reproducible drift check.
   It does not execute C++ in the browser. **Chosen for S-54.**
3. **Wait for WebAssembly and build a live demo.** This shares the eventual
   personal-case runtime, but blocks a useful product demonstration on the
   currently unavailable SDK. It remains the S-29 integration path.

## User journey

The homepage states the mission and opens the sample. The demo presents the
fictional case, a before/after school-account surplus, the two exact causes
of the change, source-linked reviewed facts, and separate refund and bank
observation stages. An evidence inspector identifies source kind, location,
approval, and correction. Plain-language limitation text accompanies the
result. No copy implies that a bank observation proves it is the same refund.

## Completion evidence

The snapshot regeneration check agrees with the current native `demo`
operation. Unit tests cover exact money formatting and critical demo
invariants. The optimized frontend build renders the sample route and no
longer fails because Turbopack tries to bind a sandbox-prohibited port.

## Source contracts

- December issue plan: `../output/scryer_december_2026_plan.md` in the shared
  workspace, especially S-49 through S-54.
- Backend contract: `docs/backend/brief.md` and `docs/backend/contracts/engine-v1.md`.
- Native synthetic case: `tests/reference/fixtures/golden-case.json`.
