"""Independent receipt verification without calling the projection or C++ engine."""

from dataclasses import dataclass
import hashlib
import hmac
import json
import re
from typing import Any

from .model import Case, Event, ModelError, SourceRef, snapshot_events

_SIGNED_MINOR = re.compile(r"(?:0|-[1-9][0-9]*|[1-9][0-9]*)\Z")
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_ENGINE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
_MIN = -(1 << 63)
_MAX = (1 << 63) - 1
_TOP_KEYS = frozenset(
    {
        "schemaVersion", "engineVersion", "ruleVersion", "metric", "caseId", "currency",
        "heads", "termId", "institutionId", "accountRefId", "status", "amountMinor", "facts", "limitations", "digest",
    }
)
_STEP_KEYS = frozenset(
    {
        "factId", "role", "originalAmountMinor", "currentAmountMinor",
        "contributionMinor", "approvalEventId", "correctionEventId", "sourceRef",
        "originalSourceRef",
        "approvalReviewId", "approvalRecordedAt", "correctionReviewId", "correctionRecordedAt", "effectiveDate",
    }
)


@dataclass(frozen=True)
class CheckResult:
    valid: bool
    code: str


def load_receipt_json(document: str) -> dict[str, object]:
    """Reject ambiguous JSON before checking an untrusted receipt."""

    if type(document) is not str:
        raise ModelError("INVALID_RECEIPT")
    try:
        if len(document.encode("utf-8")) > 20 * 1024 * 1024:
            raise ModelError("INVALID_RECEIPT")
    except UnicodeEncodeError as error:
        raise ModelError("INVALID_RECEIPT") from error

    def unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ModelError("DUPLICATE_JSON_KEY")
            result[key] = value
        return result

    try:
        value = json.loads(document, object_pairs_hook=unique_pairs)
    except ModelError:
        raise
    except (ValueError, RecursionError) as error:
        raise ModelError("INVALID_RECEIPT") from error
    if type(value) is not dict or not _ascii_tree(value):
        raise ModelError("INVALID_RECEIPT")
    return value


def _failed(code: str) -> CheckResult:
    return CheckResult(valid=False, code=code)


def _ascii_tree(value: Any) -> bool:
    stack = [(value, 0)]
    visited = 0
    while stack:
        item, depth = stack.pop()
        visited += 1
        if visited > 500_000 or depth > 16:
            return False
        if item is None or type(item) is bool:
            continue
        if type(item) is str:
            if not item.isascii():
                return False
        elif type(item) is list:
            stack.extend((child, depth + 1) for child in item)
        elif type(item) is dict:
            for key, child in item.items():
                if type(key) is not str or not key.isascii():
                    return False
                stack.append((child, depth + 1))
        else:
            return False
    return True


def _minor(text: Any) -> int | None:
    if type(text) is not str or _SIGNED_MINOR.fullmatch(text) is None or len(text) > 20:
        return None
    value = int(text)
    return value if _MIN <= value <= _MAX else None


def _source_matches(source: SourceRef, claimed: Any, case: Case) -> bool:
    if type(claimed) is not dict:
        return False
    if source.kind == "manual":
        return claimed == {"kind": "manual", "entryId": source.entry_id}
    artifacts = {artifact.artifact_id: artifact for artifact in case.artifacts}
    artifact = artifacts.get(source.artifact_id)
    if artifact is None:
        return False
    return claimed == {
        "kind": "artifact",
        "artifactId": source.artifact_id,
        "location": source.location,
        "sha256": artifact.sha256,
        "observedAt": artifact.observed_at,
    }


def _latest_correction(events: list[Event]) -> Event | None | bool:
    if not events:
        return None
    ids = {event.event_id for event in events}
    superseded = {parent for event in events for parent in event.parents if parent in ids}
    current = [event for event in events if event.event_id not in superseded]
    return current[0] if len(current) == 1 else False


