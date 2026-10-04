# Repository audit — 2026-10-04

## Baseline and isolation

- Intended repository: the local `scryer` checkout; baseline `453c2087399894ec2c89717e4d6f32b8d86dfafa` on `codex/final-five-issues`.
- Baseline tracked tree and index were clean. This work uses linked worktree `scryer-backend-local` on `codex/backend-local` at that baseline. The original checkout was left untouched.
- The desktop native worktree helper could not resolve this checkout because the task was opened from the parent directory; `git worktree add` created the linked local worktree. No remote access was used.
- No active Git hooks or configured filters/signing settings were found. Sample hooks exist. Git identity is configured; its values were not copied into project documents.
- A repository-local `pre-push` hook was installed after confirming the path was absent; direct invocation exits 1. Repository-local `push.default=nothing` was set after confirming no prior local value. Restore with `rm .git/hooks/pre-push` and `git config --local --unset push.default` **only after this local-only assignment ends**; inspect the current values first. These guardrails do not prevent other upload mechanisms.

## Code disposition

| Existing component | Observation | Decision |
|---|---|---|
| `main.py` | Only `/` and `/health`; no database or auth integration | Adapt into an actual readiness/liveness and versioned ciphertext API after contracts are frozen. |
| `CSVParser.py` | Pandas parser calls `float`, guesses columns and dates, drops ambiguous money to empty | Retire from the trusted financial path; replace with reviewed exact browser proposals. Preserve until consumers are checked. |
| `prisma/schema.prisma` | Stores user password hash and plaintext transaction fields including `Float amount` | Retire as a schema authority for the new design. No automatic conversion of old floats. Quarantine legacy values lacking exact source text. |
| `encryption.py` / `testEncryption.py` | Fernet helper with PBKDF2; test passes `None` as secret and is not a viable recovery design | Keep out of the new client crypto path. Remove only after consumer search and replacement. |
| `mockdataendpoint.py`, `GhostDataGenerator.py` | Synthetic budgeting data; not wired into the aid-tracing domain | Retain as legacy sample until a deliberate migration; do not treat as real format evidence. |
| `frontend/` | Next.js 16.1.6, React 19.2.3; existing visual components | Preserve. New TypeScript work is headless integration, not a UI rewrite. |
| `docker-compose.yml`, Dockerfiles, `setup.sh` | Default database/password/secret strings, broadly bound ports, frontend development image | Replace in a later local-stack task; do not use for sensitive data. |
| `README.md` | Describes older budgeting scope and Next.js 14 | Update as the actual backend setup becomes runnable. |

## Baseline checks and tooling

- `npm run lint` from the original frontend: exit 0.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -p 'test*.py' -v`: exit 1 before tests, because `cryptography` is absent from the current Python environment. The existing test would also need behavior correction before acceptance.
- `docker info --format '{{.ServerVersion}}'`: permission denied on the local Docker socket in the current sandbox. No container was started or changed.
- Python 3.13.13, Node 25.7.0, npm 11.10.1, Apple clang 21.0.0, Docker CLI 29.2.1/Compose v5.0.2, Codex CLI 0.152.1. `uv` is present. `cmake`, `emcc`, `pytest`, and `ruff` are not on PATH. Browser binaries, local PostgreSQL, and local OIDC provider have not yet been verified.
- Codex Security tool and skills are advertised, but execution mode/network/cost have not been verified; no scan was run. Context7 is available but no private repo information has been sent to it. The GitHub-connected cloud security integration is excluded.

Baseline failures are not evidence of new regressions or successful new functionality. The container/WebAssembly/full-stack gates remain `BLOCKED_TOOLING` until the actual tools and permissions are available and exercised.
