# Current local status

Outcome: `BACKEND_PARTIAL_LOCAL`.

Baseline: `453c2087399894ec2c89717e4d6f32b8d86dfafa`. Branch/worktree: `codex/backend-local` / sibling linked worktree. Original tree was clean and is untouched. The pre-push hook was tested directly and denied the call.

Active task: M5 reviewed local ingestion, after M3 native completion. M5-1 extracts bounded, deterministic bank CSV proposals from explicit mappings. M5-2 constructs a reviewed case and ledger atomically, requires production-case validation, checks repeat-import identity, and refuses stale or divergent heads. Nine client tests, including native CLI validation, pass. No proposal is approved automatically. The manual path and real-browser worker remain open. M3's C++20 core and versioned native CLI implement every operation in `contracts/engine-v1.md`; its 33 fixed corpus operations, 200 generated cases, and address/undefined sanitizer suite passed. The Python reference suite has 139 passing tests. This is local synthetic evidence only: WASM, auth/sync/crypto, and real-format validation remain open.

Observed baseline checks: frontend lint exit 0; legacy Python unittest exit 1 because `cryptography` is unavailable. Docker socket access is denied in the current sandbox. `emcc`, `cmake`, `pytest`, and `ruff` are absent from PATH. These limits block some later gates but do not block standard-library reference work.

Next executable action: follow Task 3 of `plans/2026-10-04-reviewed-import.md` for conservative source detection and reviewed manual facts. M4 remains `BLOCKED_TOOLING`: no local `emcc` was found, and automatic approval review rejected downloading the public SDK archive, citing the local-only prohibition on contacting remote repositories. No alternate download was attempted. A cached Chromium browser and local Playwright package are available for later browser tests, but they cannot build the WASM engine. Exact verification is in `verification.md`.
