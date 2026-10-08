"""Conservative refund/deposit suggestions and reviewed exact allocations."""

from dataclasses import dataclass
from datetime import date, timedelta

from .coverage import CoverageResult, evaluate_bank_coverage
from .model import Case, Event, Fact, ModelError, snapshot_events
from .projection import _current_correction


@dataclass(frozen=True)
class Allocation:
    bank_fact_id: str
    bank_account_ref_id: str
    allocated_minor: int
    decision_event_id: str


@dataclass(frozen=True)
class MatchResult:
    refund_fact_id: str
    bank_account_ref_id: str
    currency: str
    status: str
    refund_amount_minor: int | None
    candidate_fact_ids: tuple[str, ...]
    confirmed_allocations: tuple[Allocation, ...]
    remaining_minor: int | None
    coverage: CoverageResult | None
    reason_codes: tuple[str, ...]


def _current_amount(fact: Fact, corrections: dict[str, list[Event]]) -> int:
    correction = _current_correction(corrections.get(fact.fact_id, []))
    if correction is None:
        return fact.amount_minor
    payload = correction.correction
    if payload is None:
        raise ModelError("INVALID_EVENT_STATE")
    amount = 0 if payload.cancelled else payload.replacement_amount_minor
    if amount is None:
        raise ModelError("INVALID_CORRECTION")
    return amount


def _current_decision(events: list[Event]) -> Event:
    ids = {event.event_id for event in events}
    superseded = {parent for event in events for parent in event.parents if parent in ids}
    current = [event for event in events if event.event_id not in superseded]
    if len(current) != 1:
        raise ModelError("CONFLICTING_MATCH_DECISIONS")
    return current[0]


def _result(
    refund_id: str,
    account_id: str,
    status: str,
    amount: int | None,
    candidates: tuple[str, ...] = (),
    allocations: tuple[Allocation, ...] = (),
    remaining: int | None = None,
    coverage: CoverageResult | None = None,
    reasons: set[str] | None = None,
) -> MatchResult:
    return MatchResult(
        refund_fact_id=refund_id,
        bank_account_ref_id=account_id,
        currency="USD",
        status=status,
        refund_amount_minor=amount,
        candidate_fact_ids=candidates,
        confirmed_allocations=allocations,
        remaining_minor=remaining,
        coverage=coverage,
        reason_codes=tuple(sorted(reasons or ())),
    )


