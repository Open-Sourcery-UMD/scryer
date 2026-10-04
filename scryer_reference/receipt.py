"""Canonical school-surplus derivation receipts from approved reference facts."""

import hashlib
import json
from typing import Any

from .model import Case, ModelError, SourceRef, snapshot_events
from .projection import _current_correction, project_school_surplus

def _canonical_bytes(value: Any) -> bytes:
    if value is None or type(value) is bool:
        pass
    elif type(value) is str:
        if not value.isascii():
            raise ModelError("NONCANONICAL_RECEIPT")
    elif type(value) is list:
        for item in value:
            _canonical_bytes(item)
    elif type(value) is dict:
        for key, item in value.items():
            if type(key) is not str or not key.isascii():
                raise ModelError("NONCANONICAL_RECEIPT")
            _canonical_bytes(item)
    else:
        raise ModelError("NONCANONICAL_RECEIPT")
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def _source_ref(source: SourceRef, case: Case) -> dict[str, str]:
    if source.kind == "manual":
        if source.entry_id is None:
            raise ModelError("INVALID_SOURCE")
        return {"kind": "manual", "entryId": source.entry_id}
    if source.artifact_id is None or source.location is None:
        raise ModelError("INVALID_SOURCE")
    artifacts = {artifact.artifact_id: artifact for artifact in case.artifacts}
    artifact = artifacts.get(source.artifact_id)
    if artifact is None:
        raise ModelError("MISSING_ARTIFACT")
    return {
        "kind": "artifact",
        "artifactId": source.artifact_id,
        "location": source.location,
        "sha256": artifact.sha256,
        "observedAt": artifact.observed_at,
    }


def make_school_surplus_receipt(case: Case, heads: tuple[str, ...], term_id: str) -> dict[str, object]:
    """Describe an internally checkable source-based total; not source authenticity."""

    projection = project_school_surplus(case, heads, term_id)
    if projection.amount_minor is None:
        raise ModelError("UNSUPPORTED_RECEIPT_STATUS")
    snapshot = snapshot_events(case, heads)
    approvals = {event.fact.fact_id: event for event in snapshot if event.fact is not None}
    corrections: dict[str, list] = {}
    for event in snapshot:
        if event.correction is not None:
            corrections.setdefault(event.correction.fact_id, []).append(event)

    steps: list[dict[str, object]] = []
    for fact_id in projection.fact_ids:
        approval = approvals[fact_id]
        fact = approval.fact
        if fact is None:
            raise ModelError("INVALID_EVENT_STATE")
        current = _current_correction(corrections.get(fact_id, []))
        amount = fact.amount_minor
        source = fact.source
        correction_id: str | None = None
        correction_review_id: str | None = None
        correction_recorded_at: str | None = None
        if current is not None:
            payload = current.correction
            if payload is None:
                raise ModelError("INVALID_EVENT_STATE")
            amount = 0 if payload.cancelled else payload.replacement_amount_minor
            source = payload.source
            correction_id = current.event_id
            correction_review_id = payload.review_id
            correction_recorded_at = current.recorded_at
        if amount is None:
            raise ModelError("INVALID_CORRECTION")
        contribution = amount if fact.role == "school_credit" else -amount
        steps.append(
            {
                "factId": fact_id,
                "role": fact.role,
                "originalAmountMinor": str(fact.amount_minor),
                "currentAmountMinor": str(amount),
                "contributionMinor": str(contribution),
                "approvalEventId": approval.event_id,
                "approvalReviewId": fact.review_id,
                "approvalRecordedAt": approval.recorded_at,
                "correctionEventId": correction_id,
                "correctionReviewId": correction_review_id,
                "correctionRecordedAt": correction_recorded_at,
                "effectiveDate": fact.effective_date,
                "originalSourceRef": _source_ref(fact.source, case),
                "sourceRef": _source_ref(source, case),
            }
        )

    core: dict[str, object] = {
        "schemaVersion": "1",
        "engineVersion": "reference-0.1.0",
        "ruleVersion": "school-surplus-1",
        "metric": "school_surplus",
        "caseId": case.case_id,
        "heads": list(projection.heads),
        "termId": term_id,
        "status": projection.status,
        "amountMinor": str(projection.amount_minor),
        "facts": steps,
        "limitations": sorted(set(projection.limitation_codes) | {"SOURCE_AUTHENTICITY_NOT_VERIFIED"}),
    }
    digest = hashlib.sha256(_canonical_bytes(core)).hexdigest()
    return {**core, "digest": digest}
