import copy
import json
from pathlib import Path
import unittest

from scryer_reference.coverage import evaluate_bank_coverage
from scryer_reference.model import ModelError, load_case_json

_FIXTURE = Path(__file__).parent / "fixtures" / "golden-case.json"


def raw_case():
    return json.loads(_FIXTURE.read_text())


def parsed(raw):
    return load_case_json(json.dumps(raw, separators=(",", ":")))


def assert_coverage(
    event_id="event-coverage",
    coverage_id="coverage-a",
    account_id="bank-a",
    start="2026-09-01",
    end="2026-10-01",
    basis="source_asserted",
    source=None,
):
    if source is None:
        source = {"kind": "artifact", "artifactId": "bank-a", "location": "statement-period"}
    return {
        "eventId": event_id,
        "parents": ["event-bank-credit"],
        "recordedAt": "2026-10-02T10:00:00Z",
        "kind": "assert_coverage",
        "coverage": {
            "coverageId": coverage_id,
            "accountRefId": account_id,
            "recordType": "bank_transactions",
            "startDate": start,
            "endDateExclusive": end,
            "basis": basis,
            "source": source,
            "reviewId": f"review-{coverage_id}",
        },
    }


class CoverageTests(unittest.TestCase):
    def test_source_asserted_period_supports_only_its_account_and_dates(self):
        raw = raw_case()
        raw["events"].append(assert_coverage())
        result = evaluate_bank_coverage(parsed(raw), ("event-coverage",), "bank-a", "2026-09-02", "2026-09-15")
        self.assertEqual(result.status, "SUPPORTED_BY_UPLOADED_RECORDS")
        self.assertEqual(result.covered_intervals, (("2026-09-02", "2026-09-15"),))
        self.assertEqual(result.missing_intervals, ())
        self.assertEqual(result.assertion_ids, ("coverage-a",))

    def test_manual_assertion_is_labeled_user_asserted(self):
        raw = raw_case()
        raw["events"].append(
            assert_coverage(basis="user_asserted", source={"kind": "manual", "entryId": "coverage-entry"})
        )
        result = evaluate_bank_coverage(parsed(raw), ("event-coverage",), "bank-a", "2026-09-02", "2026-09-15")
        self.assertEqual(result.status, "USER_ASSERTED")
        self.assertEqual(result.missing_intervals, ())

    def test_gap_is_exact_and_does_not_report_full_coverage(self):
        raw = raw_case()
        first = assert_coverage(end="2026-09-05")
        second = assert_coverage(
            event_id="event-coverage-b",
            coverage_id="coverage-b",
            start="2026-09-07",
            end="2026-09-10",
        )
        second["parents"] = ["event-coverage"]
        raw["events"].extend((first, second))
        result = evaluate_bank_coverage(parsed(raw), ("event-coverage-b",), "bank-a", "2026-09-01", "2026-09-10")
        self.assertEqual(result.status, "INSUFFICIENT_COVERAGE")
        self.assertEqual(
            result.covered_intervals,
            (("2026-09-01", "2026-09-05"), ("2026-09-07", "2026-09-10")),
        )
        self.assertEqual(result.missing_intervals, (("2026-09-05", "2026-09-07"),))

    def test_early_statement_end_leaves_query_tail_uncovered(self):
        raw = raw_case()
        raw["events"].append(assert_coverage(end="2026-09-10"))
        result = evaluate_bank_coverage(parsed(raw), ("event-coverage",), "bank-a", "2026-09-01", "2026-09-15")
        self.assertEqual(result.status, "INSUFFICIENT_COVERAGE")
        self.assertEqual(result.missing_intervals, (("2026-09-10", "2026-09-15"),))

    def test_other_bank_account_does_not_inherit_coverage(self):
        raw = raw_case()
        raw["accountRefs"].append({"accountRefId": "bank-b", "kind": "bank", "institutionId": None})
        raw["events"].append(assert_coverage())
        result = evaluate_bank_coverage(parsed(raw), ("event-coverage",), "bank-b", "2026-09-01", "2026-09-15")
        self.assertEqual(result.status, "INSUFFICIENT_COVERAGE")
        self.assertEqual(result.missing_intervals, (("2026-09-01", "2026-09-15"),))

    def test_observed_bank_credit_without_period_assertion_is_not_coverage(self):
        result = evaluate_bank_coverage(parsed(raw_case()), ("event-bank-credit",), "bank-a", "2026-09-01", "2026-09-15")
        self.assertEqual(result.status, "INSUFFICIENT_COVERAGE")
        self.assertEqual(result.covered_intervals, ())
        self.assertEqual(result.missing_intervals, (("2026-09-01", "2026-09-15"),))

    def test_source_assertion_on_wrong_account_artifact_is_rejected(self):
        raw = raw_case()
        raw["accountRefs"].append({"accountRefId": "bank-b", "kind": "bank", "institutionId": None})
        other_statement = copy.deepcopy(raw["artifacts"][3])
        other_statement["artifactId"] = "bank-b-statement"
        other_statement["accountRefId"] = "bank-b"
        raw["artifacts"].append(other_statement)
        event = assert_coverage()
        event["coverage"]["source"]["artifactId"] = "bank-b-statement"
        raw["events"].append(event)
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "SOURCE_ACCOUNT_MISMATCH")

    def test_source_assertion_requires_bank_statement_artifact(self):
        raw = raw_case()
        raw["artifacts"][3]["kind"] = "untyped_csv"
        raw["events"].append(assert_coverage())
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "INVALID_COVERAGE_SOURCE")

    def test_invalid_or_nonbank_coverage_interval_is_rejected(self):
        raw = raw_case()
        raw["events"].append(assert_coverage(start="2026-10-01", end="2026-09-01"))
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "INVALID_COVERAGE_INTERVAL")
        raw["events"][-1]["coverage"]["startDate"] = "2026-09-01"
        raw["events"][-1]["coverage"]["accountRefId"] = "school-a"
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "ACCOUNT_KIND_MISMATCH")

    def test_coverage_assertion_can_be_retracted_without_deleting_history(self):
        raw = raw_case()
        raw["events"].append(assert_coverage())
        raw["events"].append(
            {
                "eventId": "event-retract-coverage",
                "parents": ["event-coverage"],
                "recordedAt": "2026-10-03T10:00:00Z",
                "kind": "retract_coverage",
                "retraction": {
                    "coverageId": "coverage-a",
                    "reason": "incorrect_period",
                    "reviewId": "review-retract-coverage",
                },
            }
        )
        case = parsed(raw)
        before = evaluate_bank_coverage(case, ("event-coverage",), "bank-a", "2026-09-01", "2026-09-15")
        after = evaluate_bank_coverage(case, ("event-retract-coverage",), "bank-a", "2026-09-01", "2026-09-15")
        self.assertEqual(before.status, "SUPPORTED_BY_UPLOADED_RECORDS")
        self.assertEqual(after.status, "INSUFFICIENT_COVERAGE")
        self.assertEqual(after.missing_intervals, (("2026-09-01", "2026-09-15"),))

    def test_overlapping_source_periods_merge_and_redundant_manual_claim_does_not_downgrade(self):
        raw = raw_case()
        first = assert_coverage(end="2026-09-10")
        second = assert_coverage(
            event_id="event-coverage-b", coverage_id="coverage-b", start="2026-09-08", end="2026-09-20"
        )
        second["parents"] = ["event-coverage"]
        redundant = assert_coverage(
            event_id="event-coverage-c",
            coverage_id="coverage-c",
            start="2026-09-05",
            end="2026-09-06",
            basis="user_asserted",
            source={"kind": "manual", "entryId": "manual-coverage"},
        )
        redundant["parents"] = ["event-coverage-b"]
        raw["events"].extend((first, second, redundant))
        result = evaluate_bank_coverage(parsed(raw), ("event-coverage-c",), "bank-a", "2026-09-01", "2026-09-20")
        self.assertEqual(result.status, "SUPPORTED_BY_UPLOADED_RECORDS")
        self.assertEqual(result.covered_intervals, (("2026-09-01", "2026-09-20"),))

    def test_duplicate_coverage_id_and_noncausal_retraction_fail(self):
        raw = raw_case()
        raw["events"].extend((assert_coverage(), assert_coverage(event_id="event-coverage-b")))
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "DUPLICATE_COVERAGE_ID")
        raw["events"].pop()
        raw["events"].append(
            {
                "eventId": "event-retract-coverage",
                "parents": ["event-bank-credit"],
                "recordedAt": "2026-10-03T10:00:00Z",
                "kind": "retract_coverage",
                "retraction": {
                    "coverageId": "coverage-a", "reason": "incorrect_period", "reviewId": "review-retract"
                },
            }
        )
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "INVALID_RETRACTION_CAUSALITY")

    def test_unhashable_basis_and_reason_return_typed_errors(self):
        raw = raw_case()
        raw["events"].append(assert_coverage())
        raw["events"][-1]["coverage"]["basis"] = []
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "INVALID_COVERAGE_BASIS")
        raw["events"][-1]["coverage"]["basis"] = "source_asserted"
        raw["events"].append(
            {
                "eventId": "event-retract-coverage",
                "parents": ["event-coverage"],
                "recordedAt": "2026-10-03T10:00:00Z",
                "kind": "retract_coverage",
                "retraction": {"coverageId": "coverage-a", "reason": [], "reviewId": "review-retract"},
            }
        )
        with self.assertRaises(ModelError) as raised:
            parsed(raw)
        self.assertEqual(raised.exception.code, "INVALID_RETRACTION_REASON")


if __name__ == "__main__":
    unittest.main()
