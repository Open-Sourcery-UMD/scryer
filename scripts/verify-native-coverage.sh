#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
run_dir="$project_root/.backend-artifacts/coverage/run-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$run_dir"
binary="$project_root/engine/build/scryer-native-coverage"
profile_pattern="$run_dir/%p.profraw"

llvm_tool() {
    tool_name=$1
    shift
    case "$tool_name" in
      llvm-profdata) configured_tool=${LLVM_PROFDATA:-} ;;
      llvm-cov) configured_tool=${LLVM_COV:-} ;;
      *) return 2 ;;
    esac
    if [ -n "$configured_tool" ]; then
        "$configured_tool" "$@"
    elif command -v "$tool_name" >/dev/null 2>&1; then
        "$tool_name" "$@"
    elif command -v xcrun >/dev/null 2>&1; then
        xcrun "$tool_name" "$@"
    else
        printf 'Missing coverage tool: %s\n' "$tool_name" >&2
        return 2
    fi
}

make -C "$project_root/engine" cli-coverage
(
    cd "$project_root"
    SCRYER_NATIVE_BIN="$binary" LLVM_PROFILE_FILE="$profile_pattern" \
        PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests.engine.test_cli -q
)
LLVM_PROFILE_FILE="$profile_pattern" make -C "$project_root/engine" unit-coverage

set -- "$run_dir"/*.profraw
if [ ! -f "$1" ]; then
    printf '%s\n' 'No native profiles were produced' >&2
    exit 1
fi
profile_count=$#
llvm_tool llvm-profdata merge -sparse "$@" -o "$run_dir/combined.profdata"
set -- "$project_root/engine/src/api.cpp" \
    "$project_root/engine/src/receipt.cpp" \
    "$project_root/engine/src/projection.cpp" \
    "$project_root/engine/src/coverage.cpp" \
    "$project_root/engine/src/matching.cpp" \
    "$project_root/engine/src/lifecycle.cpp" \
    "$project_root/engine/src/case.cpp" \
    "$project_root/engine/src/json_boundary.cpp" \
    "$project_root/engine/src/money.cpp"
llvm_tool llvm-cov report --instr-profile="$run_dir/combined.profdata" \
    --show-branch-summary "$binary" "$@" > "$run_dir/report.txt"
llvm_tool llvm-cov export --summary-only --instr-profile="$run_dir/combined.profdata" \
    "$binary" "$@" > "$run_dir/summary.json"
cat "$run_dir/report.txt"
printf 'profile_count=%s\n' "$profile_count"
python3 - "$run_dir/summary.json" <<'PY'
import json
from pathlib import Path
import sys

totals = json.loads(Path(sys.argv[1]).read_text())["data"][0]["totals"]
line = totals["lines"]["percent"]
branch = totals["branches"]["percent"]
print(f"native_source_line={line:.2f}% target=90.00%")
print(f"native_source_branch={branch:.2f}% target=85.00%")
if line < 90 or branch < 85:
    print("NATIVE_COVERAGE_GATE_FAILED", file=sys.stderr)
    raise SystemExit(1)
print("NATIVE_COVERAGE_GATE_PASSED")
PY
