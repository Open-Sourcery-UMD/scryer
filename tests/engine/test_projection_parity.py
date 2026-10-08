import json
from pathlib import Path
import subprocess
import unittest

from scryer_reference.history import heads_as_known
from scryer_reference.model import load_case_json
from scryer_reference.projection import compare_school_surplus, project_school_surplus
from scryer_reference.scenarios import generate_raw_case

ROOT = Path(__file__).resolve().parents[2]
PROBE = ROOT / "engine" / "build" / "projection_probe"
MANIFEST = ROOT / "tests" / "reference" / "corpus" / "manifest.json"


def projection_value(result):
    return {
        "status": result.status,
        "currency": result.currency,
        "amountMinor": None if result.amount_minor is None else str(result.amount_minor),
        "factIds": list(result.fact_ids),
        "limitationCodes": list(result.limitation_codes),
        "heads": list(result.heads),
    }


def expected_value(raw, operation):
    case = load_case_json(json.dumps(raw, separators=(",", ":")))
    kind = operation["operation"]
    if kind == "project":
        return projection_value(project_school_surplus(case, tuple(operation["heads"]), operation["termId"]))
    if kind == "compare":
        result = compare_school_surplus(
            case, tuple(operation["beforeHeads"]), tuple(operation["afterHeads"]), operation["termId"]
        )
        return {
            "status": result.status,
            "deltaMinor": None if result.delta_minor is None else str(result.delta_minor),
            "before": projection_value(result.before),
            "after": projection_value(result.after),
            "contributions": [
                {
                    "factId": item.fact_id,
                    "beforeMinor": str(item.before_minor),
                    "afterMinor": str(item.after_minor),
                    "deltaMinor": str(item.delta_minor),
                }
                for item in result.contributions
            ],
            "limitationCodes": list(result.limitation_codes),
        }
    if kind == "history":
        result = heads_as_known(case, operation["cutoffUtc"])
        return {"status": result.status, "heads": list(result.heads), "reasonCodes": list(result.reason_codes)}
    raise AssertionError(kind)


def manifest_value(value, operation):
    kind = operation["operation"]
    if kind == "project":
        return {key: value[key] for key in ("status", "currency", "amountMinor", "factIds")}
    if kind == "compare":
        return {
            "status": value["status"],
            "deltaMinor": value["deltaMinor"],
            "contributions": {item["factId"]: item["deltaMinor"] for item in value["contributions"]},
        }
    if kind == "history":
        return {key: value[key] for key in ("status", "heads")}
    raise AssertionError(kind)


class NativeProjectionParityTests(unittest.TestCase):
    def test_fixed_manifest_and_two_hundred_generated_cases(self):
        manifest = json.loads(MANIFEST.read_text())
        requests = []
        for operation in manifest["operations"]:
            if operation["operation"] in {"project", "compare", "history"}:
                fixture = (MANIFEST.parent / manifest["cases"][operation["case"]]).resolve()
                requests.append((json.loads(fixture.read_text()), operation))
        self.assertGreaterEqual(len(requests), 10)
        fixed_count = len(requests)
        for seed in range(200):
            raw = generate_raw_case(seed)
            requests.extend(
                (raw, operation)
                for operation in (
                    {"operation": "project", "heads": [], "termId": "2026-fall"},
                    {"operation": "project", "heads": ["event-credit-b"], "termId": "2026-fall"},
                    {"operation": "project", "heads": ["event-charge"], "termId": "2026-fall"},
                    {
                        "operation": "compare", "beforeHeads": ["event-credit-b"],
                        "afterHeads": ["event-charge"], "termId": "2026-fall",
                    },
                    {"operation": "history", "cutoffUtc": "2026-09-02T12:00:00Z"},
                )
            )
        payload = "".join(json.dumps({**operation, "case": raw}, separators=(",", ":")) + "\n" for raw, operation in requests)
        process = subprocess.run([str(PROBE)], input=payload, capture_output=True, text=True, check=True)
        self.assertEqual(process.stderr, "")
        lines = process.stdout.splitlines()
        self.assertEqual(len(lines), len(requests))
        for index, ((raw, operation), line) in enumerate(zip(requests, lines)):
            with self.subTest(index=index, operation=operation.get("id", operation["operation"])):
                actual = json.loads(line)
                self.assertEqual(actual, expected_value(raw, operation))
                if index < fixed_count:
                    self.assertEqual(manifest_value(actual, operation), operation["expected"])


if __name__ == "__main__":
    unittest.main()
