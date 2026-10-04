# Current local status

Outcome: `BACKEND_PARTIAL_LOCAL`.

Baseline: `453c2087399894ec2c89717e4d6f32b8d86dfafa`. Branch/worktree: `codex/backend-local` / sibling linked worktree. Original tree was clean and is untouched. The pre-push hook was tested directly and denied the call.

Active task: M2-6c aid lifecycle evidence and findings. M2-1 through M2-6b have observed red-green tests; the current reference suite has 93 passing tests, and 200 seeded synthetic account-bound receipts were independently checked after currency binding. The local Python reference now has explicit USD currency, source proposal/version/value linkage, account-bound facts, exact school-surplus projections, receipt verification, reviewed bank coverage/retraction, and conservative refund/deposit suggestions with reviewed allocations and cross-refund/bank capacity checks. An author self-review found and fixed two earlier receipt defects at `61727d1`. M1's domain subset is sufficient for reference work; auth/sync/crypto gates remain open (ruling in the ignored execution ledger). M2 as a whole remains incomplete: aid lifecycle, historical edge cases, and the full release corpus are not implemented.

Observed baseline checks: frontend lint exit 0; legacy Python unittest exit 1 because `cryptography` is unavailable. Docker socket access is denied in the current sandbox. `emcc`, `cmake`, `pytest`, and `ruff` are absent from PATH. These limits block some later gates but do not block standard-library reference work.

Next executable action: follow Task 3 in `plans/2026-10-04-reference-completion.md`: freeze aid-item roles and write failing out-of-order lifecycle tests before implementation. The current verification command is `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/reference -q` (93 tests, exit 0 before the M2-6b commit). Record new uncommitted paths, commands, and results here if interrupted.