def suggest_refund_deposits(
    case: Case,
    heads: tuple[str, ...],
    refund_fact_id: str,
    bank_account_ref_id: str,
    candidate_limit: int = 1000,
    window_days: int = 30,
) -> MatchResult:
    """Suggest account-specific candidates; only reviewed decisions confirm allocations."""

    if type(candidate_limit) is not int or not 1 <= candidate_limit <= 10_000:
        raise ModelError("INVALID_CANDIDATE_LIMIT")
    if type(window_days) is not int or not 0 <= window_days <= 90:
        raise ModelError("INVALID_MATCH_WINDOW")
    account = next((item for item in case.account_refs if item.account_ref_id == bank_account_ref_id), None)
    if account is None:
        raise ModelError("MISSING_ACCOUNT")
    if account.kind != "bank":
        raise ModelError("ACCOUNT_KIND_MISMATCH")

    snapshot = snapshot_events(case, heads)
    approvals = {event.fact.fact_id: event.fact for event in snapshot if event.fact is not None}
    if any(fact.currency != case.currency for fact in approvals.values()):
        raise ModelError("CURRENCY_MISMATCH")
    refund = approvals.get(refund_fact_id)
    if refund is None:
        raise ModelError("MISSING_FACT_IN_SNAPSHOT")
    if refund.role != "refund_issued":
        raise ModelError("MATCH_ROLE_MISMATCH")
    bank_facts = {
        fact_id: fact
        for fact_id, fact in approvals.items()
        if fact.role == "bank_credit_observed"
    }
    corrections: dict[str, list[Event]] = {}
    decisions: dict[tuple[str, str], list[Event]] = {}
    for event in snapshot:
        if event.correction is not None:
            corrections.setdefault(event.correction.fact_id, []).append(event)
        if event.decision is not None:
            pair = (event.decision.refund_fact_id, event.decision.bank_fact_id)
            decisions.setdefault(pair, []).append(event)

    reasons = {"SOURCE_AUTHENTICITY_NOT_VERIFIED", "RECIPIENT_METADATA_USER_REVIEWED"}
    recipient_known = refund.recipient_kind != "unknown" and account.holder_kind != "unknown"
    recipient_matches = recipient_known and refund.recipient_kind == account.holder_kind
    if not recipient_known:
        reasons.add("RECIPIENT_IDENTITY_UNKNOWN")
    elif not recipient_matches:
        reasons.add("RECIPIENT_MISMATCH")
    try:
        refund_amount = _current_amount(refund, corrections)
    except ModelError as error:
        if error.code == "UNRESOLVED_CORRECTION_CONFLICT":
            return _result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", None,
                           reasons=reasons | {error.code})
        raise

    active: dict[tuple[str, str], Event] = {}
    for pair, events in decisions.items():
        bank = bank_facts.get(pair[1])
        relevant = pair[0] == refund_fact_id or (bank is not None and bank.account_ref_id == bank_account_ref_id)
        if not relevant:
            continue
        try:
            active[pair] = _current_decision(events)
        except ModelError as error:
            return _result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount,
                           reasons=reasons | {error.code})

    allocated_by_bank: dict[str, int] = {}
    allocated_by_refund: dict[str, int] = {}
    own_allocations: list[Allocation] = []
    for (refund_id, bank_id), event in active.items():
        decision = event.decision
        if decision is None or decision.action != "confirm":
            continue
        allocated_by_bank[bank_id] = allocated_by_bank.get(bank_id, 0) + decision.allocated_minor
        allocated_by_refund[refund_id] = allocated_by_refund.get(refund_id, 0) + decision.allocated_minor
        if refund_id == refund_fact_id:
            bank = bank_facts[bank_id]
            if bank.account_ref_id == bank_account_ref_id:
                own_allocations.append(
                    Allocation(bank_id, bank.account_ref_id, decision.allocated_minor, event.event_id)
                )
                if decision.recipient_evidence is not None:
                    reasons.add("RECIPIENT_EXCEPTION_SOURCE_REVIEWED")

    for bank_id, allocated in allocated_by_bank.items():
        try:
            bank_amount = _current_amount(bank_facts[bank_id], corrections)
        except ModelError as error:
            if error.code == "UNRESOLVED_CORRECTION_CONFLICT":
                return _result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount,
                               reasons=reasons | {error.code})
            raise
        if allocated > bank_amount:
            return _result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount,
                           reasons=reasons | {"BANK_OVERALLOCATED"})
    for other_refund_id, allocated in allocated_by_refund.items():
        try:
            other_amount = refund_amount if other_refund_id == refund_fact_id else _current_amount(
                approvals[other_refund_id], corrections
            )
        except ModelError as error:
            if error.code == "UNRESOLVED_CORRECTION_CONFLICT":
                return _result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount,
                               reasons=reasons | {error.code})
            raise
        if allocated > other_amount:
            return _result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount,
                           reasons=reasons | {"REFUND_OVERALLOCATED"})

    remaining = refund_amount - allocated_by_refund.get(refund_fact_id, 0)
    own_allocations.sort(key=lambda item: (item.bank_fact_id, item.decision_event_id))
    allocations = tuple(own_allocations)
    if refund_amount == 0:
        return _result(refund_fact_id, bank_account_ref_id, "REFUND_CANCELLED", 0,
                       allocations=allocations, remaining=0, reasons=reasons)

    coverage: CoverageResult | None = None
    window_start: str | None = refund.effective_date
    window_end: str | None = None
    if window_start is None:
        reasons.add("MISSING_REFUND_DATE")
    else:
        try:
            window_end = (date.fromisoformat(window_start) + timedelta(days=window_days + 1)).isoformat()
        except OverflowError as error:
            raise ModelError("UNSUPPORTED_DATE_RANGE") from error
        coverage = evaluate_bank_coverage(case, heads, bank_account_ref_id, window_start, window_end)
        reasons.add("HEURISTIC_DATE_WINDOW")
        if coverage.status == "INSUFFICIENT_COVERAGE":
            reasons.add("COVERAGE_GAP")
        elif coverage.status == "USER_ASSERTED":
            reasons.add("USER_ASSERTED_COVERAGE")

    for allocation in allocations:
        bank = bank_facts[allocation.bank_fact_id]
        if bank.source.kind == "manual":
            reasons.add("MANUAL_BANK_OBSERVATION")
        if window_start is None or window_end is None:
            reasons.add("CONFIRMED_WITHOUT_REFUND_DATE")
        elif bank.effective_date is None or not window_start <= bank.effective_date < window_end:
            reasons.add("CONFIRMED_OUTSIDE_SEARCH_WINDOW")

    if remaining == 0:
        if not allocations:
            reasons.add("REFUND_ALLOCATED_TO_OTHER_ACCOUNT")
            return _result(refund_fact_id, bank_account_ref_id, "MATCHED_ON_OTHER_ACCOUNT_BY_REVIEW", refund_amount,
                           remaining=0, coverage=coverage, reasons=reasons)
        return _result(refund_fact_id, bank_account_ref_id, "MATCHED_BY_REVIEW", refund_amount,
                       allocations=allocations, remaining=0, coverage=coverage, reasons=reasons)

    if not recipient_matches:
        status = "PARTIALLY_MATCHED_BY_REVIEW" if allocations else "INSUFFICIENT_COVERAGE"
        return _result(refund_fact_id, bank_account_ref_id, status, refund_amount,
                       allocations=allocations, remaining=remaining, coverage=coverage, reasons=reasons)

    candidates: list[Fact] = []
    if window_start is not None and window_end is not None:
        for bank in bank_facts.values():
            if bank.account_ref_id != bank_account_ref_id or bank.effective_date is None:
                continue
            if not window_start <= bank.effective_date < window_end:
                continue
            current = active.get((refund_fact_id, bank.fact_id))
            if current is not None:
                continue
            try:
                bank_amount = _current_amount(bank, corrections)
            except ModelError as error:
                if error.code == "UNRESOLVED_CORRECTION_CONFLICT":
                    return _result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount,
                                   allocations=allocations, remaining=remaining, coverage=coverage,
                                   reasons=reasons | {error.code})
                raise
            if bank_amount - allocated_by_bank.get(bank.fact_id, 0) > 0:
                candidates.append(bank)
                if bank.source.kind == "manual":
                    reasons.add("MANUAL_BANK_OBSERVATION")
                if len(candidates) > candidate_limit:
                    return _result(refund_fact_id, bank_account_ref_id, "COMPUTATION_LIMIT", refund_amount,
                                   allocations=allocations, remaining=remaining, coverage=coverage,
                                   reasons=reasons | {"CANDIDATE_LIMIT_EXCEEDED"})
    candidates.sort(key=lambda fact: (fact.effective_date, fact.fact_id))
    candidate_ids = tuple(fact.fact_id for fact in candidates)
    if allocations:
        status = "PARTIALLY_MATCHED_BY_REVIEW"
    elif len(candidates) > 1:
        status = "AMBIGUOUS"
    elif candidates:
        status = "SUGGESTED"
    elif coverage is not None and coverage.status == "SUPPORTED_BY_UPLOADED_RECORDS":
        status = "NO_CANDIDATE_IN_APPROVED_FACTS"
        reasons.add("NOT_PROOF_OF_NONPAYMENT")
        reasons.add("SOURCE_SET_MAY_BE_INCOMPLETE")
    else:
        status = "INSUFFICIENT_COVERAGE"
    return _result(refund_fact_id, bank_account_ref_id, status, refund_amount,
                   candidates=candidate_ids, allocations=allocations, remaining=remaining,
                   coverage=coverage, reasons=reasons)
