"""Independent source-based school-surplus reference projection."""

from dataclasses import dataclass

from .model import Case, Event, Fact, ModelError, snapshot_events
from .money import checked_add

_POSTED_ROLES = frozenset({"school_credit", "school_charge"})


@dataclass(frozen=True)
class Projection:
    case_id: str
    heads: tuple[str, ...]
    term_id: str
    currency: str
    status: str
    amount_minor: int | None
    fact_ids: tuple[str, ...]
    limitation_codes: tuple[str, ...]


@dataclass(frozen=True)
class Contribution:
    fact_id: str
    before_minor: int
    after_minor: int
    delta_minor: int


@dataclass(frozen=True)
class Comparison:
    status: str
    before: Projection
    after: Projection
    delta_minor: int | None
    contributions: tuple[Contribution, ...]
    limitation_codes: tuple[str, ...]


@dataclass(frozen=True)
class _Evaluation:
    projection: Projection
    contributions: dict[str, int]


def _current_correction(events: list[Event]) -> Event | None:
    if not events:
        return None
    correction_ids = {event.event_id for event in events}
    superseded = {
        parent_id
        for event in events
        for parent_id in event.parents
        if parent_id in correction_ids
    }
    current = [event for event in events if event.event_id not in superseded]
    if len(current) != 1:
        raise ModelError("UNRESOLVED_CORRECTION_CONFLICT")
    return current[0]


def _evaluate(case: Case, heads: tuple[str, ...], term_id: str) -> _Evaluation:
    term = next((item for item in case.terms if item.term_id == term_id), None)
    if term is None:
        raise ModelError("MISSING_TERM")
    events = snapshot_events(case, heads)
    facts: dict[str, Fact] = {}
    corrections: dict[str, list[Event]] = {}
    for event in events:
        if event.fact is not None:
            facts[event.fact.fact_id] = event.fact
        elif event.correction is not None:
            corrections.setdefault(event.correction.fact_id, []).append(event)
    if any(fact.currency != case.currency for fact in facts.values()):
        raise ModelError("CURRENCY_MISMATCH")

    contribution_map: dict[str, int] = {}
    manually_asserted = False
    posted_fact_ids = tuple(
        sorted(
            fact_id
            for fact_id, fact in facts.items()
            if fact.term_id == term_id
            and fact.account_ref_id == term.school_account_ref_id
            and fact.role in _POSTED_ROLES
        )
    )
    for fact_id in posted_fact_ids:
        fact = facts[fact_id]
        try:
            correction = _current_correction(corrections.get(fact_id, []))
        except ModelError as error:
            if error.code != "UNRESOLVED_CORRECTION_CONFLICT":
                raise
            return _Evaluation(
                projection=Projection(
                    case_id=case.case_id,
                    heads=tuple(sorted(heads)),
                    term_id=term_id,
                    currency=case.currency,
                    status="CONTRADICTORY_EVIDENCE",
                    amount_minor=None,
                    fact_ids=posted_fact_ids,
                    limitation_codes=("NOT_ENTITLEMENT", "UNRESOLVED_CORRECTION_CONFLICT"),
                ),
                contributions={},
            )
        amount = fact.amount_minor
        source = fact.source
        if correction is not None:
            payload = correction.correction
            if payload is None:
                raise ModelError("INVALID_EVENT_STATE")
            amount = 0 if payload.cancelled else payload.replacement_amount_minor
            source = payload.source
        if amount is None:
            raise ModelError("INVALID_CORRECTION")
        contribution_map[fact_id] = amount if fact.role == "school_credit" else -amount
        manually_asserted |= fact.source.kind == "manual" or source.kind == "manual"

    if not contribution_map:
        return _Evaluation(
            projection=Projection(
                case_id=case.case_id,
                heads=tuple(sorted(heads)),
                term_id=term_id,
                currency=case.currency,
                status="INSUFFICIENT_COVERAGE",
                amount_minor=None,
                fact_ids=(),
                limitation_codes=("NO_POSTED_SCHOOL_MOVEMENTS", "NOT_ENTITLEMENT"),
            ),
            contributions={},
        )

    total = 0
    for fact_id in sorted(contribution_map):
        total = checked_add(total, contribution_map[fact_id])
    limitations = {"NOT_ENTITLEMENT", "SOURCE_SET_MAY_BE_INCOMPLETE"}
    if manually_asserted:
        limitations.add("MANUAL_SOURCE")
    return _Evaluation(
        projection=Projection(
            case_id=case.case_id,
            heads=tuple(sorted(heads)),
            term_id=term_id,
            currency=case.currency,
            status="USER_ASSERTED" if manually_asserted else "SUPPORTED_BY_UPLOADED_RECORDS",
            amount_minor=total,
            fact_ids=tuple(sorted(contribution_map)),
            limitation_codes=tuple(sorted(limitations)),
        ),
        contributions=contribution_map,
    )


def project_school_surplus(case: Case, heads: tuple[str, ...], term_id: str) -> Projection:
    """Compute a school-account evidence total, not an expected or owed refund."""

    return _evaluate(case, heads, term_id).projection


def compare_school_surplus(
    case: Case,
    before_heads: tuple[str, ...],
    after_heads: tuple[str, ...],
    term_id: str,
) -> Comparison:
    """Explain a source-based school-surplus delta by exact current fact effects."""

    before = _evaluate(case, before_heads, term_id)
    after = _evaluate(case, after_heads, term_id)
    if before.projection.amount_minor is None or after.projection.amount_minor is None:
        status = (
            "CONTRADICTORY_EVIDENCE"
            if "CONTRADICTORY_EVIDENCE" in {before.projection.status, after.projection.status}
            else "INSUFFICIENT_COVERAGE"
        )
        return Comparison(
            status=status,
            before=before.projection,
            after=after.projection,
            delta_minor=None,
            contributions=(),
            limitation_codes=tuple(sorted(set(before.projection.limitation_codes + after.projection.limitation_codes))),
        )

    delta = checked_add(0, after.projection.amount_minor - before.projection.amount_minor)
    contributions = tuple(
        Contribution(
            fact_id=fact_id,
            before_minor=before.contributions.get(fact_id, 0),
            after_minor=after.contributions.get(fact_id, 0),
            delta_minor=checked_add(
                0, after.contributions.get(fact_id, 0) - before.contributions.get(fact_id, 0)
            ),
        )
        for fact_id in sorted(before.contributions.keys() | after.contributions.keys())
        if before.contributions.get(fact_id, 0) != after.contributions.get(fact_id, 0)
    )
    attribution_total = 0
    for item in contributions:
        attribution_total = checked_add(attribution_total, item.delta_minor)
    if attribution_total != delta:
        raise ModelError("ATTRIBUTION_INCOMPLETE")
    status = (
        "USER_ASSERTED"
        if "USER_ASSERTED" in {before.projection.status, after.projection.status}
        else "SUPPORTED_BY_UPLOADED_RECORDS"
    )
    return Comparison(
        status=status,
        before=before.projection,
        after=after.projection,
        delta_minor=delta,
        contributions=contributions,
        limitation_codes=tuple(sorted(set(before.projection.limitation_codes + after.projection.limitation_codes))),
    )
