#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
run_dir=
socket_dir=
pg_bin=${SCRYER_PG_BIN:-}

if [ -z "${SCRYER_TEST_PG_SOCKET:-}" ]; then
  if [ -z "$pg_bin" ] || [ ! -x "$pg_bin/initdb" ] || [ ! -x "$pg_bin/pg_ctl" ]; then
    echo 'BLOCKED_TOOLING: set SCRYER_PG_BIN to a local PostgreSQL bin directory' >&2
    exit 2
  fi
  mkdir -p "$project_root/.backend-artifacts"
  run_dir=$(mktemp -d "$project_root/.backend-artifacts/pg-test.XXXXXX")
  socket_dir=$(mktemp -d /private/tmp/scryer-pg.XXXXXX)
  chmod 700 "$run_dir"
  chmod 700 "$socket_dir"
  if ! "$pg_bin/initdb" -D "$run_dir/data" --no-instructions \
      --auth-local=trust --auth-host=reject >"$run_dir/initdb.log" 2>&1; then
    cat "$run_dir/initdb.log" >&2
    exit 1
  fi
  if ! "$pg_bin/pg_ctl" -D "$run_dir/data" -l "$run_dir/server.log" \
      -o "-c listen_addresses='' -c unix_socket_directories=$socket_dir -c unix_socket_permissions=0700" \
      start >"$run_dir/start.log" 2>&1; then
    cat "$run_dir/start.log" "$run_dir/server.log" >&2
    exit 1
  fi
  stop_cluster() {
    "$pg_bin/pg_ctl" -D "$run_dir/data" stop -m fast >/dev/null
    rmdir "$socket_dir"
  }
  trap stop_cluster EXIT HUP INT TERM
  SCRYER_TEST_PG_SOCKET="$socket_dir"
  export SCRYER_TEST_PG_SOCKET
fi

if [ -n "${SCRYER_PG_LIB_DIR:-}" ]; then
  DYLD_LIBRARY_PATH="${SCRYER_PG_LIB_DIR}${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
  export DYLD_LIBRARY_PATH
fi

if [ ! -x "$project_root/.venv/bin/python" ]; then
  echo 'BLOCKED_TOOLING: create the project-local Python environment first' >&2
  exit 2
fi

PYTHONDONTWRITEBYTECODE=1
export PYTHONDONTWRITEBYTECODE
cd "$project_root"
"$project_root/.venv/bin/python" -m unittest discover -s tests/sync -p 'test_*.py' -v
