"""Execute the documented examples against independent financial semantics.

The JSON expectations are hand-calculated product examples, not snapshots of
the implementation. Native parity is opt-in so the fast documentation check
does not silently build a compiler toolchain or claim an unavailable binary.
"""

from __future__ import annotations

import copy
from dataclasses import asdict, is_dataclass
import json
import os
from pathlib import Path
import subprocess
import unittest

from scryer_reference.check_receipt import check_receipt
from scryer_reference.coverage import evaluate_bank_coverage
from scryer_reference.history import heads_as_known
from scryer_reference.lifecycle import project_aid_lifecycle
from scryer_reference.matching import suggest_refund_deposits
from scryer_reference.model import ModelError, load_case_json
from scryer_reference.money import MoneyError, parse_us_decimal
from scryer_reference.projection import compare_school_surplus, project_school_surplus
from scryer_reference.receipt import make_school_surplus_receipt


ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ROOT / "docs" / "foundation" / "financial-examples.json"
NATIVE = os.environ.get("SCRYER_FINANCIAL_NATIVE_BIN")


def examples():
    return json.loads(EXAMPLES.read_text(encoding="utf-8"))


def materialize(example):
    specification = example["case"]
    fixture = (ROOT / specification["fixture"]).resolve()
    if ROOT not in fixture.parents:
        raise ValueError("FIXTURE_OUTSIDE_REPOSITORY")
    raw = json.loads(fixture.read_text(encoding="utf-8"))
    raw["caseId"] = example["id"]
    if "keepEventIds" in specification:
        retained = specification["keepEventIds"]
        raw["events"] = [event for event in raw["events"] if event["eventId"] in retained]
        if {event["eventId"] for event in raw["events"]} != set(retained):
            raise ValueError("UNKNOWN_EXAMPLE_EVENT")
    for field, addition in (("accountRefs", "appendAccountRefs"),
                            ("artifacts", "appendArtifacts"),
                            ("proposals", "appendProposals"),
                            ("aidItems", "appendAidItems"),
                            ("events", "appendEvents")):
        raw[field].extend(copy.deepcopy(specification.get(addition, [])))
    return raw


def semantic_json(value):
    if is_dataclass(value):
        value = asdict(value)
    if isinstance(value, dict):
        result = {}
        for name, member in value.items():
            first, *rest = name.split("_")
            key = first + "".join(part.capitalize() for part in rest)
            result[key] = str(member) if name.endswith("_minor") and member is not None else semantic_json(member)
        return result
    if isinstance(value, (tuple, list)):
        return [semantic_json(member) for member in value]
    return value


def evaluate(raw, check):
    case = load_case_json(json.dumps(raw, separators=(",", ":")))
    query = check["query"]
    heads = tuple(query.get("heads", []))
    operation = check["operation"]
    if operation == "project":
        result = project_school_surplus(case, heads, query["termId"])
    elif operation == "compare":
        result = compare_school_surplus(case, tuple(query["beforeHeads"]), tuple(query["afterHeads"]), query["termId"])
    elif operation == "coverage":
        result = evaluate_bank_coverage(case, heads, query["accountRefId"], query["startDate"], query["endDateExclusive"])
    elif operation == "matching":
        result = suggest_refund_deposits(case, heads, query["refundFactId"], query["bankAccountRefId"])
    elif operation == "lifecycle":
        result = project_aid_lifecycle(case, heads, query["termId"], query["aidItemId"])
    elif operation == "historical":
        result = heads_as_known(case, query["cutoffUtc"])
    else:
        raise ValueError("UNKNOWN_EXAMPLE_OPERATION")
    return semantic_json(result)


