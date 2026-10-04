import copy
import hashlib
import json
from pathlib import Path
import subprocess
import unittest

from scryer_reference.check_receipt import check_receipt
from scryer_reference.model import load_case_json
from scryer_reference.receipt import make_school_surplus_receipt
from scryer_reference.scenarios import generate_raw_case

ROOT = Path(__file__).resolve().parents[2]
PROBE = ROOT / "engine" / "build" / "receipt_probe"
MANIFEST = ROOT / "tests" / "reference" / "corpus" / "manifest.json"


def parsed_case(raw):
    return load_case_json(json.dumps(raw, separators=(",", ":")))


def as_native_producer(receipt):
    result = copy.deepcopy(receipt)
    result["engineVersion"] = "native-0.1.0"
    core = {key: value for key, value in result.items() if key != "digest"}
    result["digest"] = hashlib.sha256(
        json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    ).hexdigest()
    return result


class NativeReceiptParityTests(unittest.TestCase):
    def test_fixed_receipts_seeded_cases_and_historical_reanalysis(self):
        manifest = json.loads(MANIFEST.read_text())
        requests = []
        expectations = []
        for operation in manifest["operations"]:
            if operation["operation"] != "receipt":
                continue
            raw = json.loads((MANIFEST.parent / manifest["cases"][operation["case"]]).read_text())
            expected = make_school_surplus_receipt(
                parsed_case(raw), tuple(operation["heads"]), operation["termId"]
            )
            self.assertEqual(expected["digest"], operation["expected"]["digest"])
            requests.append({
                "operation": "make", "case": raw, "heads": operation["heads"],
                "termId": operation["termId"], "engineVersion": "reference-0.1.0",
            })
            expectations.append((raw, expected))
        self.assertEqual(len(requests), 4)
        for seed in range(200):
            raw = generate_raw_case(seed)
            expected = make_school_surplus_receipt(parsed_case(raw), ("event-charge",), "2026-fall")
            requests.append({
                "operation": "make", "case": raw, "heads": ["event-charge"],
                "termId": "2026-fall", "engineVersion": "reference-0.1.0",
            })
            expectations.append((raw, expected))

        golden_raw = json.loads((ROOT / "tests/reference/fixtures/golden-case.json").read_text())
        proposal_raw = copy.deepcopy(golden_raw)
        proposal_raw["proposals"][0].update(
            artifactId="aid-a", sourceLocation="row:1", rawValue="3000.00", proposedAmountMinor="300000"
        )
        proposal_raw["events"][0]["fact"]["proposalId"] = "proposal-unreviewed"
        aid_raw = copy.deepcopy(golden_raw)
        aid_raw["aidItems"].append({
            "aidItemId": "aid-grant", "institutionId": "institution-a",
            "termId": "2026-fall", "recipientKind": "student",
        })
        aid_raw["events"][0]["fact"]["aidItemId"] = "aid-grant"
        for raw in (proposal_raw, aid_raw):
            expected = make_school_surplus_receipt(parsed_case(raw), ("event-extra-charge",), "2026-fall")
            requests.append({
                "operation": "make", "case": raw, "heads": ["event-extra-charge"],
                "termId": "2026-fall", "engineVersion": "reference-0.1.0",
            })
            expectations.append((raw, expected))

        reversal_raw = json.loads((ROOT / "tests/reference/fixtures/reversal-case.json").read_text())
        reversal_case = parsed_case(reversal_raw)
        archived = make_school_surplus_receipt(reversal_case, ("event-extra-charge",), "2026-fall")
        requests.append({"operation": "reproduce", "case": reversal_raw, "archived": archived})
        expectations.append((reversal_raw, archived))
        new_reference = make_school_surplus_receipt(
            reversal_case, ("event-charge-cancel",), "2026-fall"
        )
        new_native = as_native_producer(new_reference)
        requests.append({
            "operation": "reanalyze", "case": reversal_raw, "archived": archived,
            "heads": ["event-charge-cancel"],
        })
        expectations.append((reversal_raw, {"priorDigest": archived["digest"], "receipt": new_native}))

        payload = "".join(json.dumps(request, separators=(",", ":")) + "\n" for request in requests)
        process = subprocess.run([str(PROBE)], input=payload, capture_output=True, text=True, check=True)
        self.assertEqual(process.stderr, "")
        lines = process.stdout.splitlines()
        self.assertEqual(len(lines), len(requests))
        for index, ((raw, expected), line) in enumerate(zip(expectations, lines)):
            with self.subTest(index=index):
                actual = json.loads(line)
                self.assertEqual(actual, expected)
                receipt = actual["receipt"] if requests[index]["operation"] == "reanalyze" else actual
                self.assertTrue(check_receipt(parsed_case(raw), receipt).valid)


if __name__ == "__main__":
    unittest.main()
