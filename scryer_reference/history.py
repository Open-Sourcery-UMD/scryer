"""Explicit UTC-cutoff mapping to approved causal journal heads."""

from dataclasses import dataclass

from .model import Case, _utc_instant


@dataclass(frozen=True)
class KnowledgeSelection:
    cutoff_utc: str
    status: str
    heads: tuple[str, ...]
    reason_codes: tuple[str, ...]


def heads_as_known(case: Case, cutoff_utc: str) -> KnowledgeSelection:
    """Map one case's recorded UTC instants to heads without resolving branches by time."""

    cutoff = _utc_instant(cutoff_utc)
    by_id = {event.event_id: event for event in case.events}
    eligible: set[str] = set()
    inversion_at_cutoff = False
    for event in case.events:
        if event.recorded_at <= cutoff:
            if all(parent in eligible for parent in event.parents):
                eligible.add(event.event_id)
            if any(by_id[parent].recorded_at > cutoff for parent in event.parents):
                inversion_at_cutoff = True
    non_heads = {
        parent
        for event in case.events if event.event_id in eligible
        for parent in event.parents if parent in eligible
    }
    heads = tuple(sorted(eligible - non_heads))
    reasons: set[str] = set()
    if inversion_at_cutoff:
        reasons.add("CAUSAL_TIME_INVERSION")
    if len(heads) > 1:
        reasons.add("DIVERGENT_HEADS")
    if reasons:
        status = "AMBIGUOUS"
    elif heads:
        status = "UNIQUE"
    else:
        status = "EMPTY"
    return KnowledgeSelection(cutoff, status, heads, tuple(sorted(reasons)))
