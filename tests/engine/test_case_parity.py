import copy
import json
from pathlib import Path
import subprocess
import unittest

from scryer_reference.model import ModelError, load_case_json
from scryer_reference.scenarios import generate_raw_case

ROOT = Path(__file__).resolve().parents[2]
PROBE = ROOT / "engine" / "build" / "case_probe"


class NativeCaseParityTests(unittest.TestCase):
    def test_two_hundred_generated_cases_and_invalid_variants(self):
        raws = [generate_raw_case(seed) for seed in range(200)]
        base = generate_raw_case(42)
        variants = []
        for edit in (
            lambda value: value["events"][0]["fact"].update(amountMinor=100),
            lambda value: value["terms"][0].update(schoolAccountRefId="missing"),
            lambda value: value["events"][0]["fact"]["source"].update(artifactId="missing"),
            lambda value: value["events"].append(copy.deepcopy(value["events"][0])),
            lambda value: value.update(currency="EUR"),
            lambda value: value["events"][0]["fact"].update(effectiveDate="2026-02-30"),
            lambda value: value["accountRefs"][0].update(holderKind="student"),
            lambda value: value["accountRefs"][0].update(holderKind=42),
        ):
            variant = copy.deepcopy(base)
            edit(variant)
            variants.append(variant)
        raws.extend(variants)
        golden = json.loads((ROOT / "tests" / "reference" / "fixtures" / "golden-case.json").read_text())
        bad_recipient = copy.deepcopy(golden)
        bad_recipient["events"][5]["fact"]["recipientKind"] = 42
        raws.append(bad_recipient)
        for edit in (
            lambda value: value["events"][0]["fact"].update(proposalId="proposal-unreviewed"),
            lambda value: value["events"][0]["fact"]["source"].update(location="with space"),
            lambda value: value["events"][0]["fact"]["source"].pop("kind"),
            lambda value: value["events"][0]["fact"].update(role="unknown_role"),
            lambda value: value["events"][0].update(recordedAt="2026-13-01T00:00:00Z"),
            lambda value: value["events"][0]["fact"].update(aidItemId="missing"),
            lambda value: value["accountRefs"][1].update(institutionId=42),
            lambda value: value["accountRefs"][1].update(kind=42),
            lambda value: value["events"][6]["fact"].update(termId=42),
            lambda value: value["artifacts"][0].update(sha256=42),
            lambda value: value["proposals"][0].update(rawValue=42),
        ):
            variant = copy.deepcopy(golden)
            edit(variant)
            raws.append(variant)
        matching = json.loads((ROOT / "tests" / "reference" / "fixtures" / "matching-case.json").read_text())
        for edit in (
            lambda value: value["events"][7]["coverage"].update(endDateExclusive="2026-10-09"),
            lambda value: value["events"][8]["decision"].update(allocatedMinor="0"),
            lambda value: value["events"][8]["decision"].update(refundFactId="missing"),
            lambda value: value["events"][5]["fact"].update(recipientKind="parent"),
            lambda value: value["events"][7]["coverage"].update(basis=42),
            lambda value: value["events"][8]["decision"].update(action=42),
        ):
            variant = copy.deepcopy(matching)
            edit(variant)
            raws.append(variant)
        expected = []
        for raw in raws:
            try:
                case = load_case_json(json.dumps(raw, separators=(",", ":")))
                expected.append("OK\t" + case.case_id + "\t" + ",".join(event.event_id for event in case.events))
            except ModelError as error:
                expected.append("ERR\t" + error.code)
        payload = "".join(json.dumps(raw, separators=(",", ":")) + "\n" for raw in raws)
        process = subprocess.run([str(PROBE)], input=payload, capture_output=True, text=True, check=True)
        self.assertEqual(process.stderr, "")
        actual = process.stdout.splitlines()
        self.assertEqual(len(actual), len(expected))
        mismatches = [(index, got, want) for index, (got, want) in enumerate(zip(actual, expected)) if got != want]
        self.assertEqual(mismatches, [])


if __name__ == "__main__":
    unittest.main()
