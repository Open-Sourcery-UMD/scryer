"""Deterministic synthetic Python-reference/native projection comparison."""

import argparse
import copy
import json
from pathlib import Path
import platform
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from scryer_reference.model import load_case_json
from scryer_reference.projection import project_school_surplus
from scryer_reference.scenarios import generate_raw_case


DEFAULT_BIN = ROOT / "engine" / "build" / "scryer-native"
FAMILIES = (
    "linear",
    "reordered",
    "correction",
    "cancellation",
    "approval_join",
    "contradictory_corrections",
    "manual_source",
)


def make_case(seed: int) -> tuple[dict, str, str]:
    raw = generate_raw_case(seed)
    family = FAMILIES[seed % len(FAMILIES)]
    head = "event-charge"
    artifact_id = raw["artifacts"][0]["artifactId"]

    def correction(event_id: str, amount: int | None, cancelled: bool) -> dict:
        return {
            "eventId": event_id,
            "parents": ["event-charge"],
            "recordedAt": "2026-09-04T12:00:00Z",
            "kind": "correct_fact",
            "correction": {
                "factId": "charge",
                "replacementAmountMinor": None if cancelled else str(amount),
                "cancelled": cancelled,
                "source": {"kind": "artifact", "artifactId": artifact_id,
                           "location": f"row:{event_id}"},
                "reviewId": f"review-{event_id}",
            },
        }

    if family == "reordered":
        raw["events"].reverse()
    elif family == "correction":
        raw["events"].append(correction("event-correction", 1 + seed % 600_000, False))
        head = "event-correction"
    elif family == "cancellation":
        raw["events"].append(correction("event-cancellation", None, True))
        head = "event-cancellation"
    elif family == "approval_join":
        for suffix, amount in (("a", 1 + seed % 100_000),
                               ("b", 1 + (seed * 3) % 100_000)):
            event = copy.deepcopy(raw["events"][0])
            event["eventId"] = f"event-branch-{suffix}"
            event["parents"] = ["event-charge"]
            event["recordedAt"] = "2026-09-04T12:00:00Z"
            event["fact"].update(
                factId=f"branch-{suffix}", amountMinor=str(amount),
                reviewId=f"review-branch-{suffix}",
                source={"kind": "artifact", "artifactId": artifact_id,
                        "location": f"row:branch-{suffix}"},
            )
            raw["events"].append(event)
        raw["events"].append({
            "eventId": "event-join", "parents": ["event-branch-a", "event-branch-b"],
            "recordedAt": "2026-09-05T12:00:00Z", "kind": "resolve_branches",
            "resolution": {"reviewId": "review-join"},
        })
        head = "event-join"
    elif family == "contradictory_corrections":
        raw["events"].extend([
            correction("event-correction-a", 1 + seed % 600_000, False),
            correction("event-correction-b", 2 + seed % 600_000, False),
            {"eventId": "event-join", "parents": [
                "event-correction-a", "event-correction-b"],
             "recordedAt": "2026-09-05T12:00:00Z", "kind": "resolve_branches",
             "resolution": {"reviewId": "review-join"}},
        ])
        head = "event-join"
    elif family == "manual_source":
        raw["events"][0]["fact"]["source"] = {
            "kind": "manual", "entryId": "entry-credit-a"}
    return raw, head, family


def expected_projection(raw: dict, head: str) -> dict:
    case = load_case_json(json.dumps(raw, separators=(",", ":")))
    projection = project_school_surplus(case, (head,), "2026-fall")
    return {
        "caseId": projection.case_id,
        "heads": list(projection.heads),
        "termId": projection.term_id,
        "currency": projection.currency,
        "status": projection.status,
        "amountMinor": None if projection.amount_minor is None else str(projection.amount_minor),
        "factIds": list(projection.fact_ids),
        "limitationCodes": list(projection.limitation_codes),
    }


def actual_projection(binary: Path, raw: dict, head: str) -> dict:
    request = {"schemaVersion": "1", "operation": "project", "case": raw,
               "heads": [head], "termId": "2026-fall"}
    process = subprocess.run(
        [str(binary)], input=json.dumps(request, separators=(",", ":")),
        text=True, capture_output=True, timeout=10, check=False,
    )
    if process.returncode != 0:
        raise RuntimeError(f"native exit {process.returncode}: {process.stderr[:300]}")
    response = json.loads(process.stdout)
    if (response.get("schemaVersion"), response.get("engineVersion"),
            response.get("operation")) != ("1", "native-0.1.0", "project"):
        raise RuntimeError("unexpected native response envelope")
    return response["result"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=int, default=200)
    parser.add_argument("--seed-start", type=int, default=0)
    parser.add_argument("--native-bin", type=Path, default=DEFAULT_BIN)
    args = parser.parse_args()
    if args.cases < 1 or args.cases > 100_000 or args.seed_start < 0:
        parser.error("cases must be 1..100000 and seed-start must be nonnegative")
    binary = args.native_bin.resolve()
    if not binary.is_file():
        parser.error(f"native CLI not found: {binary}")
    started = time.perf_counter()
    counts = {family: 0 for family in FAMILIES}
    for seed in range(args.seed_start, args.seed_start + args.cases):
        raw, head, family = make_case(seed)
        try:
            expected = expected_projection(raw, head)
            actual = actual_projection(binary, raw, head)
        except Exception as error:
            print(f"FAIL seed={seed} family={family} error={error}", file=sys.stderr)
            return 1
        if actual != expected:
            print(f"FAIL seed={seed} family={family}", file=sys.stderr)
            print(f"expected={json.dumps(expected, sort_keys=True)}", file=sys.stderr)
            print(f"actual={json.dumps(actual, sort_keys=True)}", file=sys.stderr)
            return 1
        counts[family] += 1
        if (seed - args.seed_start + 1) % 1000 == 0:
            print(f"checked={seed - args.seed_start + 1}", flush=True)
    elapsed = time.perf_counter() - started
    print(json.dumps({"cases": args.cases, "seedStart": args.seed_start,
                      "families": counts, "seconds": round(elapsed, 3),
                      "platform": platform.platform(), "python": platform.python_version(),
                      "skips": 0}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
