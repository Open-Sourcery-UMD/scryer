# Local PostgreSQL isolation tests

`scripts/verify-sync-db.sh` is a development gate for M7's SQL boundary. It needs a project-local Python environment with psycopg 3.3.5 and a locally installed PostgreSQL binary directory containing `initdb` and `pg_ctl`. The observed run used Python 3.14.3 and PostgreSQL 15.11; PostgreSQL 16 release-image compatibility is still untested. The script neither starts Docker nor contacts a registry.

From the repository root, using dependencies already approved and available in the local cache:

```sh
uv venv --python python3.14 .venv
uv pip install --offline --python .venv/bin/python 'psycopg==3.3.5' 'fastapi==0.141.1' 'anyio==4.14.2' 'httpx==0.28.1' 'pytest==9.1.1' 'uvicorn==0.52.4'
SCRYER_PG_BIN=/path/to/postgresql/bin SCRYER_PG_LIB_DIR=/path/to/postgresql/lib scripts/verify-sync-db.sh
```

`SCRYER_PG_LIB_DIR` is needed when the pure-Python psycopg package cannot find `libpq` on the loader path. If an isolated test cluster is already running, set `SCRYER_TEST_PG_SOCKET` to its Unix-socket directory instead of `SCRYER_PG_BIN`. The test identity defaults to the current OS user; `SCRYER_TEST_PG_ADMIN` can select a different local administrator. The test runner requires access to create and drop only its own randomly named databases.

When it starts a cluster, the script puts data and logs in ignored `.backend-artifacts/pg-test.*`, creates a short private socket directory under `/private/tmp` with mode `0700`, disables TCP listening, runs the sync tests, and stops the server. It preserves the data/log directory for debugging. Local socket trust is limited by the private socket directory; it is a development setting and must not be copied to public operations. A failure to initialize a cluster or import psycopg is `BLOCKED_TOOLING`, not a passing test.

The migration is applied by `sync/migrate.py`, which records SHA-256 checksums and rejects a changed applied file. Never edit `0001_sync.sql` after it has been applied to a persistent database; use a new numbered forward migration. The tests use disposable databases and never target a user's existing Scryer data. No production backup, restore, or identity-provider test is implied by this command.
