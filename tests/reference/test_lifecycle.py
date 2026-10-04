import copy
import json
from pathlib import Path
import unittest

from scryer_reference.lifecycle import project_aid_lifecycle
from scryer_reference.model import ModelError, load_case_json

_FIXTURE = Path(__file__).parent / "fixtures" / "golden-case.json"


def raw_case(recipient="student", term_id="2026-fall"):
    raw = json.loads(_FIXTURE.read_text())
    raw["aidItems"] = [
        {
            "aidItemId": "aid-grant",
            "institutionId": "institution-a",
            "termId": term_id,
            "recipientKind": recipient,
        }
    ]
    return raw


def parsed(raw):
    return load_case_json(json.dumps(raw, separators=(",", ":")))


def add_aid_fact(raw, event_id, role, amount, parent="event-bank-credit", term_id="2026-fall"):
    event = {
        "eventId": event_id,
        "parents": [parent],
        "recordedAt": "2026-10-09T10:00:00Z",
        "kind": "approve_fact",
        "fact": {
            "factId": f"fact-{event_id}",
            "termId": term_id,
            "accountRefId": "school-a" if term_id is not None else None,
            "aidItemId": "aid-grant",
            "currency": "USD",
            "role": role,
            "amountMinor": str(amount),
            "proposalId": None,
            "effectiveDate": "2026-08-20",
            "source": {"kind": "artifact", "artifactId": "aid-a", "location": f"row:{event_id}"},
            "reviewId": f"review-{event_id}",
        },
    }
    raw["events"].append(event)
    return event


