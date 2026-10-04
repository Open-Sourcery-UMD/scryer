# Current local status

Outcome: `BACKEND_PARTIAL_LOCAL`.

Baseline: `453c2087399894ec2c89717e4d6f32b8d86dfafa`. Branch/worktree: `codex/backend-local` / sibling linked worktree. Original tree was clean and is untouched. The pre-push hook was tested directly and denied the call.

Active task: design and test the next M2 matching/coverage slice. M2-1 through M2-4 have observed red-green tests; the current reference suite has 44 passing tests, and 200 seeded synthetic receipts were independently checked. M1's domain subset is sufficient for reference work; auth/sync/crypto gates remain open (ruling in the ignored execution ledger). M2 as a whole remains incomplete: matching, coverage, lifecycle, and the full release corpus are not implemented.

Observed baseline checks: frontend lint exit 0; legacy Python unittest exit 1 because `cryptography` is unavailable. Docker socket access is denied in the current sandbox. `emcc`, `cmake`, `pytest`, and `ruff` are absent from PATH. These limits block some later gates but do not block standard-library reference work.

Next executable action: freeze matching and coverage event/query contracts, write a focused M2 continuation plan, then a failing ambiguity/insufficient-coverage test. The current verification command is `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/reference -p 'test_*.py' -v` (44 tests, exit 0). Record new uncommitted paths, commands, and results here if interrupted.
