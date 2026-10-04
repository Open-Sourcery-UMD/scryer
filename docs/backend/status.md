# Current local status

Outcome: `BACKEND_PARTIAL_LOCAL`.

Baseline: `453c2087399894ec2c89717e4d6f32b8d86dfafa`. Branch/worktree: `codex/backend-local` / sibling linked worktree. Original tree was clean and is untouched. The pre-push hook was tested directly and denied the call.

Active task: M2-6d historical mapping and release corpus. M2-1 through M2-6c have observed red-green tests; the current reference suite has 107 passing tests, and 200 seeded synthetic account-bound receipts were independently checked before aid-item binding. The local Python reference now has explicit USD currency, source proposal/version/value linkage, account-bound facts, aid-item lifecycle findings, exact school-surplus projections, receipt verification, reviewed bank coverage/retraction, and conservative refund/deposit suggestions with reviewed allocations and cross-refund/bank capacity checks. An author self-review found and fixed two earlier receipt defects at `61727d1`. M1's domain subset is sufficient for reference work; auth/sync/crypto gates remain open (ruling in the ignored execution ledger). M2 as a whole remains incomplete: historical edge cases and the full release corpus are not implemented.

Observed baseline checks: frontend lint exit 0; legacy Python unittest exit 1 because `cryptography` is unavailable. Docker socket access is denied in the current sandbox. `emcc`, `cmake`, `pytest`, and `ruff` are absent from PATH. These limits block some later gates but do not block standard-library reference work.

Next executable action: follow Task 4 in `plans/2026-10-04-reference-completion.md`: write failing as-known cutoff/branch tests and freeze a hand-checked synthetic parity corpus. The current verification command is `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/reference -q` (107 tests, exit 0 before the M2-6c commit). Record new uncommitted paths, commands, and results here if interrupted.
