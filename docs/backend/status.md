# Current local status

Outcome: `BACKEND_PARTIAL_LOCAL`.

Baseline: `453c2087399894ec2c89717e4d6f32b8d86dfafa`. Branch/worktree: `codex/backend-local` / sibling linked worktree. Original tree was clean and is untouched. The pre-push hook was tested directly and denied the call.

Active task: M2-7b gross/net aid evidence. M2-1 through M2-7a have observed red-green tests; the current reference suite has 124 passing tests, 200 seeded synthetic receipts independently checked, and a 24-operation fixed synthetic reference parity corpus across eight case fixtures. The local Python reference now has explicit USD currency, proposal/version/value linkage, account-bound facts, aid-item lifecycle findings, exact school-surplus projections, receipt verification, reviewed bank coverage/retraction, recipient-aware conservative matching, and causal UTC-cutoff history mapping. The RC-01 through RC-48 evidence map names the remaining gaps. M1's domain subset is sufficient for reference work; auth/sync/crypto gates remain open. M2 as a whole remains incomplete: gross/net aid, reversal/version semantics, and browser import scenarios remain open.

Observed baseline checks: frontend lint exit 0; legacy Python unittest exit 1 because `cryptography` is unavailable. Docker socket access is denied in the current sandbox. `emcc`, `cmake`, `pytest`, and `ruff` are absent from PATH. These limits block some later gates but do not block standard-library reference work.

Next executable action: follow Task 2 in `plans/2026-10-04-reference-gap-closure.md`: write a hand-calculated gross/fee/net case and a missing-fee negative test, then extend only the required role/fields and lifecycle computation. The current verification command is `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/reference -q` (124 tests, exit 0 after M2-7a changes). Record new uncommitted paths, commands, and results here if interrupted.
