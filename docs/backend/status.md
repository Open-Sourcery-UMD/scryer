# Current local status

Outcome: `BACKEND_PARTIAL_LOCAL`.

Baseline: `453c2087399894ec2c89717e4d6f32b8d86dfafa`. Branch/worktree: `codex/backend-local` / sibling linked worktree. Original tree was clean and is untouched. The pre-push hook was tested directly and denied the call.

Active task: M2-5a explicit institution and account identity. M2-1 through M2-4 have observed red-green tests; the current reference suite has 46 passing tests, and 200 seeded synthetic receipts were independently checked. An author self-review found and fixed two receipt defects at `61727d1`. M1's domain subset is sufficient for reference work; auth/sync/crypto gates remain open (ruling in the ignored execution ledger). M2 as a whole remains incomplete: account/institution identity, matching, coverage, lifecycle, and the full release corpus are not implemented.

Observed baseline checks: frontend lint exit 0; legacy Python unittest exit 1 because `cryptography` is unavailable. Docker socket access is denied in the current sandbox. `emcc`, `cmake`, `pytest`, and `ruff` are absent from PATH. These limits block some later gates but do not block standard-library reference work.

Next executable action: read `plans/2026-10-04-account-matching-coverage.md`, write failing M2-5a account-isolation tests and update only synthetic fixtures, then extend the strict case parser/schema. The current verification command is `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/reference -p 'test_*.py' -v` (46 tests, exit 0 at `61727d1`). Record new uncommitted paths, commands, and results here if interrupted.
