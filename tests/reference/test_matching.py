import copy
import json
from pathlib import Path
import unittest

from scryer_reference.matching import suggest_refund_deposits
from scryer_reference.model import ModelError, load_case_json

_FIXTURE = Path(__file__).parent / "fixtures" / "golden-case.json"


def raw_case():
    raw = json.loads(_FIXTURE.read_text())
    raw["events"][5]["fact"]["effectiveDate"] = "2026-09-06"
    raw["events"][6]["fact"]["effectiveDate"] = "2026-09-07"
    raw["artifacts"].append(
        {
            "artifactId": "bank-period",
            "sha256": "4" * 64,
            "kind": "bank_statement",
            "observedAt": "2026-10-08T09:00:00Z",
            "accountRefId": "bank-a",
        }
    )
    raw["events"].append(
        {
            "eventId": "event-coverage",
            "parents": ["event-bank-credit"],
            "recordedAt": "2026-10-08T10:00:00Z",
            "kind": "assert_coverage",
            "coverage": {
                "coverageId": "coverage-a",
                "accountRefId": "bank-a",
                "recordType": "bank_transactions",
                "startDate": "2026-09-06",
                "endDateExclusive": "2026-10-07",
                "basis": "source_asserted",
                "source": {"kind": "artifact", "artifactId": "bank-period", "location": "statement-period"},
                "reviewId": "review-coverage-a",
            },
        }
    )
    return raw


def parsed(raw):
    return load_case_json(json.dumps(raw, separators=(",", ":")))


def add_bank(raw, suffix="b", amount="90000", date="2026-09-08", account="bank-a"):
    event = copy.deepcopy(next(item for item in raw["events"] if item["eventId"] == "event-bank-credit"))
    event["eventId"] = f"event-bank-credit-{suffix}"
    event["parents"] = ["event-bank-credit"]
    event["recordedAt"] = "2026-09-08T10:00:00Z"
    event["fact"]["factId"] = f"bank-credit-{suffix}"
    event["fact"]["amountMinor"] = amount
    event["fact"]["effectiveDate"] = date
    event["fact"]["accountRefId"] = account
    event["fact"]["reviewId"] = f"review-bank-credit-{suffix}"
    event["fact"]["source"]["location"] = f"row:{suffix}"
    raw["events"].append(event)
    next(item for item in raw["events"] if item["eventId"] == "event-coverage")["parents"].append(event["eventId"])
    return event


def add_decision(
    raw, event_id, bank_fact_id="bank-credit", bank_event_id="event-bank-credit", amount="90000",
    decision="confirm", refund_fact_id="issued-refund", refund_event_id="event-refund-issued", previous=None,
):
    parents = [refund_event_id, bank_event_id, "event-coverage"]
    if previous is not None:
        parents.append(previous)
    event = {
        "eventId": event_id,
        "parents": parents,
        "recordedAt": "2026-10-09T10:00:00Z",
        "kind": "decide_match",
        "decision": {
            "refundFactId": refund_fact_id,
            "bankFactId": bank_fact_id,
            "allocatedMinor": amount,
            "action": decision,
            "reviewId": f"review-{event_id}",
        },
    }
    raw["events"].append(event)
    return event


def query(raw, head="event-coverage", limit=1000, window=30, bank="bank-a"):
    return suggest_refund_deposits(parsed(raw), (head,), "issued-refund", bank, limit, window)