class LifecycleTests(unittest.TestCase):
    def test_two_split_postings_are_exact_without_inventing_offer_or_acceptance(self):
        raw = raw_case()
        raw["events"][0]["fact"]["aidItemId"] = "aid-grant"
        raw["events"][1]["fact"]["aidItemId"] = "aid-grant"
        result = project_aid_lifecycle(parsed(raw), ("event-other-credit",), "2026-fall", "aid-grant")
        self.assertEqual(result.status, "SUPPORTED_BY_UPLOADED_RECORDS")
        self.assertEqual(result.posted_minor, 650000)
        self.assertEqual(tuple(item.role for item in result.observations), ("school_credit", "school_credit"))
        self.assertIn("OFFER_NOT_OBSERVED", result.finding_codes)
        self.assertIn("ACCEPTANCE_NOT_OBSERVED", result.finding_codes)

    def test_late_offer_does_not_change_earlier_as_known_posting(self):
        raw = raw_case()
        raw["events"][0]["fact"]["aidItemId"] = "aid-grant"
        add_aid_fact(raw, "event-offer", "aid_offer", 700000, parent="event-grant")
        case = parsed(raw)
        earlier = project_aid_lifecycle(case, ("event-grant",), "2026-fall", "aid-grant")
        later = project_aid_lifecycle(case, ("event-offer",), "2026-fall", "aid-grant")
        self.assertEqual(earlier.posted_minor, 300000)
        self.assertIn("OFFER_NOT_OBSERVED", earlier.finding_codes)
        self.assertNotIn("OFFER_NOT_OBSERVED", later.finding_codes)
        self.assertEqual(later.posted_minor, 300000)
        self.assertEqual(later.current_offer_minor, 700000)

    def test_pending_cancellation_does_not_add_to_posted_amount(self):
        raw = raw_case()
        raw["events"][0]["fact"]["aidItemId"] = "aid-grant"
        add_aid_fact(raw, "event-pending", "aid_pending", 100000, parent="event-grant")
        raw["events"].append(
            {
                "eventId": "event-pending-cancel",
                "parents": ["event-pending"],
                "recordedAt": "2026-10-10T10:00:00Z",
                "kind": "correct_fact",
                "correction": {
                    "factId": "fact-event-pending",
                    "replacementAmountMinor": None,
                    "cancelled": True,
                    "source": {"kind": "artifact", "artifactId": "aid-a", "location": "row:pending-revised"},
                    "reviewId": "review-pending-cancel",
                },
            }
        )
        result = project_aid_lifecycle(parsed(raw), ("event-pending-cancel",), "2026-fall", "aid-grant")
        self.assertEqual(result.posted_minor, 300000)
        self.assertEqual(result.current_pending_minor, 0)
        self.assertEqual(result.status, "SUPPORTED_BY_UPLOADED_RECORDS")

    def test_canceled_pending_snapshot_can_be_replaced_by_reviewed_pending_fact(self):
        raw = raw_case()
        add_aid_fact(raw, "event-pending-a", "aid_pending", 100000)
        raw["events"].append(
            {
                "eventId": "event-pending-cancel",
                "parents": ["event-pending-a"],
                "recordedAt": "2026-10-10T10:00:00Z",
                "kind": "correct_fact",
                "correction": {
                    "factId": "fact-event-pending-a", "replacementAmountMinor": None, "cancelled": True,
                    "source": {"kind": "artifact", "artifactId": "aid-a", "location": "row:pending-a-revised"},
                    "reviewId": "review-pending-a-cancel",
                },
            }
        )
        add_aid_fact(raw, "event-pending-b", "aid_pending", 80000, parent="event-pending-cancel")
        result = project_aid_lifecycle(parsed(raw), ("event-pending-b",), "2026-fall", "aid-grant")
        self.assertEqual(result.status, "PENDING")
        self.assertEqual(result.current_pending_minor, 80000)
        self.assertEqual(result.posted_minor, 0)

    def test_accepted_without_offer_remains_an_observation_not_an_inferred_offer(self):
        raw = raw_case()
        add_aid_fact(raw, "event-accepted", "aid_accepted", 500000)
        result = project_aid_lifecycle(parsed(raw), ("event-accepted",), "2026-fall", "aid-grant")
        self.assertEqual(result.status, "OBSERVED")
        self.assertEqual(result.current_accepted_minor, 500000)
        self.assertIsNone(result.current_offer_minor)
        self.assertIn("OFFER_NOT_OBSERVED", result.finding_codes)

    def test_work_study_offer_is_not_posted_credit(self):
        raw = raw_case()
        add_aid_fact(raw, "event-work-study", "work_study_offer", 200000)
        result = project_aid_lifecycle(parsed(raw), ("event-work-study",), "2026-fall", "aid-grant")
        self.assertEqual(result.posted_minor, 0)
        self.assertEqual(result.status, "OBSERVED")
        self.assertIn("WORK_STUDY_NOT_POSTED", result.finding_codes)

    def test_work_study_offer_and_separate_posting_need_review(self):
        raw = raw_case()
        raw["events"][0]["fact"]["aidItemId"] = "aid-grant"
        add_aid_fact(raw, "event-work-study", "work_study_offer", 200000)
        result = project_aid_lifecycle(parsed(raw), ("event-work-study",), "2026-fall", "aid-grant")
        self.assertEqual(result.posted_minor, 270000)
        self.assertIn("WORK_STUDY_POSTING_REQUIRES_REVIEW", result.finding_codes)
        self.assertNotIn("WORK_STUDY_NOT_POSTED", result.finding_codes)

    def test_parent_recipient_requires_recipient_verification(self):
        raw = raw_case(recipient="parent")
        raw["events"][0]["fact"]["aidItemId"] = "aid-grant"
        result = project_aid_lifecycle(parsed(raw), ("event-grant",), "2026-fall", "aid-grant")
        self.assertEqual(result.recipient_kind, "parent")
        self.assertIn("NON_STUDENT_RECIPIENT", result.finding_codes)
        self.assertIn("VERIFY_RECIPIENT_ACCOUNT", result.next_action_codes)

    def test_annual_offer_is_not_divided_into_a_term(self):
        raw = raw_case(term_id=None)
        add_aid_fact(raw, "event-annual-offer", "aid_offer", 1200000, term_id=None)
        result = project_aid_lifecycle(parsed(raw), ("event-annual-offer",), "2026-fall", "aid-grant")
        self.assertEqual(result.status, "UNSUPPORTED_INPUT")
        self.assertEqual(result.posted_minor, 0)
        self.assertIn("ANNUAL_UNALLOCATED", result.finding_codes)

    def test_two_unreconciled_offer_snapshots_are_ambiguous(self):
        raw = raw_case()
        add_aid_fact(raw, "event-offer-a", "aid_offer", 700000)
        add_aid_fact(raw, "event-offer-b", "aid_offer", 650000, parent="event-offer-a")
        result = project_aid_lifecycle(parsed(raw), ("event-offer-b",), "2026-fall", "aid-grant")
        self.assertEqual(result.status, "AMBIGUOUS")
        self.assertIsNone(result.current_offer_minor)
        self.assertIn("MULTIPLE_OFFER_SNAPSHOTS", result.finding_codes)

    def test_manual_posting_is_labeled_user_asserted(self):
        raw = raw_case()
        raw["events"][0]["fact"]["aidItemId"] = "aid-grant"
        raw["events"][0]["fact"]["source"] = {"kind": "manual", "entryId": "manual-grant"}
        result = project_aid_lifecycle(parsed(raw), ("event-grant",), "2026-fall", "aid-grant")
        self.assertEqual(result.status, "USER_ASSERTED")
        self.assertIn("MANUAL_SOURCE", result.limitation_codes)

    def test_conflicting_posting_corrections_remain_contradictory(self):
        raw = raw_case()
        raw["events"][0]["fact"]["aidItemId"] = "aid-grant"
        competing = copy.deepcopy(raw["events"][3])
        competing["eventId"] = "event-grant-correction-b"
        competing["correction"]["replacementAmountMinor"] = "250000"
        competing["correction"]["reviewId"] = "review-grant-correction-b"
        raw["events"].append(competing)
        result = project_aid_lifecycle(
            parsed(raw), ("event-grant-correction", "event-grant-correction-b"), "2026-fall", "aid-grant"
        )
        self.assertEqual(result.status, "CONTRADICTORY_EVIDENCE")
        self.assertIsNone(result.posted_minor)

    def test_cross_term_link_and_balance_snapshot_link_are_rejected(self):
        raw = raw_case()
        raw["terms"].append(
            {
                "termId": "2027-spring", "institutionId": "institution-a", "schoolAccountRefId": "school-a",
                "startDate": "2027-01-10", "endDateExclusive": "2027-05-20",
            }
        )
        raw["aidItems"][0]["termId"] = "2027-spring"
        raw["events"][0]["fact"]["aidItemId"] = "aid-grant"
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "AID_ITEM_TERM_MISMATCH")
        raw["aidItems"][0]["termId"] = "2026-fall"
        raw["events"][0]["fact"]["role"] = "balance_snapshot"
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "ROLE_AID_ITEM_MISMATCH")


if __name__ == "__main__":
    unittest.main()
