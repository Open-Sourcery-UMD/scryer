import json
from pathlib import Path
import subprocess
import unittest

from scryer_reference.coverage import evaluate_bank_coverage
from scryer_reference.lifecycle import project_aid_lifecycle
from scryer_reference.matching import suggest_refund_deposits
from scryer_reference.model import load_case_json
from scryer_reference.scenarios import generate_raw_case

ROOT = Path(__file__).resolve().parents[2]
PROBE = ROOT / "engine" / "build" / "evidence_probe"
MANIFEST = ROOT / "tests" / "reference" / "corpus" / "manifest.json"


def minor(value):
    return None if value is None else str(value)


def coverage_value(result):
    return {
        "accountRefId": result.account_ref_id,
        "startDate": result.start_date,
        "endDateExclusive": result.end_date_exclusive,
        "status": result.status,
        "coveredIntervals": [list(item) for item in result.covered_intervals],
        "missingIntervals": [list(item) for item in result.missing_intervals],
        "assertionIds": list(result.assertion_ids),
        "limitationCodes": list(result.limitation_codes),
    }


def expected_value(raw, operation):
    case = load_case_json(json.dumps(raw, separators=(",", ":")))
    kind = operation["operation"]
    if kind == "coverage":
        return coverage_value(evaluate_bank_coverage(
            case, tuple(operation["heads"]), operation["accountRefId"],
            operation["startDate"], operation["endDateExclusive"],
        ))
    if kind == "matching":
        result = suggest_refund_deposits(
            case, tuple(operation["heads"]), operation["refundFactId"], operation["bankAccountRefId"],
        )
        return {
            "refundFactId": result.refund_fact_id,
            "bankAccountRefId": result.bank_account_ref_id,
            "currency": result.currency,
            "status": result.status,
            "refundAmountMinor": minor(result.refund_amount_minor),
            "candidateFactIds": list(result.candidate_fact_ids),
            "confirmedAllocations": [
                {
                    "bankFactId": item.bank_fact_id, "bankAccountRefId": item.bank_account_ref_id,
                    "allocatedMinor": str(item.allocated_minor), "decisionEventId": item.decision_event_id,
                }
                for item in result.confirmed_allocations
            ],
            "remainingMinor": minor(result.remaining_minor),
            "coverage": None if result.coverage is None else coverage_value(result.coverage),
            "reasonCodes": list(result.reason_codes),
        }
    if kind == "lifecycle":
        result = project_aid_lifecycle(
            case, tuple(operation["heads"]), operation["termId"], operation["aidItemId"]
        )
        return {
            "caseId": result.case_id,
            "heads": list(result.heads),
            "termId": result.term_id,
            "aidItemId": result.aid_item_id,
            "recipientKind": result.recipient_kind,
            "status": result.status,
            "currentOfferMinor": minor(result.current_offer_minor),
            "currentAcceptedMinor": minor(result.current_accepted_minor),
            "currentPendingMinor": minor(result.current_pending_minor),
            "postedMinor": minor(result.posted_minor),
            "observations": [
                {
                    "factId": item.fact_id, "role": item.role,
                    "currentAmountMinor": str(item.current_amount_minor),
                    "sourceKind": item.source_kind, "approvalEventId": item.approval_event_id,
                }
                for item in result.observations
            ],
            "findingCodes": list(result.finding_codes),
            "nextActionCodes": list(result.next_action_codes),
            "limitationCodes": list(result.limitation_codes),
            "grossDisbursedMinor": minor(result.gross_disbursed_minor),
            "withheldFeeMinor": minor(result.withheld_fee_minor),
            "unexplainedDifferenceMinor": minor(result.unexplained_difference_minor),
        }
    raise AssertionError(kind)


def manifest_value(value, kind):
    if kind == "coverage":
        return {"status": value["status"], "missingIntervals": value["missingIntervals"]}
    if kind == "matching":
        return {
            "status": value["status"],
            "candidateFactIds": value["candidateFactIds"],
            "remainingMinor": value["remainingMinor"],
            "confirmedAllocations": [
                {key: item[key] for key in ("bankFactId", "allocatedMinor")}
                for item in value["confirmedAllocations"]
            ],
        }
    if kind == "lifecycle":
        return {key: value[key] for key in (
            "status", "postedMinor", "currentOfferMinor", "grossDisbursedMinor",
            "withheldFeeMinor", "unexplainedDifferenceMinor", "findingCodes",
        )}
    raise AssertionError(kind)


