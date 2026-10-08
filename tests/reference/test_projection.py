import copy
from dataclasses import replace
import json
from pathlib import Path
import unittest

from scryer_reference.model import ModelError, load_case_json
from scryer_reference.money import MoneyError
from scryer_reference.projection import compare_school_surplus, project_school_surplus

_FIXTURE = Path(__file__).parent / "fixtures" / "golden-case.json"


def raw_golden():
    return json.loads(_FIXTURE.read_text())


def parse_case(raw):
    return load_case_json(json.dumps(raw, separators=(",", ":")))


class ProjectionTests(unittest.TestCase):
    def test_golden_before_correction_is_1500_dollars(self):
        projection = project_school_surplus(parse_case(raw_golden()), ("event-base-charge",), "2026-fall")
        self.assertEqual(projection.status, "SUPPORTED_BY_UPLOADED_RECORDS")
        self.assertEqual(projection.currency, "USD")
        self.assertEqual(projection.amount_minor, 150000)
        self.assertEqual(projection.fact_ids, ("base-charge", "grant", "other-credit"))
        self.assertIn("NOT_ENTITLEMENT", projection.limitation_codes)

    def test_in_memory_mixed_currency_case_is_rejected_before_aggregation(self):
        case = parse_case(raw_golden())
        event = case.events[0]
        altered = replace(event, fact=replace(event.fact, currency="EUR"))
        case = replace(case, events=(altered,) + case.events[1:])
        with self.assertRaises(ModelError) as raised:
            project_school_surplus(case, ("event-base-charge",), "2026-fall")
        self.assertEqual(raised.exception.code, "CURRENCY_MISMATCH")

    def test_golden_after_two_reviewed_changes_is_900_dollars(self):
        projection = project_school_surplus(parse_case(raw_golden()), ("event-extra-charge",), "2026-fall")
        self.assertEqual(projection.status, "SUPPORTED_BY_UPLOADED_RECORDS")
        self.assertEqual(projection.amount_minor, 90000)
        self.assertEqual(projection.fact_ids, ("base-charge", "extra-charge", "grant", "other-credit"))

    def test_exact_change_attribution_has_two_minus_300_dollar_effects(self):
        comparison = compare_school_surplus(
            parse_case(raw_golden()), ("event-base-charge",), ("event-extra-charge",), "2026-fall"
        )
        self.assertEqual(comparison.delta_minor, -60000)
        self.assertEqual(
            {item.fact_id: item.delta_minor for item in comparison.contributions},
            {"grant": -30000, "extra-charge": -30000},
        )
        self.assertEqual(sum(item.delta_minor for item in comparison.contributions), -60000)

    def test_offer_pending_and_work_study_are_not_posted_credits(self):
        for role in ("aid_offer", "aid_pending", "work_study_offer"):
            with self.subTest(role=role):
                raw = raw_golden()
                raw["events"] = [raw["events"][0]]
                raw["events"][0]["fact"]["role"] = role
                projection = project_school_surplus(parse_case(raw), ("event-grant",), "2026-fall")
                self.assertEqual(projection.status, "INSUFFICIENT_COVERAGE")
                self.assertIsNone(projection.amount_minor)

    def test_unreviewed_proposal_has_no_financial_effect(self):
        raw = raw_golden()
        raw["events"] = []
        projection = project_school_surplus(parse_case(raw), (), "2026-fall")
        self.assertEqual(projection.status, "INSUFFICIENT_COVERAGE")
        self.assertIsNone(projection.amount_minor)
        self.assertEqual(projection.fact_ids, ())

    def test_two_legitimate_equal_charges_at_different_source_positions_both_count(self):
        raw = raw_golden()
        repeated = copy.deepcopy(raw["events"][4])
        repeated["eventId"] = "event-repeat-charge"
        repeated["parents"] = ["event-extra-charge"]
        repeated["fact"]["factId"] = "repeat-charge"
        repeated["fact"]["reviewId"] = "review-repeat-charge"
        repeated["fact"]["source"]["location"] = "row:3"
        raw["events"].append(repeated)
        projection = project_school_surplus(parse_case(raw), ("event-repeat-charge",), "2026-fall")
        self.assertEqual(projection.amount_minor, 60000)
        self.assertIn("repeat-charge", projection.fact_ids)

    def test_fixed_event_set_permutation_does_not_change_projection(self):
        raw = raw_golden()
        first = project_school_surplus(parse_case(raw), ("event-extra-charge",), "2026-fall")
        raw["events"].reverse()
        second = project_school_surplus(parse_case(raw), ("event-extra-charge",), "2026-fall")
        self.assertEqual(first, second)

    def test_issued_refund_and_bank_observation_do_not_change_school_surplus(self):
        case = parse_case(raw_golden())
        comparison = compare_school_surplus(case, ("event-extra-charge",), ("event-bank-credit",), "2026-fall")
        self.assertEqual(comparison.delta_minor, 0)
        self.assertEqual(comparison.contributions, ())
        self.assertEqual(comparison.before.amount_minor, 90000)
        self.assertEqual(comparison.after.amount_minor, 90000)

    def test_second_institution_school_account_does_not_enter_first_terms_total(self):
        raw = raw_golden()
        raw["institutions"].append({"institutionId": "institution-b"})
        raw["accountRefs"].append(
            {"accountRefId": "school-b", "kind": "school", "institutionId": "institution-b", "holderKind": None}
        )
        raw["terms"].append(
            {
                "termId": "2026-fall-b",
                "institutionId": "institution-b",
                "schoolAccountRefId": "school-b",
                "startDate": "2026-08-20",
                "endDateExclusive": "2026-12-21",
            }
        )
        raw["events"].append(
            {
                "eventId": "event-b-credit",
                "parents": ["event-extra-charge"],
                "recordedAt": "2026-09-05T10:00:00Z",
                "kind": "approve_fact",
                "fact": {
                    "factId": "b-credit",
                    "termId": "2026-fall-b",
                    "accountRefId": "school-b",
                    "currency": "USD",
                    "role": "school_credit",
                    "recipientKind": None,
                    "amountMinor": "5000",
                    "proposalId": None,
                    "aidItemId": None,
                    "effectiveDate": "2026-08-20",
                    "source": {"kind": "manual", "entryId": "b-credit-entry"},
                    "reviewId": "review-b-credit",
                },
            }
        )
        case = parse_case(raw)
        self.assertEqual(project_school_surplus(case, ("event-b-credit",), "2026-fall").amount_minor, 90000)
        other = project_school_surplus(case, ("event-b-credit",), "2026-fall-b")
        self.assertEqual(other.amount_minor, 5000)
        self.assertEqual(other.fact_ids, ("b-credit",))

    def test_manual_fact_makes_support_status_user_asserted(self):
        raw = raw_golden()
        raw["events"][0]["fact"]["source"] = {"kind": "manual", "entryId": "manual-grant"}
        projection = project_school_surplus(parse_case(raw), ("event-base-charge",), "2026-fall")
        self.assertEqual(projection.status, "USER_ASSERTED")
        self.assertIn("MANUAL_SOURCE", projection.limitation_codes)

    def test_incomparable_corrections_do_not_choose_by_id(self):
        raw = raw_golden()
        competing = copy.deepcopy(raw["events"][3])
        competing["eventId"] = "event-grant-correction-b"
        competing["correction"]["replacementAmountMinor"] = "250000"
        competing["correction"]["reviewId"] = "review-grant-correction-b"
        competing["correction"]["source"]["location"] = "row:3"
        raw["events"].append(competing)
        projection = project_school_surplus(
            parse_case(raw), ("event-grant-correction", "event-grant-correction-b"), "2026-fall"
        )
        self.assertEqual(projection.status, "CONTRADICTORY_EVIDENCE")
        self.assertIsNone(projection.amount_minor)
        self.assertIn("UNRESOLVED_CORRECTION_CONFLICT", projection.limitation_codes)

    def test_unrelated_refund_fact_does_not_enter_conflicting_school_fact_list(self):
        raw = raw_golden()
        competing = copy.deepcopy(raw["events"][3])
        competing["eventId"] = "event-grant-correction-b"
        competing["correction"]["replacementAmountMinor"] = "250000"
        competing["correction"]["reviewId"] = "review-grant-correction-b"
        refund = copy.deepcopy(raw["events"][5])
        refund["eventId"] = "event-unrelated-refund"
        refund["parents"] = ["event-base-charge"]
        refund["fact"]["factId"] = "unrelated-refund"
        refund["fact"]["reviewId"] = "review-unrelated-refund"
        raw["events"].extend((competing, refund))
        projection = project_school_surplus(
            parse_case(raw),
            ("event-grant-correction", "event-grant-correction-b", "event-unrelated-refund"),
            "2026-fall",
        )
        self.assertEqual(projection.status, "CONTRADICTORY_EVIDENCE")
        self.assertEqual(projection.fact_ids, ("base-charge", "grant", "other-credit"))

    def test_intermediate_cent_overflow_is_rejected_even_if_later_charge_cancels_it(self):
        raw = raw_golden()
        raw["events"][0]["fact"]["amountMinor"] = "9223372036854775807"
        raw["events"][1]["fact"]["amountMinor"] = "1"
        raw["events"][2]["fact"]["amountMinor"] = "0"
        tail = copy.deepcopy(raw["events"][2])
        tail["eventId"] = "event-tail-charge"
        tail["parents"] = ["event-base-charge"]
        tail["fact"]["factId"] = "zz-charge"
        tail["fact"]["reviewId"] = "review-tail-charge"
        tail["fact"]["amountMinor"] = "1"
        tail["fact"]["source"]["location"] = "row:tail"
        raw["events"].append(tail)
        with self.assertRaises(MoneyError) as raised:
            project_school_surplus(parse_case(raw), ("event-tail-charge",), "2026-fall")
        self.assertEqual(raised.exception.code, "MONEY_OVERFLOW")


if __name__ == "__main__":
    unittest.main()
