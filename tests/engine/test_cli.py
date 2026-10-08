import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from scryer_reference.model import load_case_json
from scryer_reference.projection import project_school_surplus
from scryer_reference.check_receipt import check_receipt
from scryer_reference.receipt import make_school_surplus_receipt
from scryer_reference.scenarios import generate_raw_case

ROOT = Path(__file__).resolve().parents[2]
BIN = Path(os.environ.get("SCRYER_NATIVE_BIN", ROOT / "engine" / "build" / "scryer-native"))
FIXTURES = ROOT / "tests" / "reference" / "fixtures"
MANIFEST = ROOT / "tests" / "reference" / "corpus" / "manifest.json"


def fixture(name):
    return json.loads((FIXTURES / f"{name}-case.json").read_text())


def request(operation, **fields):
    return {"schemaVersion": "1", "operation": operation, **fields}


def call(value=None, *args, raw=None):
    document = raw if raw is not None else json.dumps(value, separators=(",", ":")) if value is not None else ""
    return subprocess.run([str(BIN), *args], input=document, capture_output=True, text=True)


def result(process, operation):
    assert process.returncode == 0, (process.returncode, process.stderr)
    body = json.loads(process.stdout)
    assert body["schemaVersion"] == "1"
    assert body["engineVersion"] == "native-0.1.0"
    assert body["operation"] == operation
    return body["result"]


