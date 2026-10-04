# Current local status

Outcome: `BACKEND_PARTIAL_LOCAL`.

Baseline: `453c2087399894ec2c89717e4d6f32b8d86dfafa`. Branch/worktree: `codex/backend-local` / sibling linked worktree. Original tree was clean and is untouched. The pre-push hook was tested directly and denied the call.

Active task: M3 native C++20 engine. Exact money, bounded JSON parsing, strict case validation, event ordering, causal snapshots, and historical cutoff mapping are implemented. M2-1 through M2-7c have observed red-green tests; the current reference suite has 138 passing tests, 200 seeded synthetic receipts independently checked and reproduced, and a 33-operation fixed synthetic reference parity corpus across ten case fixtures. The local Python reference now has explicit USD currency, proposal/version/value linkage, account-bound facts, aid-item lifecycle and gross/net findings, exact school-surplus projections, receipt verification, reviewed bank coverage/retraction, recipient-aware conservative matching, and causal UTC-cutoff history mapping. The RC-01 through RC-48 evidence map names the remaining gaps. M1's domain subset is sufficient for reference work; auth/sync/crypto gates remain open. M2 reference scope now includes reversal and historical receipt semantics. Native projection/receipt/matching, WASM parity, and browser imports remain open.

Observed baseline checks: frontend lint exit 0; legacy Python unittest exit 1 because `cryptography` is unavailable. Docker socket access is denied in the current sandbox. `emcc`, `cmake`, `pytest`, and `ruff` are absent from PATH. These limits block some later gates but do not block standard-library reference work.

Next executable action: follow Task 4 of `plans/2026-10-04-native-engine.md`: implement exact native school-surplus projection and attribution against the fixed synthetic corpus. The current native verification commands are `make -C engine test-money`, `make -C engine test-json`, and `make -C engine test-case case-probe`; all exited 0, as did address/undefined sanitizer runs. The 138-test Python reference suite and 200-case native validation parity exited 0. Record new uncommitted paths, commands, and results here if interrupted.
