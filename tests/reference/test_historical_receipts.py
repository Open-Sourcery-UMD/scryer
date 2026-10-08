import copy
import hashlib
import json
from pathlib import Path
import unittest

from scryer_reference.check_receipt import check_receipt
from scryer_reference.history_receipts import reproduce_school_surplus_receipt, reanalyze_school_surplus_receipt
from scryer_reference.model import ModelError, load_case_json
from scryer_reference.projection import compare_school_surplus, project_school_surplus
from scryer_reference.receipt import make_school_surplus_receipt

_FIXTURE = Path(__file__).parent / "fixtures" / "reversal-case.json"


def case():
    return load_case_json(_FIXTURE.read_text())


def redigest(receipt):
    core = {key: value for key, value in receipt.items() if key != "digest"}
    receipt["digest"] = hashlib.sha256(
        json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    ).hexdigest()


class HistoricalReceiptTests(unittest.TestCase):
    def test_corrected_source_and_cancellation_preserve_old_receipt_and_exact_delta(self):
        data = case()
        before_heads = ("event-extra-charge",)
        after_heads = ("event-charge-cancel",)
        old = make_school_surplus_receipt(data, before_heads, "2026-fall")
        self.assertEqual(old["amountMinor"], "90000")
        self.assertTrue(check_receipt(data, old).valid)
        self.assertEqual(reproduce_school_surplus_receipt(data, old), old)

        corrected = project_school_surplus(data, ("event-grant-correction-v2",), "2026-fall")
        self.assertEqual(corrected.amount_minor, 70000)
        comparison = compare_school_surplus(data, before_heads, after_heads, "2026-fall")
        self.assertEqual(comparison.before.amount_minor, 90000)
        self.assertEqual(comparison.after.amount_minor, 100000)
        self.assertEqual(comparison.delta_minor, 10000)
        self.assertEqual(
            {item.fact_id: item.delta_minor for item in comparison.contributions},
            {"grant": -20000, "extra-charge": 30000},
        )
        after = make_school_surplus_receipt(data, after_heads, "2026-fall")
        self.assertTrue(check_receipt(data, after).valid)
        grant = next(step for step in after["facts"] if step["factId"] == "grant")
        charge = next(step for step in after["facts"] if step["factId"] == "extra-charge")
        self.assertEqual(grant["sourceRef"]["artifactId"], "aid-a-corrected")
        self.assertEqual(grant["originalSourceRef"]["artifactId"], "aid-a")
        self.assertEqual(charge["currentAmountMinor"], "0")
        self.assertEqual(charge["sourceRef"]["artifactId"], "bill-a-corrected")

    def test_reanalysis_is_new_version_and_keeps_prior_digest(self):
        data = case()
        old = make_school_surplus_receipt(data, ("event-extra-charge",), "2026-fall")
        old_copy = copy.deepcopy(old)
        result = reanalyze_school_surplus_receipt(data, old, ("event-charge-cancel",))
        self.assertEqual(old, old_copy)
        self.assertEqual(result.prior_digest, old["digest"])
        self.assertEqual(result.receipt["engineVersion"], "reference-0.2.0")
        self.assertEqual(result.receipt["ruleVersion"], "school-surplus-1")
        self.assertEqual(result.receipt["amountMinor"], "100000")
        self.assertNotEqual(result.receipt["digest"], old["digest"])
        self.assertTrue(check_receipt(data, result.receipt).valid)
        self.assertEqual(reproduce_school_surplus_receipt(data, old), old)

    def test_unknown_or_tampered_historical_version_is_not_silently_reanalyzed(self):
        data = case()
        old = make_school_surplus_receipt(data, ("event-extra-charge",), "2026-fall")
        old["engineVersion"] = "reference-99.0.0"
        redigest(old)
        with self.assertRaises(ModelError) as raised:
            reproduce_school_surplus_receipt(data, old)
        self.assertEqual(raised.exception.code, "UNSUPPORTED_ENGINE_VERSION")
        with self.assertRaises(ModelError) as raised:
            reanalyze_school_surplus_receipt(data, old, ("event-charge-cancel",))
        self.assertEqual(raised.exception.code, "UNSUPPORTED_ENGINE_VERSION")

    def test_tampered_historical_arithmetic_and_unknown_rule_fail_reproduction(self):
        data = case()
        old = make_school_surplus_receipt(data, ("event-extra-charge",), "2026-fall")
        old["amountMinor"] = "90001"
        redigest(old)
        with self.assertRaises(ModelError) as raised:
            reproduce_school_surplus_receipt(data, old)
        self.assertEqual(raised.exception.code, "INVALID_HISTORICAL_RECEIPT")
        old["ruleVersion"] = "school-surplus-99"
        redigest(old)
        with self.assertRaises(ModelError) as raised:
            reproduce_school_surplus_receipt(data, old)
        self.assertEqual(raised.exception.code, "UNSUPPORTED_RULE")


if __name__ == "__main__":
    unittest.main()
