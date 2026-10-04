import json
from pathlib import Path
import unittest

from scryer_reference.check_receipt import check_receipt
from scryer_reference.coverage import evaluate_bank_coverage
from scryer_reference.history import heads_as_known
from scryer_reference.history_receipts import reproduce_school_surplus_receipt, reanalyze_school_surplus_receipt
from scryer_reference.lifecycle import project_aid_lifecycle
from scryer_reference.matching import suggest_refund_deposits
from scryer_reference.model import load_case_json
from scryer_reference.projection import compare_school_surplus, project_school_surplus
from scryer_reference.receipt import make_school_surplus_receipt

_MANIFEST = Path(__file__).parent / "corpus" / "manifest.json"


def semantic_result(case, operation):
    kind = operation["operation"]
    if kind == "project":
        result = project_school_surplus(case, tuple(operation["heads"]), operation["termId"])
        return {
            "status": result.status,
            "currency": result.currency,
            "amountMinor": str(result.amount_minor) if result.amount_minor is not None else None,
            "factIds": list(result.fact_ids),
        }
    if kind == "compare":
        result = compare_school_surplus(
            case, tuple(operation["beforeHeads"]), tuple(operation["afterHeads"]), operation["termId"]
        )
        return {
            "status": result.status,
            "deltaMinor": str(result.delta_minor) if result.delta_minor is not None else None,
            "contributions": {item.fact_id: str(item.delta_minor) for item in result.contributions},
        }
    if kind == "receipt":
        receipt = make_school_surplus_receipt(case, tuple(operation["heads"]), operation["termId"])
        assert check_receipt(case, receipt).valid
        return {"amountMinor": receipt["amountMinor"], "digest": receipt["digest"]}
    if kind == "historical_reanalysis":
        old = make_school_surplus_receipt(case, tuple(operation["oldHeads"]), operation["termId"])
        reproduced = reproduce_school_surplus_receipt(case, old)
        later = reanalyze_school_surplus_receipt(case, old, tuple(operation["newHeads"]))
        assert check_receipt(case, later.receipt).valid
        return {
            "oldReproduced": reproduced == old,
            "priorDigest": later.prior_digest,
            "newDigest": later.receipt["digest"],
            "newEngineVersion": later.receipt["engineVersion"],
            "newAmountMinor": later.receipt["amountMinor"],
        }
    if kind == "coverage":
        result = evaluate_bank_coverage(
            case, tuple(operation["heads"]), operation["accountRefId"],
            operation["startDate"], operation["endDateExclusive"],
        )
        return {"status": result.status, "missingIntervals": [list(item) for item in result.missing_intervals]}
    if kind == "matching":
        result = suggest_refund_deposits(
            case, tuple(operation["heads"]), operation["refundFactId"], operation["bankAccountRefId"]
        )
        return {
            "status": result.status,
            "candidateFactIds": list(result.candidate_fact_ids),
            "remainingMinor": str(result.remaining_minor) if result.remaining_minor is not None else None,
            "confirmedAllocations": [
                {"bankFactId": item.bank_fact_id, "allocatedMinor": str(item.allocated_minor)}
                for item in result.confirmed_allocations
            ],
        }
    if kind == "history":
        result = heads_as_known(case, operation["cutoffUtc"])
        return {"status": result.status, "heads": list(result.heads)}
    if kind == "lifecycle":
        result = project_aid_lifecycle(
            case, tuple(operation["heads"]), operation["termId"], operation["aidItemId"]
        )
        return {
            "status": result.status,
            "postedMinor": str(result.posted_minor) if result.posted_minor is not None else None,
            "currentOfferMinor": str(result.current_offer_minor) if result.current_offer_minor is not None else None,
            "grossDisbursedMinor": str(result.gross_disbursed_minor) if result.gross_disbursed_minor is not None else None,
            "withheldFeeMinor": str(result.withheld_fee_minor) if result.withheld_fee_minor is not None else None,
            "unexplainedDifferenceMinor": str(result.unexplained_difference_minor) if result.unexplained_difference_minor is not None else None,
            "findingCodes": list(result.finding_codes),
        }
    raise AssertionError(f"Unrecognized corpus operation: {kind}")


class CorpusTests(unittest.TestCase):
    def test_all_fixed_synthetic_parity_cases_match_literal_expectations(self):
        manifest = json.loads(_MANIFEST.read_text())
        self.assertEqual(manifest["schemaVersion"], "1")
        cases = {}
        fixture_dir = (_MANIFEST.parent.parent / "fixtures").resolve()
        for name, relative in manifest["cases"].items():
            path = (_MANIFEST.parent / relative).resolve()
            self.assertEqual(path.parent, fixture_dir)
            cases[name] = load_case_json(path.read_text())
        operations = manifest["operations"]
        self.assertGreaterEqual(len(operations), 20)
        self.assertEqual(len({item["id"] for item in operations}), len(operations))
        for operation in operations:
            with self.subTest(case=operation["case"], operation=operation["id"]):
                self.assertEqual(semantic_result(cases[operation["case"]], operation), operation["expected"])


if __name__ == "__main__":
    unittest.main()