class MatchingTests(unittest.TestCase):
    def test_one_equal_bank_credit_is_suggestion_not_confirmation(self):
        result = query(raw_case())
        self.assertEqual(result.status, "SUGGESTED")
        self.assertEqual(result.candidate_fact_ids, ("bank-credit",))
        self.assertEqual(result.confirmed_allocations, ())
        self.assertEqual(result.remaining_minor, 90000)
        self.assertEqual(result.coverage.status, "SUPPORTED_BY_UPLOADED_RECORDS")

    def test_two_equal_credits_are_ambiguous_until_review(self):
        raw = raw_case()
        add_bank(raw)
        result = query(raw)
        self.assertEqual(result.status, "AMBIGUOUS")
        self.assertEqual(result.candidate_fact_ids, ("bank-credit", "bank-credit-b"))

    def test_other_account_credit_cannot_be_candidate(self):
        raw = raw_case()
        raw["accountRefs"].append({"accountRefId": "bank-b", "kind": "bank", "institutionId": None})
        artifact = copy.deepcopy(next(item for item in raw["artifacts"] if item["artifactId"] == "bank-a"))
        artifact["artifactId"] = "bank-b-statement"
        artifact["accountRefId"] = "bank-b"
        raw["artifacts"].append(artifact)
        other = add_bank(raw, account="bank-b")
        other["fact"]["source"]["artifactId"] = "bank-b-statement"
        result = query(raw)
        self.assertEqual(result.candidate_fact_ids, ("bank-credit",))

    def test_reviewed_split_deposits_consume_exact_refund_amount(self):
        raw = raw_case()
        raw["events"][6]["fact"]["amountMinor"] = "40000"
        add_bank(raw, amount="50000")
        add_decision(raw, "decision-a", amount="40000")
        add_decision(raw, "decision-b", "bank-credit-b", "event-bank-credit-b", amount="50000", previous="decision-a")
        result = query(raw, head="decision-b")
        self.assertEqual(result.status, "MATCHED_BY_REVIEW")
        self.assertEqual(result.remaining_minor, 0)
        self.assertEqual(
            tuple((item.bank_fact_id, item.allocated_minor) for item in result.confirmed_allocations),
            (("bank-credit", 40000), ("bank-credit-b", 50000)),
        )

    def test_two_refunds_cannot_overallocate_one_bank_credit(self):
        raw = raw_case()
        second_refund = copy.deepcopy(raw["events"][5])
        second_refund["eventId"] = "event-refund-issued-b"
        second_refund["fact"]["factId"] = "issued-refund-b"
        second_refund["fact"]["reviewId"] = "review-refund-b"
        second_refund["fact"]["source"]["location"] = "page:2"
        raw["events"].append(second_refund)
        add_decision(raw, "decision-a", amount="60000")
        add_decision(
            raw, "decision-b", amount="60000", refund_fact_id="issued-refund-b",
            refund_event_id="event-refund-issued-b", previous="decision-a",
        )
        result = query(raw, head="decision-b")
        self.assertEqual(result.status, "CONTRADICTORY_EVIDENCE")
        self.assertIn("BANK_OVERALLOCATED", result.reason_codes)

    def test_reviewed_rejection_removes_candidate(self):
        raw = raw_case()
        add_decision(raw, "decision-reject", amount="0", decision="reject")
        result = query(raw, head="decision-reject")
        self.assertEqual(result.status, "NO_CANDIDATE_IN_APPROVED_FACTS")
        self.assertEqual(result.candidate_fact_ids, ())
        self.assertEqual(result.remaining_minor, 90000)
        self.assertIn("SOURCE_SET_MAY_BE_INCOMPLETE", result.reason_codes)

    def test_unreviewed_bank_proposal_does_not_become_a_candidate(self):
        raw = raw_case()
        raw["events"][6]["fact"]["effectiveDate"] = "2026-09-05"
        raw["proposals"].append(
            {
                "proposalId": "proposal-bank-unreviewed",
                "artifactId": "bank-period",
                "sourceLocation": "row:99",
                "rawValue": "900.00",
            }
        )
        result = query(raw)
        self.assertEqual(result.status, "NO_CANDIDATE_IN_APPROVED_FACTS")
        self.assertEqual(result.candidate_fact_ids, ())

    def test_later_review_can_reverse_a_confirmation(self):
        raw = raw_case()
        add_decision(raw, "decision-confirm")
        add_decision(raw, "decision-reject", amount="0", decision="reject", previous="decision-confirm")
        before = query(raw, head="decision-confirm")
        after = query(raw, head="decision-reject")
        self.assertEqual(before.status, "MATCHED_BY_REVIEW")
        self.assertEqual(after.status, "NO_CANDIDATE_IN_APPROVED_FACTS")
        self.assertEqual(after.confirmed_allocations, ())

    def test_refund_correction_below_confirmed_allocation_is_contradictory(self):
        raw = raw_case()
        add_decision(raw, "decision-confirm")
        raw["events"].append(
            {
                "eventId": "event-refund-correction",
                "parents": ["event-refund-issued", "decision-confirm"],
                "recordedAt": "2026-10-10T10:00:00Z",
                "kind": "correct_fact",
                "correction": {
                    "factId": "issued-refund",
                    "replacementAmountMinor": "60000",
                    "cancelled": False,
                    "source": {"kind": "artifact", "artifactId": "refund-a", "location": "page:1-revised"},
                    "reviewId": "review-refund-correction",
                },
            }
        )
        result = query(raw, head="event-refund-correction")
        self.assertEqual(result.status, "CONTRADICTORY_EVIDENCE")
        self.assertIn("REFUND_OVERALLOCATED", result.reason_codes)

    def test_missing_period_coverage_prevents_no_candidate_conclusion(self):
        raw = raw_case()
        raw["events"][6]["fact"]["effectiveDate"] = "2026-11-01"
        raw["events"][7]["coverage"]["endDateExclusive"] = "2026-09-20"
        result = query(raw)
        self.assertEqual(result.status, "INSUFFICIENT_COVERAGE")
        self.assertEqual(result.candidate_fact_ids, ())
        self.assertEqual(result.coverage.missing_intervals, (("2026-09-20", "2026-10-07"),))

    def test_candidate_limit_returns_computation_limit(self):
        raw = raw_case()
        add_bank(raw)
        result = query(raw, limit=1)
        self.assertEqual(result.status, "COMPUTATION_LIMIT")
        self.assertEqual(result.candidate_fact_ids, ())
        self.assertIn("CANDIDATE_LIMIT_EXCEEDED", result.reason_codes)

    def test_manual_bank_observation_is_labeled_in_suggestion(self):
        raw = raw_case()
        raw["events"][6]["fact"]["source"] = {"kind": "manual", "entryId": "manual-bank-credit"}
        result = query(raw)
        self.assertEqual(result.status, "SUGGESTED")
        self.assertIn("MANUAL_BANK_OBSERVATION", result.reason_codes)

    def test_reviewed_confirmation_outside_search_window_is_flagged(self):
        raw = raw_case()
        raw["events"][6]["fact"]["effectiveDate"] = "2026-11-01"
        add_decision(raw, "decision-confirm")
        result = query(raw, head="decision-confirm")
        self.assertEqual(result.status, "MATCHED_BY_REVIEW")
        self.assertIn("CONFIRMED_OUTSIDE_SEARCH_WINDOW", result.reason_codes)

    def test_bank_correction_below_confirmed_allocation_is_contradictory(self):
        raw = raw_case()
        add_decision(raw, "decision-confirm")
        raw["events"].append(
            {
                "eventId": "event-bank-correction",
                "parents": ["event-bank-credit", "decision-confirm"],
                "recordedAt": "2026-10-10T10:00:00Z",
                "kind": "correct_fact",
                "correction": {
                    "factId": "bank-credit",
                    "replacementAmountMinor": "60000",
                    "cancelled": False,
                    "source": {"kind": "artifact", "artifactId": "bank-a", "location": "row:1-revised"},
                    "reviewId": "review-bank-correction",
                },
            }
        )
        result = query(raw, head="event-bank-correction")
        self.assertEqual(result.status, "CONTRADICTORY_EVIDENCE")
        self.assertIn("BANK_OVERALLOCATED", result.reason_codes)

    def test_concurrent_opposing_decisions_are_not_ordered_by_event_id(self):
        raw = raw_case()
        add_decision(raw, "decision-confirm")
        add_decision(raw, "decision-reject", amount="0", decision="reject")
        result = suggest_refund_deposits(
            parsed(raw), ("decision-confirm", "decision-reject"), "issued-refund", "bank-a"
        )
        self.assertEqual(result.status, "CONTRADICTORY_EVIDENCE")
        self.assertIn("CONFLICTING_MATCH_DECISIONS", result.reason_codes)

    def test_invalid_decision_requires_fact_approvals_as_direct_parents(self):
        raw = raw_case()
        decision = add_decision(raw, "decision-confirm")
        decision["parents"] = ["event-coverage"]
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "INVALID_MATCH_CAUSALITY")

    def test_zero_day_window_is_inclusive_only_on_refund_date_and_parameters_are_bounded(self):
        raw = raw_case()
        same_day = copy.deepcopy(raw)
        same_day["events"][6]["fact"]["effectiveDate"] = "2026-09-06"
        self.assertEqual(query(same_day, window=0).candidate_fact_ids, ("bank-credit",))
        self.assertEqual(query(raw, window=0).candidate_fact_ids, ())
        for limit, window, expected in ((0, 30, "INVALID_CANDIDATE_LIMIT"), (True, 30, "INVALID_CANDIDATE_LIMIT"), (1, 91, "INVALID_MATCH_WINDOW")):
            with self.subTest(limit=limit, window=window):
                with self.assertRaises(ModelError) as raised:
                    query(raw, limit=limit, window=window)
                self.assertEqual(raised.exception.code, expected)


if __name__ == "__main__":
    unittest.main()