class NativeCliTests(unittest.TestCase):
    def test_versioned_request_limits_and_discrepancy_queue(self):
        matching = fixture("matching")
        valid = request("matching", case=matching, heads=["event-coverage"],
                        refundFactId="issued-refund", bankAccountRefId="bank-a",
                        candidateLimit=1, windowDays=0)
        self.assertEqual(result(call(valid), "matching")["status"], "NO_CANDIDATE_IN_APPROVED_FACTS")

        def rejected(query, code="INVALID_REQUEST"):
            process = call(query)
            self.assertEqual(process.returncode, 3)
            self.assertEqual(process.stdout, "")
            self.assertEqual(json.loads(process.stderr)["error"]["code"], code)

        for key, values in (("candidateLimit", (0, 10001, 1.5, True, "1")),
                            ("windowDays", (-1, 91, 1.5, True, "0"))):
            for value in values:
                with self.subTest(key=key, value=value):
                    invalid = copy.deepcopy(valid)
                    invalid[key] = value
                    rejected(invalid)
        golden = fixture("golden")
        rejected(request("project", case=golden, heads="event-extra-charge",
                         termId="2026-fall"))
        rejected(request("project", case=golden, heads=[17], termId="2026-fall"))
        rejected(request("project", case=golden, heads=["event-extra-charge"],
                         termId="2026-fall", unexpected=True))
        rejected(request("timeline", case=golden, termId="2026-fall",
                         cutoffsUtc=["2026-09-02T10:02:00Z"] * 257))
        rejected(request("batch", case=golden,
                         requests=[{"operation": "validate"}] * 101))
        rejected(request("discrepancy-queue", case=matching, heads=["event-coverage"],
                         termId="2026-fall", aidItemIds=["loan-a"] * 101,
                         matchTargets=[]))
        rejected(request("discrepancy-queue", case=matching, heads=["event-coverage"],
                         termId="2026-fall", aidItemIds=[],
                         matchTargets=[{"refundFactId": "issued-refund",
                                        "bankAccountRefId": "bank-a"}] * 101))
        rejected(request("discrepancy-queue", case=matching, heads=["event-coverage"],
                         termId="2026-fall", aidItemIds=[],
                         matchTargets=[{"refundFactId": "issued-refund"}]))
        rejected(request("trace", case=golden, heads=["event-extra-charge"],
                         factId="fact-missing"), "MISSING_FACT_IN_SNAPSHOT")
        rejected(request("unknown-operation", case=golden), "UNSUPPORTED_OPERATION")
        rejected({"schemaVersion": "1"})

        ambiguous_queue = result(call(request("discrepancy-queue", case=fixture("ambiguous"),
            heads=["event-grant-correction", "event-grant-correction-b"],
            termId="2026-fall", aidItemIds=[], matchTargets=[])), "discrepancy-queue")
        self.assertEqual([item["category"] for item in ambiguous_queue], ["school_surplus"])
        self.assertEqual(ambiguous_queue[0]["status"], "CONTRADICTORY_EVIDENCE")
        aid_queue = result(call(request("discrepancy-queue", case=fixture("gross-net"),
            heads=["event-fee"], termId="2026-fall", aidItemIds=["loan-a"],
            matchTargets=[])), "discrepancy-queue")
        self.assertEqual([item["category"] for item in aid_queue], ["aid_lifecycle"])
        self.assertIn("ACCEPTANCE_NOT_OBSERVED", aid_queue[0]["findingCodes"])
        reviewed_queue = result(call(request("discrepancy-queue", case=matching,
            heads=["event-confirm"], termId="2026-fall", aidItemIds=[],
            matchTargets=[{"refundFactId": "issued-refund", "bankAccountRefId": "bank-a"}])),
            "discrepancy-queue")
        self.assertEqual(reviewed_queue, [])

    def test_reviewed_branch_join_parity_and_unresolved_correction(self):
        golden = fixture("golden")
        bank = next(item for item in golden["events"] if item["eventId"] == "event-bank-credit")
        for suffix, role, amount in (("a", "school_charge", "10000"),
                                     ("b", "school_credit", "20000")):
            branch = copy.deepcopy(bank)
            branch["eventId"] = f"event-branch-{suffix}"
            branch["parents"] = ["event-bank-credit"]
            branch["recordedAt"] = "2026-10-03T12:00:00Z"
            branch["fact"].update(factId=f"school-branch-{suffix}", role=role,
                                  amountMinor=amount, termId="2026-fall",
                                  accountRefId="school-a", reviewId=f"review-branch-{suffix}", proposalId=None,
                                  source={"kind": "manual", "entryId": f"entry-branch-{suffix}"})
            golden["events"].append(branch)
        golden["events"].append({"eventId": "event-join", "parents": [
            "event-branch-a", "event-branch-b"],
            "recordedAt": "2026-10-04T12:00:00Z", "kind": "resolve_branches",
            "resolution": {"reviewId": "review-join"}})
        reference = project_school_surplus(load_case_json(json.dumps(golden)),
                                           ("event-join",), "2026-fall")
        native = result(call(request("project", case=golden, heads=["event-join"],
                                     termId="2026-fall")), "project")
        self.assertEqual(native["amountMinor"], str(reference.amount_minor))
        self.assertEqual(native["amountMinor"], "100000")
        self.assertEqual(native["status"], reference.status)
        current = result(call(request("current", case=golden,
                                      termId="2026-fall")), "current")
        self.assertEqual(current["projection"]["amountMinor"], native["amountMinor"])
        ambiguous = fixture("ambiguous")
        ambiguous["events"].append({"eventId": "event-join", "parents": [
            "event-bank-credit", "event-grant-correction-b"],
            "recordedAt": "2026-10-04T12:00:00Z", "kind": "resolve_branches",
            "resolution": {"reviewId": "review-join"}})
        native_conflict = result(call(request("project", case=ambiguous,
                                             heads=["event-join"], termId="2026-fall")), "project")
        self.assertEqual(native_conflict["status"], "CONTRADICTORY_EVIDENCE")
        self.assertIsNone(native_conflict["amountMinor"])

    def test_all_named_operations_and_synthetic_demo(self):
        self.assertTrue(BIN.exists())
        golden = fixture("golden")
        matching = fixture("matching")
        reversal = fixture("reversal")
        before = ["event-base-charge"]
        after = ["event-extra-charge"]
        capabilities = result(call(request("capabilities")), "capabilities")
        for operation in ("validate", "current", "historical", "timeline", "compare", "coverage",
                          "matching", "lifecycle", "receipt", "verify-receipt", "discrepancy-queue",
                          "trace", "batch", "demo"):
            self.assertIn(operation, capabilities["operations"])
        schema = result(call(request("schema")), "schema")
        self.assertEqual(schema["caseSchemaVersion"], "1")
        self.assertEqual(schema["maxDocumentBytes"], 20 * 1024 * 1024)
        validated = result(call(request("validate", case=golden)), "validate")
        self.assertEqual(validated["caseId"], "case-golden")
        self.assertEqual(validated["eventIds"], sorted(validated["eventIds"]))
        self.assertIn("event-bank-credit", validated["heads"])
        first = result(call(request("project", case=golden, heads=before, termId="2026-fall")), "project")
        self.assertEqual(first["amountMinor"], "150000")
        current = result(call(request("current", case=golden, termId="2026-fall")), "current")
        self.assertEqual(current["projection"]["amountMinor"], "90000")
        ambiguous = result(call(request("current", case=fixture("ambiguous"), termId="2026-fall")), "current")
        self.assertEqual(ambiguous["status"], "AMBIGUOUS")
        self.assertIsNone(ambiguous["projection"])
        historical = result(call(request(
            "historical", case=golden, termId="2026-fall", cutoffUtc="2026-09-02T10:02:00Z"
        )), "historical")
        self.assertEqual(historical["projection"]["amountMinor"], "150000")
        timeline = result(call(request(
            "timeline", case=golden, termId="2026-fall",
            cutoffsUtc=["2026-09-02T10:02:00Z", "2026-09-04T10:00:00Z"]
        )), "timeline")
        self.assertEqual([item["projection"]["amountMinor"] for item in timeline], ["150000", "90000"])
        compared = result(call(request(
            "compare", case=golden, beforeHeads=before, afterHeads=after, termId="2026-fall"
        )), "compare")
        self.assertEqual(compared["deltaMinor"], "-60000")
        covered = result(call(request(
            "coverage", case=matching, heads=["event-coverage"], accountRefId="bank-a",
            startDate="2026-09-06", endDateExclusive="2026-10-07"
        )), "coverage")
        self.assertEqual(covered["status"], "SUPPORTED_BY_UPLOADED_RECORDS")
        match = result(call(request(
            "matching", case=matching, heads=["event-coverage"], refundFactId="issued-refund",
            bankAccountRefId="bank-a"
        )), "matching")
        self.assertEqual(match["status"], "SUGGESTED")
        lifecycle = result(call(request(
            "lifecycle", case=fixture("gross-net"), heads=["event-fee"],
            termId="2026-fall", aidItemId="loan-a"
        )), "lifecycle")
        self.assertEqual(lifecycle["unexplainedDifferenceMinor"], "0")
        receipt = result(call(request(
            "receipt", case=golden, heads=after, termId="2026-fall", producerVersion="reference-0.1.0"
        )), "receipt")
        self.assertEqual(receipt["digest"], "f866d458450015bcfbf1456b886888360c532b5c1bb0c91679017b298d7add86")
        native_receipt = result(call(request(
            "receipt", case=golden, heads=after, termId="2026-fall"
        )), "receipt")
        self.assertEqual(native_receipt["engineVersion"], "native-0.1.0")
        self.assertTrue(check_receipt(load_case_json(json.dumps(golden)), native_receipt).valid)
        self.assertTrue(result(call(request("verify-receipt", case=golden, archived=receipt)), "verify-receipt")["valid"])
        reproduced = result(call(request("reproduce-receipt", case=golden, archived=receipt)), "reproduce-receipt")
        self.assertEqual(reproduced, receipt)
        archived = make_school_surplus_receipt(
            load_case_json(json.dumps(reversal)), tuple(after), "2026-fall"
        )
        reanalysis = result(call(request(
            "reanalyze-receipt", case=reversal, archived=archived, newHeads=["event-charge-cancel"]
        )), "reanalyze-receipt")
        self.assertEqual(reanalysis["priorDigest"], archived["digest"])
        self.assertEqual(reanalysis["receipt"]["amountMinor"], "100000")
        queue = result(call(request(
            "discrepancy-queue", case=matching, heads=["event-coverage"], termId="2026-fall",
            aidItemIds=[], matchTargets=[{"refundFactId": "issued-refund", "bankAccountRefId": "bank-a"}]
        )), "discrepancy-queue")
        self.assertTrue(any(item["category"] == "matching" for item in queue))
        self.assertTrue(all(item["priority"] == "review" for item in queue))
        trace = result(call(request("trace", case=golden, heads=after, factId="grant")), "trace")
        self.assertEqual(trace["currentAmountMinor"], "270000")
        self.assertEqual(trace["contributionMinor"], "270000")
        self.assertEqual(trace["currentSourceRef"]["location"], "row:1-revised")
        batch = result(call(request("batch", case=matching, requests=[
            {"operation": "validate"},
            {"operation": "project", "heads": after, "termId": "2026-fall"},
            {"operation": "coverage", "heads": ["event-coverage"], "accountRefId": "bank-a",
             "startDate": "2026-09-06", "endDateExclusive": "2026-10-07"},
        ])), "batch")
        self.assertEqual([item["operation"] for item in batch], ["validate", "project", "coverage"])
        demo = result(call(None, "demo"), "demo")
        self.assertEqual(demo["before"]["amountMinor"], "150000")
        self.assertEqual(demo["after"]["amountMinor"], "90000")
        self.assertEqual(demo["comparison"]["deltaMinor"], "-60000")

    def test_cli_boundaries_atomic_output_and_repeatability(self):
        self.assertTrue(BIN.exists())
        self.assertEqual(call(None, "--help").returncode, 0)
        self.assertIn("native-0.1.0", call(None, "--version").stdout)
        self.assertEqual(call(None, "--unknown").returncode, 2)
        self.assertEqual(call(None, "--input").returncode, 2)
        golden = fixture("golden")
        valid = request("project", case=golden, heads=["event-extra-charge"], termId="2026-fall")
        first = call(valid)
        second = call(valid)
        self.assertEqual(first.returncode, 0)
        self.assertEqual(first.stdout, second.stdout)
        self.assertEqual(first.stderr, "")
        invalid = request("batch", case=golden, requests=[
            {"operation": "project", "heads": ["event-extra-charge"], "termId": "2026-fall"},
            {"operation": "project", "heads": ["event-extra-charge"], "termId": "missing"},
        ])
        failed = call(invalid)
        self.assertEqual(failed.returncode, 3)
        self.assertEqual(failed.stdout, "")
        self.assertEqual(json.loads(failed.stderr)["error"]["code"], "MISSING_TERM")
        duplicate = call(raw='{"schemaVersion":"1","schemaVersion":"1","operation":"schema"}')
        self.assertEqual(duplicate.returncode, 3)
        self.assertEqual(duplicate.stdout, "")
        self.assertEqual(json.loads(duplicate.stderr)["error"]["code"], "DUPLICATE_JSON_KEY")
        for query in (
            request("current", case=fixture("ambiguous"), termId="missing"),
            request("timeline", case=golden, termId="missing", cutoffsUtc=[]),
        ):
            rejected = call(query)
            self.assertEqual(rejected.returncode, 3)
            self.assertEqual(json.loads(rejected.stderr)["error"]["code"], "MISSING_TERM")
        too_large = call(raw=" " * (20 * 1024 * 1024 + 1))
        self.assertEqual(too_large.returncode, 6)
        self.assertEqual(too_large.stdout, "")
        receipt = make_school_surplus_receipt(load_case_json(json.dumps(golden)), ("event-extra-charge",), "2026-fall")
        bad_receipt = copy.deepcopy(receipt)
        bad_receipt["digest"] = "0" * 64
        verification = call(request("verify-receipt", case=golden, archived=bad_receipt))
        self.assertEqual(verification.returncode, 4)
        self.assertEqual(verification.stdout, "")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "request.json"
            output = Path(directory) / "result.json"
            missing_input = call(None, "--input", str(Path(directory) / "missing.json"))
            self.assertEqual(missing_input.returncode, 5)
            self.assertEqual(missing_input.stdout, "")
            source.write_text(json.dumps(valid))
            written = call(None, "--input", str(source), "--output", str(output))
            self.assertEqual(written.returncode, 0)
            self.assertEqual(written.stdout, "")
            self.assertEqual(json.loads(output.read_text())["result"]["amountMinor"], "90000")
            output.write_text("existing-good-result")
            source.write_text(json.dumps(invalid))
            failed_write = call(None, "--input", str(source), "--output", str(output))
            self.assertEqual(failed_write.returncode, 3)
            self.assertEqual(output.read_text(), "existing-good-result")
            source.write_text(json.dumps(valid))
            directory_output = call(None, "--input", str(source), "--output", directory)
            self.assertEqual(directory_output.returncode, 5)
            self.assertEqual(directory_output.stdout, "")

    def test_every_fixed_manifest_operation_and_two_hundred_seeded_cases(self):
        self.assertTrue(BIN.exists())
        manifest = json.loads(MANIFEST.read_text())
        self.assertEqual(len(manifest["operations"]), 33)
        for operation in manifest["operations"]:
            with self.subTest(operation=operation["id"]):
                raw = json.loads((MANIFEST.parent / manifest["cases"][operation["case"]]).read_text())
                kind = operation["operation"]
                if kind == "historical_reanalysis":
                    case = load_case_json(json.dumps(raw))
                    archived = make_school_surplus_receipt(case, tuple(operation["oldHeads"]), operation["termId"])
                    query = request("reanalyze-receipt", case=raw, archived=archived,
                                    newHeads=operation["newHeads"], producerVersion="reference-0.2.0")
                    value = result(call(query), "reanalyze-receipt")
                    actual = {
                        "oldReproduced": True, "priorDigest": value["priorDigest"],
                        "newDigest": value["receipt"]["digest"],
                        "newEngineVersion": value["receipt"]["engineVersion"],
                        "newAmountMinor": value["receipt"]["amountMinor"],
                    }
                else:
                    mapped = "historical" if kind == "history" else kind
                    fields = {key: value for key, value in operation.items()
                              if key not in {"id", "case", "operation", "expected"}}
                    if kind == "history":
                        fields["termId"] = "2026-fall"
                    if kind == "receipt":
                        fields["producerVersion"] = "reference-0.1.0"
                    query = request(mapped, case=raw, **fields)
                    value = result(call(query), mapped)
                    if kind == "project":
                        actual = {key: value[key] for key in ("status", "currency", "amountMinor", "factIds")}
                    elif kind == "compare":
                        actual = {"status": value["status"], "deltaMinor": value["deltaMinor"],
                                  "contributions": {item["factId"]: item["deltaMinor"]
                                                    for item in value["contributions"]}}
                    elif kind == "history":
                        actual = {"status": value["status"], "heads": value["heads"]}
                    elif kind == "receipt":
                        actual = {"amountMinor": value["amountMinor"], "digest": value["digest"]}
                    elif kind == "coverage":
                        actual = {"status": value["status"], "missingIntervals": value["missingIntervals"]}
                    elif kind == "matching":
                        actual = {"status": value["status"], "candidateFactIds": value["candidateFactIds"],
                                  "remainingMinor": value["remainingMinor"],
                                  "confirmedAllocations": [
                                      {key: item[key] for key in ("bankFactId", "allocatedMinor")}
                                      for item in value["confirmedAllocations"]]}
                    elif kind == "lifecycle":
                        actual = {key: value[key] for key in (
                            "status", "postedMinor", "currentOfferMinor", "grossDisbursedMinor",
                            "withheldFeeMinor", "unexplainedDifferenceMinor", "findingCodes")}
                    else:
                        raise AssertionError(kind)
                self.assertEqual(actual, operation["expected"])
        for seed in range(200):
            raw = generate_raw_case(seed)
            case = load_case_json(json.dumps(raw))
            query = request("project", case=raw, heads=["event-charge"], termId="2026-fall")
            value = result(call(query), "project")
            expected_minor = (int(raw["events"][0]["fact"]["amountMinor"]) +
                              int(raw["events"][1]["fact"]["amountMinor"]) -
                              int(raw["events"][2]["fact"]["amountMinor"]))
            self.assertEqual(value["amountMinor"], str(expected_minor))
            self.assertEqual(value["caseId"], case.case_id)


if __name__ == "__main__":
    unittest.main()
