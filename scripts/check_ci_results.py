#!/usr/bin/env python3
"""Fail the required aggregate check when any expected job is absent or unsuccessful."""

import json
import os
import sys

REQUIRED_JOBS = ("policy", "python", "engine-client", "frontend", "containers", "security")


def check_results(results: object) -> list[str]:
    if not isinstance(results, dict):
        return ["Invalid job-result map"]
    errors = []
    for name in REQUIRED_JOBS:
        value = results.get(name)
        if not isinstance(value, dict) or value.get("result") != "success":
            errors.append(f"Required job did not succeed: {name}")
    return errors


def main() -> int:
    try:
        results = json.loads(os.environ.get("NEEDS_JSON", "null"))
    except ValueError:
        results = None
    errors = check_results(results)
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("All required jobs succeeded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