def augmented_case(seed):
    raw = generate_raw_case(seed)
    amount = 20_000 + seed * 100
    credit = int(raw["events"][0]["fact"]["amountMinor"])
    raw["aidItems"].append({
        "aidItemId": "aid-grant", "institutionId": "institution-a",
        "termId": "2026-fall", "recipientKind": "student",
    })
    raw["events"][0]["fact"]["aidItemId"] = "aid-grant"
    raw["accountRefs"].append({
        "accountRefId": "bank-a", "kind": "bank", "institutionId": None, "holderKind": "student",
    })
    raw["artifacts"].extend((
        {"artifactId": "refund-notice", "sha256": "4" * 64, "kind": "refund_notice",
         "observedAt": "2026-09-06T09:00:00Z", "accountRefId": "school-a"},
        {"artifactId": "bank-statement", "sha256": "5" * 64, "kind": "bank_statement",
         "observedAt": "2026-10-08T09:00:00Z", "accountRefId": "bank-a"},
        {"artifactId": "disbursement", "sha256": "6" * 64, "kind": "aid_disbursement_statement",
         "observedAt": "2026-10-08T09:00:00Z", "accountRefId": None},
    ))

    def fact(event_id, parent, fact_id, role, amount_minor, term_id, account_id, artifact, date, aid_item=None):
        return {
            "eventId": event_id, "parents": [parent], "recordedAt": "2026-10-09T10:00:00Z",
            "kind": "approve_fact", "fact": {
                "factId": fact_id, "termId": term_id, "accountRefId": account_id,
                "aidItemId": aid_item, "currency": "USD", "role": role,
                "recipientKind": "student" if role == "refund_issued" else None,
                "amountMinor": str(amount_minor), "proposalId": None, "effectiveDate": date,
                "source": {"kind": "artifact", "artifactId": artifact, "location": f"row:{fact_id}"},
                "reviewId": f"review-{fact_id}",
            },
        }

    refund = fact("event-refund", "event-charge", "issued-refund", "refund_issued", amount,
                  "2026-fall", "school-a", "refund-notice", "2026-09-06")
    bank = fact("event-bank", "event-refund", "bank-credit", "bank_credit_observed", amount,
                None, "bank-a", "bank-statement", "2026-09-07")
    coverage = {
        "eventId": "event-coverage", "parents": ["event-bank"],
        "recordedAt": "2026-10-08T10:00:00Z", "kind": "assert_coverage",
        "coverage": {
            "coverageId": "coverage-a", "accountRefId": "bank-a", "recordType": "bank_transactions",
            "startDate": "2026-09-06", "endDateExclusive": "2026-10-07",
            "basis": "source_asserted",
            "source": {"kind": "artifact", "artifactId": "bank-statement", "location": "period"},
            "reviewId": "review-coverage-a",
        },
    }
    decision = {
        "eventId": "event-confirm", "parents": ["event-refund", "event-bank", "event-coverage"],
        "recordedAt": "2026-10-09T11:00:00Z", "kind": "decide_match",
        "decision": {
            "refundFactId": "issued-refund", "bankFactId": "bank-credit", "allocatedMinor": str(amount),
            "action": "confirm", "recipientEvidence": None, "reviewId": "review-confirm",
        },
    }
    offer = fact("event-offer", "event-coverage", "aid-offer", "aid_offer", credit + 1000,
                 "2026-fall", "school-a", raw["artifacts"][0]["artifactId"], "2026-08-20", "aid-grant")
    gross = fact("event-gross", "event-offer", "aid-gross", "aid_gross_disbursement", credit + 1000,
                 "2026-fall", None, "disbursement", "2026-08-20", "aid-grant")
    fee = fact("event-fee", "event-gross", "aid-fee", "aid_fee_withheld", 1000,
               "2026-fall", None, "disbursement", "2026-08-20", "aid-grant")
    raw["events"].extend((refund, bank, coverage, decision, offer, gross, fee))
    return raw


class NativeEvidenceParityTests(unittest.TestCase):
    def test_fixed_corpus_and_two_hundred_seeded_cases(self):
        manifest = json.loads(MANIFEST.read_text())
        requests = []
        for operation in manifest["operations"]:
            if operation["operation"] in {"coverage", "matching", "lifecycle"}:
                raw = json.loads((MANIFEST.parent / manifest["cases"][operation["case"]]).read_text())
                requests.append((raw, operation))
        self.assertEqual(len(requests), 15)
        fixed_count = len(requests)
        for seed in range(200):
            raw = augmented_case(seed)
            requests.extend((raw, operation) for operation in (
                {"operation": "coverage", "heads": ["event-coverage"], "accountRefId": "bank-a",
                 "startDate": "2026-09-06", "endDateExclusive": "2026-10-07"},
                {"operation": "coverage", "heads": ["event-coverage"], "accountRefId": "bank-a",
                 "startDate": "2026-09-06", "endDateExclusive": "2026-10-10"},
                {"operation": "matching", "heads": ["event-coverage"], "refundFactId": "issued-refund",
                 "bankAccountRefId": "bank-a"},
                {"operation": "matching", "heads": ["event-confirm"], "refundFactId": "issued-refund",
                 "bankAccountRefId": "bank-a"},
                {"operation": "lifecycle", "heads": ["event-fee"], "termId": "2026-fall",
                 "aidItemId": "aid-grant"},
            ))
        payload = "".join(json.dumps({**operation, "case": raw}, separators=(",", ":")) + "\n"
                          for raw, operation in requests)
        process = subprocess.run([str(PROBE)], input=payload, capture_output=True, text=True, check=True)
        self.assertEqual(process.stderr, "")
        lines = process.stdout.splitlines()
        self.assertEqual(len(lines), len(requests))
        for index, ((raw, operation), line) in enumerate(zip(requests, lines)):
            with self.subTest(index=index, operation=operation.get("id", operation["operation"])):
                actual = json.loads(line)
                self.assertEqual(actual, expected_value(raw, operation))
                if index < fixed_count:
                    self.assertEqual(manifest_value(actual, operation["operation"]), operation["expected"])


if __name__ == "__main__":
    unittest.main()
