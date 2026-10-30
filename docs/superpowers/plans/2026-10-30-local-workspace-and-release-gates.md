# Local workspace and release-gate continuation

Spec: `docs/backend/brief.md`, `docs/backend/contracts/`, and the approved December plan in `../output/scryer_december_2026_plan.md` (outside this worktree). All changes stay local and use synthetic test records.

## Decision

The browser import worker is already tested as a standalone ES module and resolves its own worker by URL. Stage its compiled modules as static frontend assets at build/start time. A personal-file screen may preview proposed rows, but it must label them unreviewed and must not approve, calculate from, sync, or persist them until the C++ WebAssembly validator is installed and verified. No server endpoint receives source bytes.

## Task 1: Offline preview surface

- Add a browser end-to-end test that opens `/workspace`, previews a synthetic CSV, sees exact candidate amounts and warning codes, verifies no network upload or local persistence, and sees unreviewed status. Run it first and observe failure because the route is missing.
- Stage the already-compiled headless import modules for Next dev/build without committing generated files. Add a clear, accessible file and column-mapping flow and make file replacement/unsupported formats clear prior preview state.
- Add tests for malformed and unsupported input, stale preview clearing, keyboard use, and narrow viewports; run frontend build/lint and the browser suite.

## Task 2: Hard dependency gates

- Inventory the local WebAssembly SDK and maintained JWT verifier. Do not download around the local-only approval boundary.
- Record executable, fail-closed release checks for browser-native semantic validation and real-token API verification. A missing dependency is a blocked result, never a pass or synthetic substitute.

## Task 3: Final local verification

- Run available native, Python, browser client, frontend, and API suites; record exact commands and results in `docs/backend/verification.md` and update `status.md` with remaining public-account and release gates.
- Review the full diff with a fresh reviewer, fix important findings test-first, and leave the branch local with a clean worktree.

## Review focus

Look for financial plaintext leaving the browser, stale proposal state after changing files, fake approval language, worker packaging drift, unsafe fallback when the validator/JWT verifier is unavailable, and inaccurate release claims.
