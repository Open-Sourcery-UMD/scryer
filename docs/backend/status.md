# Current local status

Outcome: `BACKEND_PARTIAL_LOCAL`.

Baseline: `453c2087399894ec2c89717e4d6f32b8d86dfafa`. Branch/worktree: `codex/backend-local` / sibling linked worktree. Original tree was clean and is untouched. The pre-push hook was tested directly and denied the call.

Active task: M2-2 immutable approved journal. M2-1 exact-money parsing and checked arithmetic has an observed red-green cycle and 11 passing local tests; the tested implementation is included in this status update's commit. M1's domain subset is sufficient for reference work; auth/sync/crypto gates remain open (ruling in the ignored execution ledger).

Observed baseline checks: frontend lint exit 0; legacy Python unittest exit 1 because `cryptography` is unavailable. Docker socket access is denied in the current sandbox. `emcc`, `cmake`, `pytest`, and `ruff` are absent from PATH. These limits block some later gates but do not block standard-library reference work.

Next executable action: write the failing M2-2 case parser/DAG tests, then implement the strict versioned journal. The M2-1 verification command was `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests/reference -p 'test_*.py' -v` (11 tests, exit 0). Record new uncommitted paths, commands, and results here if interrupted.
