"""Measure end-to-end native CLI projection on fixed synthetic workloads.

The result includes process launch, JSON parsing, evaluation, and stdout capture.
Run each workload in a separate process so child peak RSS is workload-specific.
"""

import argparse
import copy
import json
import platform
from pathlib import Path
import resource
import statistics
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[2]
BIN = ROOT / "engine" / "build" / "scryer-native"


def make_request(workload):
    case = json.loads((ROOT / "tests" / "reference" / "fixtures" / "golden-case.json").read_text())
    head = "event-extra-charge"
    expected = "90000"
    if workload == "2007_events":
        base = next(event for event in case["events"] if event["eventId"] == "event-base-charge")
        parent = "event-bank-credit"
        for index in range(2000):
            event = copy.deepcopy(base)
            event["eventId"] = f"bench-charge-{index:04d}"
            event["parents"] = [parent]
            event["recordedAt"] = "2026-09-06T10:00:00Z"
            event["fact"]["factId"] = f"bench-fact-{index:04d}"
            event["fact"]["amountMinor"] = "1"
            event["fact"]["reviewId"] = f"bench-review-{index:04d}"
            event["fact"]["proposalId"] = None
            event["fact"]["source"] = {"kind": "manual", "entryId": f"bench-entry-{index:04d}"}
            case["events"].append(event)
            parent = event["eventId"]
        head = parent
        expected = "88000"
    return {"schemaVersion": "1", "operation": "project", "case": case,
            "heads": [head], "termId": "2026-fall"}, expected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("workload", choices=("golden", "2007_events"))
    parser.add_argument("--runs", type=int, default=100)
    args = parser.parse_args()
    if args.runs < 2 or args.runs > 1000:
        parser.error("runs must be between 2 and 1000")
    request, expected = make_request(args.workload)
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "request.json"
        path.write_text(json.dumps(request, separators=(",", ":")))
        samples = []
        for _ in range(args.runs):
            start = time.perf_counter_ns()
            run = subprocess.run([str(BIN), "--input", str(path)], capture_output=True)
            samples.append((time.perf_counter_ns() - start) / 1_000_000)
            if run.returncode != 0 or json.loads(run.stdout)["result"]["amountMinor"] != expected:
                raise RuntimeError("benchmark correctness check failed")
        ordered = sorted(samples)
        system = platform.system()
        print(json.dumps({
            "workload": args.workload, "runs": args.runs, "inputBytes": path.stat().st_size,
            "expectedAmountMinor": expected, "platform": system,
            "medianMs": round(statistics.median(samples), 3),
            "p95Ms": round(ordered[int(0.95 * (args.runs - 1))], 3),
            "maxChildRss": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,
            "rssUnit": "bytes" if system == "Darwin" else "KiB",
        }, sort_keys=True))


if __name__ == "__main__":
    main()
