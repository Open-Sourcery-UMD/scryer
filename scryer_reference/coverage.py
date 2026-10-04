"""Exact account-specific bank statement coverage from reviewed assertions."""

from dataclasses import dataclass

from .model import Case, ModelError, _source_date, snapshot_events

Interval = tuple[str, str]


@dataclass(frozen=True)
class CoverageResult:
    account_ref_id: str
    start_date: str
    end_date_exclusive: str
    status: str
    covered_intervals: tuple[Interval, ...]
    missing_intervals: tuple[Interval, ...]
    assertion_ids: tuple[str, ...]
    limitation_codes: tuple[str, ...]


def _union(intervals: list[Interval]) -> tuple[Interval, ...]:
    merged: list[Interval] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return tuple(merged)


def _missing(start: str, end: str, covered: tuple[Interval, ...]) -> tuple[Interval, ...]:
    gaps: list[Interval] = []
    cursor = start
    for covered_start, covered_end in covered:
        if cursor < covered_start:
            gaps.append((cursor, covered_start))
        cursor = max(cursor, covered_end)
    if cursor < end:
        gaps.append((cursor, end))
    return tuple(gaps)


def evaluate_bank_coverage(
    case: Case,
    heads: tuple[str, ...],
    account_ref_id: str,
    start_date: str,
    end_date_exclusive: str,
) -> CoverageResult:
    """Return covered and missing half-open intervals; observations alone do not cover."""

    account = next((item for item in case.account_refs if item.account_ref_id == account_ref_id), None)
    if account is None:
        raise ModelError("MISSING_ACCOUNT")
    if account.kind != "bank":
        raise ModelError("ACCOUNT_KIND_MISMATCH")
    start = _source_date(start_date)
    end = _source_date(end_date_exclusive)
    if start is None or end is None or start >= end:
        raise ModelError("INVALID_COVERAGE_INTERVAL")

    snapshot = snapshot_events(case, heads)
    retracted = {event.retraction.coverage_id for event in snapshot if event.retraction is not None}
    assertions = [
        event.coverage
        for event in snapshot
        if event.coverage is not None
        and event.coverage.coverage_id not in retracted
        and event.coverage.account_ref_id == account_ref_id
        and event.coverage.record_type == "bank_transactions"
    ]
    clipped = [
        (assertion, (max(start, assertion.start_date), min(end, assertion.end_date_exclusive)))
        for assertion in assertions
    ]
    clipped = [(assertion, interval) for assertion, interval in clipped if interval[0] < interval[1]]
    covered = _union([interval for _, interval in clipped])
    source_covered = _union(
        [interval for assertion, interval in clipped if assertion.basis == "source_asserted"]
    )
    missing = _missing(start, end, covered)
    source_missing = _missing(start, end, source_covered)
    if missing:
        status = "INSUFFICIENT_COVERAGE"
    elif not source_missing:
        status = "SUPPORTED_BY_UPLOADED_RECORDS"
    else:
        status = "USER_ASSERTED"
    limitations = {"SOURCE_AUTHENTICITY_NOT_VERIFIED"}
    if missing:
        limitations.add("COVERAGE_GAP")
    if status == "USER_ASSERTED":
        limitations.add("USER_ASSERTED_COVERAGE")
    return CoverageResult(
        account_ref_id=account_ref_id,
        start_date=start,
        end_date_exclusive=end,
        status=status,
        covered_intervals=covered,
        missing_intervals=missing,
        assertion_ids=tuple(sorted(assertion.coverage_id for assertion, _ in clipped)),
        limitation_codes=tuple(sorted(limitations)),
    )