class FinancialExamplesTests(unittest.TestCase):
    def assert_subset(self, expected, actual, path="result"):
        if isinstance(expected, dict):
            self.assertIsInstance(actual, dict, path)
            for key, value in expected.items():
                self.assertIn(key, actual, path)
                self.assert_subset(value, actual[key], f"{path}.{key}")
        else:
            self.assertEqual(expected, actual, path)

    def test_required_legacy_questions_have_explicit_scope_and_executable_examples(self):
        document = examples()
        self.assertEqual(document["schemaVersion"], 1)
        rows = document["examples"]
        self.assertEqual(len({row["id"] for row in rows}), len(rows))
        self.assertTrue({"normal_purchase", "refund", "two_account_transfer", "missing_income", "partial_month"}
                        <= {row["legacyQuestion"] for row in rows})
        for row in rows:
            with self.subTest(example=row["id"]):
                self.assertIs(row["budgetInference"]["supported"], False)
                self.assertTrue(row["budgetInference"]["reason"].strip())
                self.assertTrue(row["checks"])
                self.assertTrue(row["handCalculation"].strip())
                self.assertTrue(row["safeConclusion"].strip())

    def test_hand_calculated_results(self):
        for example in examples()["examples"]:
            raw = materialize(example)
            for index, check in enumerate(example["checks"]):
                with self.subTest(example=example["id"], check=index, operation=check["operation"]):
                    self.assert_subset(check["expected"], evaluate(raw, check))

    def test_case_order_does_not_change_documented_results(self):
        for example in examples()["examples"]:
            raw = materialize(example)
            shuffled = copy.deepcopy(raw)
            for field in ("artifacts", "proposals", "events", "accountRefs"):
                shuffled[field].reverse()
            for check in example["checks"]:
                with self.subTest(example=example["id"], operation=check["operation"]):
                    self.assertEqual(evaluate(raw, check), evaluate(shuffled, check))

    def test_surplus_receipts_independently_verify_and_reject_changed_amount(self):
        for example in examples()["examples"]:
            raw = materialize(example)
            case = load_case_json(json.dumps(raw))
            for check in example["checks"]:
                if check["operation"] != "project":
                    continue
                query = check["query"]
                with self.subTest(example=example["id"]):
                    if project_school_surplus(case, tuple(query["heads"]), query["termId"]).amount_minor is None:
                        with self.assertRaises(ModelError) as raised:
                            make_school_surplus_receipt(case, tuple(query["heads"]), query["termId"])
                        self.assertEqual(raised.exception.code, "UNSUPPORTED_RECEIPT_STATUS")
                        continue
                    receipt = make_school_surplus_receipt(case, tuple(query["heads"]), query["termId"])
                    self.assertTrue(check_receipt(case, receipt).valid)
                    changed = copy.deepcopy(receipt)
                    changed["amountMinor"] = "1" if receipt["amountMinor"] is None else str(int(receipt["amountMinor"]) + 1)
                    self.assertFalse(check_receipt(case, changed).valid)

    def test_bank_purchase_cannot_be_promoted_to_a_school_charge(self):
        example = next(row for row in examples()["examples"] if row["id"] == "bank-purchase")
        raw = materialize(example)
        bank = copy.deepcopy(next(event for event in raw["events"] if event["eventId"] == "event-bank-credit"))
        bank["fact"]["role"] = "school_charge"
        bank["fact"]["termId"] = "2026-fall"
        raw["events"] = [event if event["eventId"] != bank["eventId"] else bank for event in raw["events"]]
        with self.assertRaises(ModelError) as raised:
            load_case_json(json.dumps(raw))
        self.assertEqual(raised.exception.code, "ACCOUNT_KIND_MISMATCH")

    def test_source_decimals_are_exact_and_invalid_precision_is_rejected(self):
        for row in examples()["moneyExamples"]:
            with self.subTest(example=row["id"]):
                if "expectedMinor" in row:
                    self.assertEqual(str(parse_us_decimal(row["sourceDecimal"])), row["expectedMinor"])
                else:
                    with self.assertRaises(MoneyError) as raised:
                        parse_us_decimal(row["sourceDecimal"])
                    self.assertEqual(raised.exception.code, row["expectedError"])

    @unittest.skipUnless(NATIVE, "Set SCRYER_FINANCIAL_NATIVE_BIN to execute native example parity")
    def test_native_matches_the_same_hand_calculated_expectations(self):
        binary = Path(NATIVE).resolve()
        self.assertTrue(binary.is_file(), "Requested native binary must exist")
        for example in examples()["examples"]:
            raw = materialize(example)
            for check in example["checks"]:
                if check["operation"] == "historical":
                    continue
                request = {"schemaVersion": "1", "operation": check["operation"], "case": raw, **check["query"]}
                with self.subTest(example=example["id"], operation=check["operation"]):
                    process = subprocess.run([str(binary)], input=json.dumps(request), text=True,
                                             capture_output=True, timeout=15, check=False)
                    self.assertEqual(process.returncode, 0, process.stderr)
                    response = json.loads(process.stdout)
                    self.assertEqual(response["operation"], check["operation"])
                    self.assert_subset(check["expected"], response["result"])


if __name__ == "__main__":
    unittest.main()
