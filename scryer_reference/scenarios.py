"""Fixed-seed synthetic cases for oracle and later differential tests."""

import hashlib
import json
import random

from .model import Case, load_case_json


def generate_case(seed: int) -> Case:
    """Generate one reproducible, synthetic single-term school-account case."""

    if type(seed) is not int or seed < -(1 << 63) or seed > (1 << 63) - 1:
        raise ValueError("INVALID_SEED")
    rng = random.Random(seed)
    first_credit = rng.randint(100_000, 700_000)
    second_credit = rng.randint(10_000, 400_000)
    charge = rng.randint(20_000, 500_000)
    tag = f"n{abs(seed)}" if seed >= 0 else f"m{abs(seed)}"
    artifact_id = f"synthetic-{tag}"
    if len(artifact_id) > 64:
        raise ValueError("INVALID_SEED")
    artifact_hash = hashlib.sha256(f"scryer-synthetic-{seed}".encode("ascii")).hexdigest()

    def approved(event_id: str, parents: list[str], fact_id: str, role: str, amount: int, row: int) -> dict:
        return {
            "eventId": event_id,
            "parents": parents,
            "recordedAt": f"2026-09-0{row}T12:00:00Z",
            "kind": "approve_fact",
            "fact": {
                "factId": fact_id,
                "termId": "2026-fall",
                "accountRefId": "school-a",
                "currency": "USD",
                "role": role,
                "recipientKind": None,
                "amountMinor": str(amount),
                "proposalId": None,
                "aidItemId": None,
                "effectiveDate": "2026-08-20",
                "source": {"kind": "artifact", "artifactId": artifact_id, "location": f"row:{row}"},
                "reviewId": f"review-{fact_id}",
            },
        }

    raw = {
        "schemaVersion": "1",
        "caseId": f"case-{tag}",
        "currency": "USD",
        "institutions": [{"institutionId": "institution-a"}],
        "aidItems": [],
        "accountRefs": [{"accountRefId": "school-a", "kind": "school", "institutionId": "institution-a", "holderKind": None}],
        "terms": [{
            "termId": "2026-fall",
            "institutionId": "institution-a",
            "schoolAccountRefId": "school-a",
            "startDate": "2026-08-20",
            "endDateExclusive": "2026-12-21",
        }],
        "artifacts": [
            {
                "artifactId": artifact_id,
                "sha256": artifact_hash,
                "kind": "synthetic_statement",
                "observedAt": "2026-09-01T10:00:00Z",
                "accountRefId": "school-a",
            }
        ],
        "proposals": [],
        "events": [
            approved("event-credit-a", [], "credit-a", "school_credit", first_credit, 1),
            approved("event-credit-b", ["event-credit-a"], "credit-b", "school_credit", second_credit, 2),
            approved("event-charge", ["event-credit-b"], "charge", "school_charge", charge, 3),
        ],
    }
    return load_case_json(json.dumps(raw, separators=(",", ":")))
