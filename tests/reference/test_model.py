import copy
import json
import unittest

from scryer_reference.model import ModelError, load_case_json, snapshot_events


def minimal_case():
    return {
        "schemaVersion": "1",
        "caseId": "case-a",
        "currency": "USD",
        "institutions": [{"institutionId": "institution-a"}],
        "accountRefs": [
            {"accountRefId": "school-a", "kind": "school", "institutionId": "institution-a"},
            {"accountRefId": "bank-a", "kind": "bank", "institutionId": None},
        ],
        "terms": [
            {
                "termId": "2026-fall",
                "institutionId": "institution-a",
                "schoolAccountRefId": "school-a",
                "startDate": "2026-08-20",
                "endDateExclusive": "2026-12-21",
            }
        ],
        "artifacts": [
            {
                "artifactId": "bill-a",
                "sha256": "0" * 64,
                "kind": "school_bill",
                "observedAt": "2026-09-01T12:00:00Z",
                "accountRefId": "school-a",
            }
        ],
        "proposals": [],
        "events": [
            {
                "eventId": "event-credit",
                "parents": [],
                "recordedAt": "2026-09-02T12:00:00Z",
                "kind": "approve_fact",
                "fact": {
                    "factId": "credit-a",
                    "termId": "2026-fall",
                    "accountRefId": "school-a",
                    "currency": "USD",
                    "role": "school_credit",
                    "amountMinor": "650000",
                    "effectiveDate": "2026-08-20",
                    "source": {"kind": "artifact", "artifactId": "bill-a", "location": "row:1"},
                    "reviewId": "review-credit",
                },
            }
        ],
    }


def json_case(value):
    return json.dumps(value, separators=(",", ":"))


