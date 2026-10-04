# Current local status

Outcome: `BACKEND_PARTIAL_LOCAL`.

Baseline: `453c2087399894ec2c89717e4d6f32b8d86dfafa`. Branch/worktree: `codex/backend-local` / sibling linked worktree. Original tree was clean and is untouched. The pre-push hook was tested directly and denied the call.

Active task: M3 native C++20 engine. Exact money, bounded JSON parsing, strict case validation, event ordering, causal snapshots, historical cutoff mapping, school-surplus projection/attribution, canonical receipts, reviewed bank coverage, recipient-aware matching, and aid lifecycle are implemented in the native core. M2-1 through M2-7c have observed red-green tests; the current reference suite has 139 passing tests, 200 seeded synthetic receipts independently checked and reproduced, and a 33-operation fixed synthetic reference parity corpus across ten case fixtures. The RC-01 through RC-48 evidence map names the remaining gaps. M1's domain subset is sufficient for reference work; auth/sync/crypto gates remain open. The native production CLI, WASM parity, and browser imports remain open.

Observed baseline checks: frontend lint exit 0; legacy Python unittest exit 1 because `cryptography` is unavailable. Docker socket access is denied in the current sandbox. `emcc`, `cmake`, `pytest`, and `ruff` are absent from PATH. These limits block some later gates but do not block standard-library reference work.

Next executable action: follow Task 7 of `plans/2026-10-04-native-engine.md`: freeze and implement the full native versioned operation surface and local CLI. The native unit targets and differential probes have exited 0, as did address/undefined sanitizer runs. The 139-test Python reference suite, 200-case native validation parity, 200-case projection/history parity, 200-case native receipt parity, and 200-case coverage/matching/lifecycle parity exited 0. Record new uncommitted paths, commands, and results here if interrupted.
