import copy
import json
from pathlib import Path
import unittest

from scryer_reference.lifecycle import project_aid_lifecycle
from scryer_reference.model import ModelError, load_case_json
from scryer_reference.projection import project_school_surplus

_FIXTURE = Path(__file__).parent / "fixtures" / "gross-net-case.json"


def raw_case():
    return json.loads(_FIXTURE.read_text())


def parsed(raw):
    return load_case_json(json.dumps(raw, separators=(",", ":")))


def lifecycle(raw, head):
    return project_aid_lifecycle(parsed(raw), (head,), "2026-fall", "loan-a")


class GrossNetTests(unittest.TestCase):
    def test_hand_calculated_gross_fee_net_are_separate_and_exact(self):
        raw = raw_case()
        result = lifecycle(raw, "event-fee")
        self.assertEqual(result.current_offer_minor, 100000)
        self.assertEqual(result.gross_disbursed_minor, 100000)
        self.assertEqual(result.withheld_fee_minor, 1000)
        self.assertEqual(result.posted_minor, 99000)
        self.assertEqual(result.unexplained_difference_minor, 0)
        self.assertNotIn("GROSS_NET_GAP_UNEXPLAINED", result.finding_codes)
        self.assertEqual(
            project_school_surplus(parsed(raw), ("event-fee",), "2026-fall").amount_minor,
            99000,
        )

    def test_before_fee_evidence_gap_is_unresolved_not_assumed_fee(self):
        result = lifecycle(raw_case(), "event-posted")
        self.assertIsNone(result.withheld_fee_minor)
        self.assertEqual(result.unexplained_difference_minor, 1000)
        self.assertIn("GROSS_NET_GAP_UNEXPLAINED", result.finding_codes)
        self.assertIn("FEE_EVIDENCE_MISSING", result.finding_codes)

    def test_offer_alone_does_not_imply_a_gross_disbursement(self):
        result = lifecycle(raw_case(), "event-offer")
        self.assertEqual(result.current_offer_minor, 100000)
        self.assertIsNone(result.gross_disbursed_minor)
        self.assertIsNone(result.unexplained_difference_minor)
        self.assertEqual(result.posted_minor, 0)

    def test_withheld_fee_requires_disbursement_artifact_not_manual_or_school_charge(self):
        for variant in ("manual", "wrong_artifact", "school_account"):
            with self.subTest(variant=variant):
                raw = raw_case()
                fee = raw["events"][-1]["fact"]
                if variant == "manual":
                    fee["source"] = {"kind": "manual", "entryId": "manual-fee"}
                elif variant == "wrong_artifact":
                    fee["source"] = {"kind": "artifact", "artifactId": "offer-a", "location": "fee"}
                else:
                    fee["accountRefId"] = "school-a"
                with self.assertRaises(ModelError) as raised:
                    parsed(raw)
                self.assertEqual(raised.exception.code, "INVALID_AID_DISBURSEMENT_SOURCE")

    def test_two_distinct_fees_are_added_and_leave_exact_negative_difference(self):
        raw = raw_case()
        second = copy.deepcopy(raw["events"][-1])
        second["eventId"] = "event-fee-b"
        second["parents"] = ["event-fee"]
        second["recordedAt"] = "2026-09-03T12:00:00Z"
        second["fact"]["factId"] = "fee-b"
        second["fact"]["amountMinor"] = "500"
        second["fact"]["source"]["location"] = "loan:fee-b"
        second["fact"]["reviewId"] = "review-fee-b"
        raw["events"].append(second)
        result = lifecycle(raw, "event-fee-b")
        self.assertEqual(result.withheld_fee_minor, 1500)
        self.assertEqual(result.unexplained_difference_minor, -500)
        self.assertIn("GROSS_NET_GAP_UNEXPLAINED", result.finding_codes)
        self.assertEqual(project_school_surplus(parsed(raw), ("event-fee-b",), "2026-fall").amount_minor, 99000)

    def test_disbursement_source_cannot_be_observed_after_review(self):
        raw = raw_case()
        raw["artifacts"][1]["observedAt"] = "2026-09-04T10:00:00Z"
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "INVALID_AID_DISBURSEMENT_CHRONOLOGY")

    def test_fee_correction_requires_source_backed_disbursement_evidence(self):
        raw = raw_case()
        raw["events"].append({
            "eventId": "event-fee-correction", "parents": ["event-fee"],
            "recordedAt": "2026-09-04T10:00:00Z", "kind": "correct_fact",
            "correction": {
                "factId": "fee-a", "replacementAmountMinor": "1500", "cancelled": False,
                "source": {"kind": "manual", "entryId": "manual-fee-correction"},
                "reviewId": "review-fee-correction",
            },
        })
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "INVALID_AID_DISBURSEMENT_SOURCE")

    def test_reviewed_source_correction_changes_fee_without_duplicate_effect(self):
        raw = raw_case()
        raw["events"].append({
            "eventId": "event-fee-correction", "parents": ["event-fee"],
            "recordedAt": "2026-09-04T10:00:00Z", "kind": "correct_fact",
            "correction": {
                "factId": "fee-a", "replacementAmountMinor": "1500", "cancelled": False,
                "source": {"kind": "artifact", "artifactId": "disbursement-a", "location": "loan:fee-revised"},
                "reviewId": "review-fee-correction",
            },
        })
        case = parsed(raw)
        before = project_aid_lifecycle(case, ("event-fee",), "2026-fall", "loan-a")
        after = project_aid_lifecycle(case, ("event-fee-correction",), "2026-fall", "loan-a")
        self.assertEqual(before.withheld_fee_minor, 1000)
        self.assertEqual(before.unexplained_difference_minor, 0)
        self.assertEqual(after.withheld_fee_minor, 1500)
        self.assertEqual(after.unexplained_difference_minor, -500)
        self.assertEqual(project_school_surplus(case, ("event-fee-correction",), "2026-fall").amount_minor, 99000)

    def test_gross_and_fee_cannot_be_unlinked_from_aid_item(self):
        for index in (1, 3):
            with self.subTest(index=index):
                raw = raw_case()
                raw["events"][index]["fact"]["aidItemId"] = None
                with self.assertRaises(ModelError) as raised:
                    parsed(raw)
                self.assertEqual(raised.exception.code, "INVALID_AID_DISBURSEMENT_SOURCE")


if __name__ == "__main__":
    unittest.main()