class CaseParserTests(unittest.TestCase):
    def test_minimal_approved_fact_has_exact_provenance(self):
        case = load_case_json(json_case(minimal_case()))
        self.assertEqual(case.case_id, "case-a")
        self.assertEqual(case.currency, "USD")
        self.assertEqual(case.events[0].fact.amount_minor, 650000)
        self.assertEqual(case.events[0].fact.currency, "USD")
        self.assertEqual(case.events[0].fact.source.artifact_id, "bill-a")
        self.assertEqual(case.events[0].fact.account_ref_id, "school-a")
        self.assertEqual(case.terms[0].institution_id, "institution-a")
        self.assertEqual(tuple(event.event_id for event in snapshot_events(case, ("event-credit",))), ("event-credit",))

    def test_duplicate_json_key_is_rejected(self):
        document = '{"schemaVersion":"1","schemaVersion":"1","caseId":"case-a","termIds":[],"artifacts":[],"proposals":[],"events":[]}'
        with self.assertRaises(ModelError) as raised:
            load_case_json(document)
        self.assertEqual(raised.exception.code, "DUPLICATE_JSON_KEY")

    def test_invalid_unicode_in_document_returns_typed_error(self):
        document = '{"schemaVersion":"1","caseId":"case-\ud800","termIds":[],"artifacts":[],"proposals":[],"events":[]}'
        with self.assertRaises(ModelError) as raised:
            load_case_json(document)
        self.assertEqual(raised.exception.code, "INVALID_JSON")

    def test_unknown_field_is_rejected(self):
        raw = minimal_case()
        raw["serverKnowsBalance"] = True
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "INVALID_SCHEMA")

    def test_missing_parent_is_rejected(self):
        raw = minimal_case()
        raw["events"][0]["parents"] = ["missing"]
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "MISSING_PARENT")

    def test_parent_cycle_is_rejected(self):
        raw = minimal_case()
        raw["events"][0]["parents"] = ["event-correction"]
        raw["events"].append(
            {
                "eventId": "event-correction",
                "parents": ["event-credit"],
                "recordedAt": "2026-09-03T12:00:00Z",
                "kind": "correct_fact",
                "correction": {
                    "factId": "credit-a",
                    "replacementAmountMinor": "620000",
                    "cancelled": False,
                    "source": {"kind": "artifact", "artifactId": "bill-a", "location": "row:2"},
                    "reviewId": "review-correction",
                },
            }
        )
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "EVENT_CYCLE")

    def test_duplicate_event_id_is_rejected(self):
        raw = minimal_case()
        raw["events"].append(copy.deepcopy(raw["events"][0]))
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "DUPLICATE_EVENT_ID")

    def test_duplicate_fact_id_is_rejected(self):
        raw = minimal_case()
        other = copy.deepcopy(raw["events"][0])
        other["eventId"] = "event-credit-2"
        other["fact"]["reviewId"] = "review-credit-2"
        raw["events"].append(other)
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "DUPLICATE_FACT_ID")

    def test_missing_source_artifact_is_rejected(self):
        raw = minimal_case()
        raw["events"][0]["fact"]["source"]["artifactId"] = "other-bill"
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "MISSING_ARTIFACT")

    def test_invalid_effective_date_is_rejected(self):
        raw = minimal_case()
        raw["events"][0]["fact"]["effectiveDate"] = "2026-02-30"
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "INVALID_DATE")

    def test_decoded_proposal_field_over_64_kib_is_rejected(self):
        raw = minimal_case()
        raw["proposals"].append(
            {"proposalId": "proposal-a", "artifactId": "bill-a", "sourceLocation": "row:1", "rawValue": "é" * 40000}
        )
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "INVALID_SCHEMA")

    def test_unpaired_unicode_surrogate_is_rejected(self):
        raw = minimal_case()
        raw["proposals"].append(
            {"proposalId": "proposal-a", "artifactId": "bill-a", "sourceLocation": "row:1", "rawValue": "\ud800"}
        )
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "INVALID_SCHEMA")

    def test_permuted_event_input_has_the_same_causal_snapshot(self):
        raw = minimal_case()
        raw["events"].append(
            {
                "eventId": "event-charge",
                "parents": ["event-credit"],
                "recordedAt": "2026-09-03T12:00:00Z",
                "kind": "approve_fact",
                "fact": {
                    "factId": "charge-a",
                    "termId": "2026-fall",
                    "accountRefId": "school-a",
                    "currency": "USD",
                    "role": "school_charge",
                    "amountMinor": "500000",
                    "effectiveDate": "2026-08-21",
                    "source": {"kind": "artifact", "artifactId": "bill-a", "location": "row:2"},
                    "reviewId": "review-charge",
                },
            }
        )
        first = load_case_json(json_case(raw))
        raw["events"].reverse()
        second = load_case_json(json_case(raw))
        self.assertEqual(
            tuple(event.event_id for event in snapshot_events(first, ("event-charge",))),
            ("event-credit", "event-charge"),
        )
        self.assertEqual(
            tuple(event.event_id for event in snapshot_events(first, ("event-charge",))),
            tuple(event.event_id for event in snapshot_events(second, ("event-charge",))),
        )

    def test_unknown_fact_account_is_rejected(self):
        raw = minimal_case()
        raw["events"][0]["fact"]["accountRefId"] = "school-missing"
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "MISSING_ACCOUNT")

    def test_unsupported_case_and_fact_currency_are_rejected(self):
        raw = minimal_case()
        raw["currency"] = "EUR"
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "UNSUPPORTED_CURRENCY")
        raw["currency"] = "USD"
        raw["events"][0]["fact"]["currency"] = "EUR"
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "UNSUPPORTED_CURRENCY")

    def test_bank_observation_on_school_account_is_rejected(self):
        raw = minimal_case()
        raw["events"][0]["fact"]["role"] = "bank_credit_observed"
        raw["events"][0]["fact"]["termId"] = None
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "ACCOUNT_KIND_MISMATCH")

    def test_school_account_from_another_institution_is_rejected(self):
        raw = minimal_case()
        raw["institutions"].append({"institutionId": "institution-other"})
        raw["accountRefs"][0]["institutionId"] = "institution-other"
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "TERM_ACCOUNT_MISMATCH")

    def test_bank_fact_cannot_use_a_different_accounts_statement(self):
        raw = minimal_case()
        raw["events"][0]["fact"]["role"] = "bank_credit_observed"
        raw["events"][0]["fact"]["termId"] = None
        raw["events"][0]["fact"]["accountRefId"] = "bank-a"
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "SOURCE_ACCOUNT_MISMATCH")

    def test_bank_credit_can_have_unknown_term(self):
        raw = minimal_case()
        raw["artifacts"][0]["accountRefId"] = "bank-a"
        raw["events"][0]["fact"]["role"] = "bank_credit_observed"
        raw["events"][0]["fact"]["termId"] = None
        raw["events"][0]["fact"]["accountRefId"] = "bank-a"
        case = load_case_json(json_case(raw))
        self.assertIsNone(case.events[0].fact.term_id)
        self.assertEqual(case.events[0].fact.account_ref_id, "bank-a")

    def test_reversed_term_interval_is_rejected(self):
        raw = minimal_case()
        raw["terms"][0]["endDateExclusive"] = "2026-08-20"
        with self.assertRaises(ModelError) as raised:
            load_case_json(json_case(raw))
        self.assertEqual(raised.exception.code, "INVALID_TERM_INTERVAL")

    def test_unhashable_head_does_not_escape_as_python_type_error(self):
        case = load_case_json(json_case(minimal_case()))
        with self.assertRaises(ModelError) as raised:
            snapshot_events(case, (["event-credit"],))
        self.assertEqual(raised.exception.code, "INVALID_HEADS")


if __name__ == "__main__":
    unittest.main()
