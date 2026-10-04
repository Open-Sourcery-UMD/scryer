"""Evidence-only financial-aid lifecycle views; no entitlement inference."""

from dataclasses import dataclass

from .model import Case, Event, ModelError, snapshot_events
from .money import checked_add
from .projection import _current_correction


@dataclass(frozen=True)
class LifecycleObservation:
    fact_id: str
    role: str
    current_amount_minor: int
    source_kind: str
    approval_event_id: str


@dataclass(frozen=True)
class LifecycleResult:
    case_id: str
    heads: tuple[str, ...]
    term_id: str
    aid_item_id: str
    recipient_kind: str
    status: str
    current_offer_minor: int | None
    current_accepted_minor: int | None
    current_pending_minor: int | None
    posted_minor: int | None
    observations: tuple[LifecycleObservation, ...]
    finding_codes: tuple[str, ...]
    next_action_codes: tuple[str, ...]
    limitation_codes: tuple[str, ...]
    gross_disbursed_minor: int | None = None
    withheld_fee_minor: int | None = None
    unexplained_difference_minor: int | None = None


def _snapshot_amount(event: Event, corrections: dict[str, list[Event]]) -> tuple[int, str]:
    fact = event.fact
    if fact is None:
        raise ModelError("INVALID_EVENT_STATE")
    current = _current_correction(corrections.get(fact.fact_id, []))
    if current is None:
        return fact.amount_minor, fact.source.kind
    payload = current.correction
    if payload is None:
        raise ModelError("INVALID_EVENT_STATE")
    amount = 0 if payload.cancelled else payload.replacement_amount_minor
    if amount is None:
        raise ModelError("INVALID_CORRECTION")
    return amount, "manual" if fact.source.kind == "manual" or payload.source.kind == "manual" else "artifact"