def check_receipt(case: Case, receipt: dict[str, object]) -> CheckResult:
    """Check the stated query and arithmetic against supplied approved case facts.

    This cannot authenticate original documents or prove the source set complete.
    """

    if type(receipt) is not dict or set(receipt) != _TOP_KEYS or not _ascii_tree(receipt):
        return _failed("INVALID_RECEIPT")
    if receipt["schemaVersion"] != "1":
        return _failed("UNSUPPORTED_VERSION")
    if receipt["ruleVersion"] != "school-surplus-1" or receipt["metric"] != "school_surplus":
        return _failed("UNSUPPORTED_RULE")
    engine = receipt["engineVersion"]
    if type(engine) is not str or _ENGINE.fullmatch(engine) is None:
        return _failed("INVALID_RECEIPT")

    digest = receipt["digest"]
    if type(digest) is not str or _DIGEST.fullmatch(digest) is None:
        return _failed("DIGEST_MISMATCH")
    core = {key: value for key, value in receipt.items() if key != "digest"}
    try:
        canonical = json.dumps(core, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")
    except (TypeError, ValueError, UnicodeEncodeError):
        return _failed("INVALID_RECEIPT")
    if len(canonical) > 20 * 1024 * 1024:
        return _failed("INVALID_RECEIPT")
    if not hmac.compare_digest(hashlib.sha256(canonical).hexdigest(), digest):
        return _failed("DIGEST_MISMATCH")

    if receipt["caseId"] != case.case_id:
        return _failed("CASE_MISMATCH")
    if receipt["currency"] != case.currency:
        return _failed("CURRENCY_MISMATCH")
    heads = receipt["heads"]
    term_id = receipt["termId"]
    term = next((item for item in case.terms if item.term_id == term_id), None)
    if (
        type(heads) is not list
        or any(type(head) is not str for head in heads)
        or heads != sorted(set(heads))
        or type(term_id) is not str
        or term is None
        or receipt["institutionId"] != term.institution_id
        or receipt["accountRefId"] != term.school_account_ref_id
    ):
        return _failed("INVALID_REFERENCE")
    try:
        snapshot = snapshot_events(case, tuple(heads))
    except ModelError:
        return _failed("INVALID_REFERENCE")
    if any(event.fact is not None and event.fact.currency != case.currency for event in snapshot):
        return _failed("CURRENCY_MISMATCH")

    approvals = {
        event.fact.fact_id: event
        for event in snapshot
        if event.fact is not None and event.fact.term_id == term_id
        and event.fact.account_ref_id == term.school_account_ref_id
        and event.fact.role in {"school_credit", "school_charge"}
    }
    steps = receipt["facts"]
    if type(steps) is not list or any(type(step) is not dict or set(step) != _STEP_KEYS for step in steps):
        return _failed("INVALID_RECEIPT")
    received_ids = [step["factId"] for step in steps]
    if any(type(fact_id) is not str for fact_id in received_ids) or received_ids != sorted(set(received_ids)):
        return _failed("INVALID_RECEIPT")
    if set(received_ids) != set(approvals):
        return _failed("MISSING_FACT" if set(approvals) - set(received_ids) else "UNKNOWN_FACT")

    corrections: dict[str, list[Event]] = {}
    for event in snapshot:
        if event.correction is not None:
            corrections.setdefault(event.correction.fact_id, []).append(event)
    total = 0
    manual = False
    for step in steps:
        fact_id = step["factId"]
        approval = approvals[fact_id]
        fact = approval.fact
        if fact is None:
            return _failed("INVALID_REFERENCE")
        latest = _latest_correction(corrections.get(fact_id, []))
        if latest is False:
            return _failed("CONTRADICTORY_EVIDENCE")
        current_amount = fact.amount_minor
        current_source = fact.source
        correction_id: str | None = None
        correction_review_id: str | None = None
        correction_recorded_at: str | None = None
        if latest is not None:
            correction = latest.correction
            if correction is None:
                return _failed("INVALID_REFERENCE")
            current_amount = 0 if correction.cancelled else correction.replacement_amount_minor
            current_source = correction.source
            correction_id = latest.event_id
            correction_review_id = correction.review_id
            correction_recorded_at = latest.recorded_at
        if current_amount is None:
            return _failed("INVALID_REFERENCE")
        if (
            not _source_matches(fact.source, step["originalSourceRef"], case)
            or not _source_matches(current_source, step["sourceRef"], case)
        ):
            return _failed("MISSING_SOURCE")
        if (
            step["approvalEventId"] != approval.event_id
            or step["approvalReviewId"] != fact.review_id
            or step["approvalRecordedAt"] != approval.recorded_at
            or step["correctionEventId"] != correction_id
            or step["correctionReviewId"] != correction_review_id
            or step["correctionRecordedAt"] != correction_recorded_at
            or step["effectiveDate"] != fact.effective_date
        ):
            return _failed("INVALID_REFERENCE")
        original = _minor(step["originalAmountMinor"])
        current = _minor(step["currentAmountMinor"])
        contribution = _minor(step["contributionMinor"])
        expected_contribution = current_amount if fact.role == "school_credit" else -current_amount
        if (
            step["role"] != fact.role
            or original != fact.amount_minor
            or current != current_amount
            or contribution != expected_contribution
        ):
            return _failed("ARITHMETIC_MISMATCH")
        total += expected_contribution
        manual |= fact.source.kind == "manual" or current_source.kind == "manual"

    amount = _minor(receipt["amountMinor"])
    if amount is None or amount != total:
        return _failed("ARITHMETIC_MISMATCH")
    if not approvals:
        return _failed("MISSING_FACT")
    expected_status = "USER_ASSERTED" if manual else "SUPPORTED_BY_UPLOADED_RECORDS"
    limitations = {"NOT_ENTITLEMENT", "SOURCE_SET_MAY_BE_INCOMPLETE", "SOURCE_AUTHENTICITY_NOT_VERIFIED"}
    if manual:
        limitations.add("MANUAL_SOURCE")
    if receipt["status"] != expected_status or receipt["limitations"] != sorted(limitations):
        return _failed("STATUS_MISMATCH")
    return CheckResult(valid=True, code="VALID")
