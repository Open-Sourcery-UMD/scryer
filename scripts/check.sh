#!/bin/sh
# Local equivalents of the CI jobs. A missing tool or failed command is a failure.
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"
python_bin=${SCRYER_PYTHON:-"$project_root/.venv/bin/python"}
export PYTHONDONTWRITEBYTECODE=1
export NEXT_TELEMETRY_DISABLED=1

case ${1:-fast} in
  fast)
    "$python_bin" -m ruff check scryer_reference sync main.py scripts
    "$python_bin" -m mypy --cache-dir .backend-artifacts/mypy-cache --no-incremental
    "$python_bin" -m unittest discover -s tests/reference -p 'test_*.py' -q
    "$python_bin" -m unittest discover -s tests/foundation -p 'test_*.py' -q
    "$python_bin" -m unittest discover -s tests/local_stack -p 'test_*.py' -q
    ;;
  engine)
    make -C engine test-money test-json test-case test-projection test-receipt test-coverage test-matching test-lifecycle cli
    "$python_bin" -m unittest discover -s tests/engine -p 'test_*.py' -q
    SCRYER_FINANCIAL_NATIVE_BIN="$project_root/engine/build/scryer-native" \
      "$python_bin" -m unittest discover -s tests/foundation -p test_financial_examples.py -q
    "$python_bin" tests/engine/differential_generated.py --cases 10000
    sh scripts/verify-native-coverage.sh
    ;;
  client)
    npm --prefix client run typecheck
    npm --prefix client test
    npm --prefix client run test:browser
    ;;
  frontend)
    npm --prefix frontend run lint
    npm --prefix frontend run test:demo
    npm --prefix frontend run typecheck
    node --test --test-concurrency=1 tests/frontend/browser_*.mjs
    ;;
  sync)
    if [ -z "${SCRYER_TEST_PG_SOCKET:-}" ]; then
      exec "$python_bin" scripts/verify-sync-stack.py
    fi
    "$python_bin" -m unittest discover -s tests/sync -p 'test_*.py' -q
    make -C engine cli
    npm --prefix client run build:browser
    node --experimental-strip-types --test --test-concurrency=1 tests/sync/test_client_integration.mjs
    if [ "${SCRYER_LOCAL_OIDC:-0}" = 1 ]; then
      node --experimental-strip-types --test tests/sync/test_oidc_local.mjs
    else
      printf '%s\n' 'OIDC gate not run: start the synthetic Keycloak harness and set SCRYER_LOCAL_OIDC=1.' >&2
      exit 2
    fi
    ;;
  containers)
    "$python_bin" scripts/verify-local-stack.py
    ;;
  security)
    "$python_bin" -m unittest discover -s tests/security -p 'test_*.py' -q
    "$python_bin" scripts/scan_secrets.py
    "$python_bin" -m pip_audit --disable-pip --no-deps -r requirements-dev.txt
    npm --prefix client audit --audit-level=moderate
    npm --prefix frontend audit --audit-level=moderate
    ;;
  all)
    for group in fast engine client frontend sync containers security; do
      sh scripts/check.sh "$group"
    done
    ;;
  *)
    printf '%s\n' 'Usage: sh scripts/check.sh {fast|engine|client|frontend|sync|containers|security|all}' >&2
    exit 2
    ;;
esac
