import copy
import hashlib
import json
from pathlib import Path
import unittest

from scryer_reference.check_receipt import check_receipt, load_receipt_json
from scryer_reference.model import ModelError, load_case_json
from scryer_reference.receipt import make_school_surplus_receipt
from scryer_reference.scenarios import generate_case

_FIXTURE = Path(__file__).parent / "fixtures" / "golden-case.json"


def golden_case():
    return load_case_json(_FIXTURE.read_text())


def redigest(receipt):
    core = {key: value for key, value in receipt.items() if key != "digest"}
    payload = json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    receipt["digest"] = hashlib.sha256(payload).hexdigest()


class ReceiptTests(unittest.TestCase):
    def test_golden_receipt_has_exact_steps_and_independent_check_passes(self):
        case = golden_case()
        receipt = make_school_surplus_receipt(case, ("event-extra-charge",), "2026-fall")
        self.assertEqual(receipt["metric"], "school_surplus")
        self.assertEqual(receipt["amountMinor"], "90000")
        self.assertEqual(receipt["status"], "SUPPORTED_BY_UPLOADED_RECORDS")
        self.assertEqual(
            {step["factId"]: step["contributionMinor"] for step in receipt["facts"]},
            {"grant": "270000", "other-credit": "350000", "base-charge": "-500000", "extra-charge": "-30000"},
        )
        grant = next(step for step in receipt["facts"] if step["factId"] == "grant")
        self.assertEqual(grant["approvalReviewId"], "review-grant")
        self.assertEqual(grant["correctionReviewId"], "review-grant-correction")
        self.assertEqual(grant["effectiveDate"], "2026-08-20")
        self.assertEqual(grant["originalSourceRef"]["location"], "row:1")
        self.assertEqual(grant["sourceRef"]["location"], "row:1-revised")
        self.assertEqual(grant["sourceRef"]["observedAt"], "2026-09-01T10:00:00Z")
        self.assertIn("SOURCE_AUTHENTICITY_NOT_VERIFIED", receipt["limitations"])
        self.assertEqual(len(receipt["digest"]), 64)
        self.assertTrue(check_receipt(case, receipt).valid)

    def test_changed_arithmetic_with_recomputed_digest_fails(self):
        case = golden_case()
        receipt = make_school_surplus_receipt(case, ("event-extra-charge",), "2026-fall")
        altered = copy.deepcopy(receipt)
        next(step for step in altered["facts"] if step["factId"] == "grant")["contributionMinor"] = "280000"
        redigest(altered)
        result = check_receipt(case, altered)
        self.assertFalse(result.valid)
        self.assertEqual(result.code, "ARITHMETIC_MISMATCH")

    def test_changed_digest_fails(self):
        case = golden_case()
        receipt = make_school_surplus_receipt(case, ("event-extra-charge",), "2026-fall")
        receipt["digest"] = "0" * 64
        result = check_receipt(case, receipt)
        self.assertFalse(result.valid)
        self.assertEqual(result.code, "DIGEST_MISMATCH")

    def test_missing_participating_fact_fails_even_with_valid_digest(self):
        case = golden_case()
        receipt = make_school_surplus_receipt(case, ("event-extra-charge",), "2026-fall")
        receipt["facts"] = [step for step in receipt["facts"] if step["factId"] != "extra-charge"]
        redigest(receipt)
        result = check_receipt(case, receipt)
        self.assertFalse(result.valid)
        self.assertEqual(result.code, "MISSING_FACT")

    def test_missing_source_reference_fails_even_with_valid_digest(self):
        case = golden_case()
        receipt = make_school_surplus_receipt(case, ("event-extra-charge",), "2026-fall")
        receipt["facts"][0]["sourceRef"]["artifactId"] = "missing-artifact"
        redigest(receipt)
        result = check_receipt(case, receipt)
        self.assertFalse(result.valid)
        self.assertEqual(result.code, "MISSING_SOURCE")

    def test_changed_original_source_reference_fails_with_valid_digest(self):
        case = golden_case()
        receipt = make_school_surplus_receipt(case, ("event-extra-charge",), "2026-fall")
        next(step for step in receipt["facts"] if step["factId"] == "grant")["originalSourceRef"]["location"] = "row:99"
        redigest(receipt)
        result = check_receipt(case, receipt)
        self.assertFalse(result.valid)
        self.assertEqual(result.code, "MISSING_SOURCE")

    def test_deeply_nested_direct_receipt_is_typed_invalid(self):
        receipt = make_school_surplus_receipt(golden_case(), ("event-extra-charge",), "2026-fall")
        nested = None
        for _ in range(2000):
            nested = [nested]
        receipt["facts"] = nested
        result = check_receipt(golden_case(), receipt)
        self.assertFalse(result.valid)
        self.assertEqual(result.code, "INVALID_RECEIPT")

    def test_unsupported_receipt_version_fails(self):
        case = golden_case()
        receipt = make_school_surplus_receipt(case, ("event-extra-charge",), "2026-fall")
        receipt["schemaVersion"] = "2"
        redigest(receipt)
        result = check_receipt(case, receipt)
        self.assertFalse(result.valid)
        self.assertEqual(result.code, "UNSUPPORTED_VERSION")

    def test_duplicate_receipt_json_key_is_rejected_at_input_boundary(self):
        receipt = make_school_surplus_receipt(golden_case(), ("event-extra-charge",), "2026-fall")
        document = json.dumps(receipt)
        document = document[:-1] + ',"digest":"' + "0" * 64 + '"}'
        with self.assertRaises(ModelError) as raised:
            load_receipt_json(document)
        self.assertEqual(raised.exception.code, "DUPLICATE_JSON_KEY")

    def test_seeded_synthetic_generator_is_repeatable_and_varies_by_seed(self):
        first = generate_case(42)
        second = generate_case(42)
        third = generate_case(43)
        self.assertEqual(first, second)
        self.assertNotEqual(first, third)
        self.assertEqual(first.schema_version, "1")


if __name__ == "__main__":
    unittest.main()