def project_aid_lifecycle(
    case: Case,
    heads: tuple[str, ...],
    term_id: str,
    aid_item_id: str,
) -> LifecycleResult:
    """Classify only explicitly linked approved evidence for one aid item and term."""

    term = next((term for term in case.terms if term.term_id == term_id), None)
    if term is None:
        raise ModelError("MISSING_TERM")
    item = next((item for item in case.aid_items if item.aid_item_id == aid_item_id), None)
    if item is None:
        raise ModelError("MISSING_AID_ITEM")
    snapshot = snapshot_events(case, heads)
    sorted_heads = tuple(sorted(heads))
    base_limits = {"NOT_ENTITLEMENT", "SOURCE_AUTHENTICITY_NOT_VERIFIED", "RECIPIENT_USER_RECORDED"}
    if item.term_id is None:
        return LifecycleResult(
            case.case_id, sorted_heads, term_id, aid_item_id, item.recipient_kind,
            "UNSUPPORTED_INPUT", None, None, None, 0, (),
            ("ANNUAL_UNALLOCATED",), ("REVIEW_TERM_ALLOCATION",), tuple(sorted(base_limits)),
        )
    if item.term_id != term_id or item.institution_id != term.institution_id:
        raise ModelError("AID_ITEM_TERM_MISMATCH")

    approvals = [
        event for event in snapshot
        if event.fact is not None and event.fact.aid_item_id == aid_item_id
    ]
    corrections: dict[str, list[Event]] = {}
    for event in snapshot:
        if event.correction is not None:
            corrections.setdefault(event.correction.fact_id, []).append(event)
    observations: list[LifecycleObservation] = []
    try:
        for event in approvals:
            fact = event.fact
            if fact is None:
                raise ModelError("INVALID_EVENT_STATE")
            if fact.currency != case.currency:
                raise ModelError("CURRENCY_MISMATCH")
            amount, source_kind = _snapshot_amount(event, corrections)
            observations.append(LifecycleObservation(fact.fact_id, fact.role, amount, source_kind, event.event_id))
    except ModelError as error:
        if error.code != "UNRESOLVED_CORRECTION_CONFLICT":
            raise
        return LifecycleResult(
            case.case_id, sorted_heads, term_id, aid_item_id, item.recipient_kind,
            "CONTRADICTORY_EVIDENCE", None, None, None, None, (),
            (error.code,), ("RESOLVE_EVIDENCE_CONFLICT",), tuple(sorted(base_limits)),
        )
    observations.sort(key=lambda observation: observation.fact_id)
    by_role: dict[str, list[LifecycleObservation]] = {}
    for observation in observations:
        by_role.setdefault(observation.role, []).append(observation)

    def snapshot_value(role: str) -> int | None:
        entries = by_role.get(role, [])
        active = [entry for entry in entries if entry.current_amount_minor > 0]
        if len(active) == 1:
            return active[0].current_amount_minor
        if entries and not active:
            return 0
        return None

    posted = checked_add(0, sum(item.current_amount_minor for item in by_role.get("school_credit", [])))
    gross = (
        checked_add(0, sum(entry.current_amount_minor for entry in by_role["aid_gross_disbursement"]))
        if by_role.get("aid_gross_disbursement") else None
    )
    fee = (
        checked_add(0, sum(entry.current_amount_minor for entry in by_role["aid_fee_withheld"]))
        if by_role.get("aid_fee_withheld") else None
    )
    unexplained = None
    findings: set[str] = set()
    actions: set[str] = set()
    if gross is not None and by_role.get("school_credit"):
        unexplained = checked_add(checked_add(gross, -(fee or 0)), -posted)
        if fee is None:
            findings.add("FEE_EVIDENCE_MISSING")
        if unexplained != 0:
            findings.add("GROSS_NET_GAP_UNEXPLAINED")
            actions.add("REVIEW_DISBURSEMENT_DETAILS")
    elif fee is not None and gross is None:
        findings.add("GROSS_DISBURSEMENT_NOT_OBSERVED")
        actions.add("REVIEW_DISBURSEMENT_DETAILS")
    for role, code in (("aid_offer", "MULTIPLE_OFFER_SNAPSHOTS"),
                       ("aid_accepted", "MULTIPLE_ACCEPTANCE_SNAPSHOTS"),
                       ("aid_pending", "MULTIPLE_PENDING_SNAPSHOTS")):
        if len([entry for entry in by_role.get(role, []) if entry.current_amount_minor > 0]) > 1:
            findings.add(code)
            actions.add("REVIEW_REVISED_AWARD")
    if (posted > 0 or by_role.get("aid_accepted") or by_role.get("aid_pending")) and not by_role.get("aid_offer"):
        findings.add("OFFER_NOT_OBSERVED")
    if posted > 0 and not by_role.get("aid_accepted"):
        findings.add("ACCEPTANCE_NOT_OBSERVED")
    if by_role.get("work_study_offer"):
        if posted == 0:
            findings.add("WORK_STUDY_NOT_POSTED")
        else:
            findings.add("WORK_STUDY_POSTING_REQUIRES_REVIEW")
            actions.add("REVIEW_POSTING_SOURCE")
    if item.recipient_kind in {"parent", "third_party"}:
        findings.add("NON_STUDENT_RECIPIENT")
        actions.add("VERIFY_RECIPIENT_ACCOUNT")
    elif item.recipient_kind == "unknown":
        findings.add("RECIPIENT_UNKNOWN")
        actions.add("REVIEW_RECIPIENT")
    pending = snapshot_value("aid_pending")
    if pending is not None and pending > 0 and posted == 0:
        findings.add("PENDING_NOT_POSTED")
        actions.add("CHECK_SCHOOL_POSTING")
    if any(code.startswith("MULTIPLE_") for code in findings):
        status = "AMBIGUOUS"
    elif posted > 0:
        status = "USER_ASSERTED" if any(
            entry.role == "school_credit" and entry.source_kind == "manual" for entry in observations
        ) else "SUPPORTED_BY_UPLOADED_RECORDS"
    elif pending is not None and pending > 0:
        status = "PENDING"
    elif observations:
        status = "USER_ASSERTED" if any(entry.source_kind == "manual" for entry in observations) else "OBSERVED"
    else:
        status = "INSUFFICIENT_COVERAGE"
        actions.add("ADD_REVIEWED_EVIDENCE")
    if any(entry.source_kind == "manual" for entry in observations):
        base_limits.add("MANUAL_SOURCE")
    return LifecycleResult(
        case_id=case.case_id,
        heads=sorted_heads,
        term_id=term_id,
        aid_item_id=aid_item_id,
        recipient_kind=item.recipient_kind,
        status=status,
        current_offer_minor=snapshot_value("aid_offer"),
        current_accepted_minor=snapshot_value("aid_accepted"),
        current_pending_minor=pending,
        posted_minor=posted,
        observations=tuple(observations),
        finding_codes=tuple(sorted(findings)),
        next_action_codes=tuple(sorted(actions)),
        limitation_codes=tuple(sorted(base_limits)),
        gross_disbursed_minor=gross,
        withheld_fee_minor=fee,
        unexplained_difference_minor=unexplained,
    )
