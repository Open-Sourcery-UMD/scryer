"""Strict v1 case parsing and deterministic approved-journal snapshots."""

from dataclasses import dataclass
from datetime import date, datetime
import heapq
import json
import re
from typing import Any

from .money import MoneyError, parse_minor_units

_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
_LOCATION = re.compile(r"[!-~]{1,256}\Z")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z")
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
_ROLES = frozenset(
    {
        "school_credit",
        "school_charge",
        "refund_issued",
        "bank_credit_observed",
        "aid_offer",
        "aid_pending",
        "balance_snapshot",
        "work_study_offer",
    }
)
_MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
_MAX_EVENTS = 200_000


class ModelError(ValueError):
    """A stable schema/journal error that does not echo private input."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class SourceRef:
    kind: str
    artifact_id: str | None = None
    location: str | None = None
    entry_id: str | None = None


@dataclass(frozen=True)
class Artifact:
    artifact_id: str
    sha256: str
    kind: str
    observed_at: str
    account_ref_id: str | None


@dataclass(frozen=True)
class Institution:
    institution_id: str


@dataclass(frozen=True)
class AccountRef:
    account_ref_id: str
    kind: str
    institution_id: str | None


@dataclass(frozen=True)
class AcademicTerm:
    term_id: str
    institution_id: str
    school_account_ref_id: str
    start_date: str
    end_date_exclusive: str


@dataclass(frozen=True)
class Proposal:
    proposal_id: str
    artifact_id: str
    source_location: str
    raw_value: str
    parser_version: str
    mapping_version: str
    proposed_amount_minor: int | None


@dataclass(frozen=True)
class Fact:
    fact_id: str
    term_id: str | None
    account_ref_id: str | None
    currency: str
    role: str
    amount_minor: int
    proposal_id: str | None
    effective_date: str | None
    source: SourceRef
    review_id: str


@dataclass(frozen=True)
class Correction:
    fact_id: str
    replacement_amount_minor: int | None
    cancelled: bool
    source: SourceRef
    review_id: str


@dataclass(frozen=True)
class CoverageAssertion:
    coverage_id: str
    account_ref_id: str
    record_type: str
    start_date: str
    end_date_exclusive: str
    basis: str
    source: SourceRef
    review_id: str


@dataclass(frozen=True)
class CoverageRetraction:
    coverage_id: str
    reason: str
    review_id: str


@dataclass(frozen=True)
class MatchDecision:
    refund_fact_id: str
    bank_fact_id: str
    allocated_minor: int
    action: str
    review_id: str


@dataclass(frozen=True)
class Event:
    event_id: str
    parents: tuple[str, ...]
    recorded_at: str
    kind: str
    fact: Fact | None = None
    correction: Correction | None = None
    coverage: CoverageAssertion | None = None
    retraction: CoverageRetraction | None = None
    decision: MatchDecision | None = None


@dataclass(frozen=True)
class Case:
    schema_version: str
    case_id: str
    currency: str
    institutions: tuple[Institution, ...]
    terms: tuple[AcademicTerm, ...]
    account_refs: tuple[AccountRef, ...]
    artifacts: tuple[Artifact, ...]
    proposals: tuple[Proposal, ...]
    events: tuple[Event, ...]

    @property
    def term_ids(self) -> tuple[str, ...]:
        return tuple(term.term_id for term in self.terms)


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ModelError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _fields(value: Any, required: set[str]) -> dict[str, Any]:
    if type(value) is not dict or set(value) != required:
        raise ModelError("INVALID_SCHEMA")
    return value


def _identifier(value: Any) -> str:
    if type(value) is not str or _ID.fullmatch(value) is None:
        raise ModelError("INVALID_ID")
    return value


def _currency(value: Any) -> str:
    if value != "USD" or type(value) is not str:
        raise ModelError("UNSUPPORTED_CURRENCY")
    return value


def _version(value: Any) -> str:
    if type(value) is not str or _VERSION.fullmatch(value) is None:
        raise ModelError("INVALID_VERSION")
    return value


def _location(value: Any) -> str:
    if type(value) is not str or _LOCATION.fullmatch(value) is None:
        raise ModelError("INVALID_SOURCE_LOCATION")
    return value


def _source_date(value: Any) -> str | None:
    if value is None:
        return None
    if type(value) is not str or _DATE.fullmatch(value) is None:
        raise ModelError("INVALID_DATE")
    try:
        date.fromisoformat(value)
    except ValueError as error:
        raise ModelError("INVALID_DATE") from error
    return value


def _utc_instant(value: Any) -> str:
    if type(value) is not str or _UTC.fullmatch(value) is None:
        raise ModelError("INVALID_INSTANT")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ModelError("INVALID_INSTANT") from error
    return value


def _array(value: Any, limit: int = _MAX_EVENTS) -> list[Any]:
    if type(value) is not list or len(value) > limit:
        raise ModelError("INVALID_SCHEMA")
    return value


def _unique_identifiers(values: Any) -> tuple[str, ...]:
    result = tuple(_identifier(value) for value in _array(values))
    if len(result) != len(set(result)):
        raise ModelError("DUPLICATE_ID")
    return result


def _nonnegative_money(value: Any) -> int:
    try:
        amount = parse_minor_units(value)
    except MoneyError as error:
        raise ModelError(error.code) from error
    if amount < 0:
        raise ModelError("INVALID_MONEY")
    return amount


def _source(value: Any, artifact_ids: set[str]) -> SourceRef:
    if type(value) is not dict:
        raise ModelError("INVALID_SCHEMA")
    kind = value.get("kind")
    if kind == "artifact":
        value = _fields(value, {"kind", "artifactId", "location"})
        artifact_id = _identifier(value["artifactId"])
        if artifact_id not in artifact_ids:
            raise ModelError("MISSING_ARTIFACT")
        return SourceRef(kind="artifact", artifact_id=artifact_id, location=_location(value["location"]))
    if kind == "manual":
        value = _fields(value, {"kind", "entryId"})
        return SourceRef(kind="manual", entry_id=_identifier(value["entryId"]))
    raise ModelError("INVALID_SOURCE")


def _institution(value: Any) -> Institution:
    value = _fields(value, {"institutionId"})
    return Institution(institution_id=_identifier(value["institutionId"]))


def _account_ref(value: Any, institution_ids: set[str]) -> AccountRef:
    value = _fields(value, {"accountRefId", "kind", "institutionId"})
    kind = value["kind"]
    institution_id = value["institutionId"]
    if kind == "school":
        institution_id = _identifier(institution_id)
        if institution_id not in institution_ids:
            raise ModelError("MISSING_INSTITUTION")
    elif kind == "bank":
        if institution_id is not None:
            raise ModelError("ACCOUNT_KIND_MISMATCH")
    else:
        raise ModelError("ACCOUNT_KIND_MISMATCH")
    return AccountRef(
        account_ref_id=_identifier(value["accountRefId"]),
        kind=kind,
        institution_id=institution_id,
    )


def _term(value: Any, institution_ids: set[str], account_refs: dict[str, AccountRef]) -> AcademicTerm:
    value = _fields(value, {"termId", "institutionId", "schoolAccountRefId", "startDate", "endDateExclusive"})
    institution_id = _identifier(value["institutionId"])
    if institution_id not in institution_ids:
        raise ModelError("MISSING_INSTITUTION")
    school_account_id = _identifier(value["schoolAccountRefId"])
    account = account_refs.get(school_account_id)
    if account is None:
        raise ModelError("MISSING_ACCOUNT")
    if account.kind != "school" or account.institution_id != institution_id:
        raise ModelError("TERM_ACCOUNT_MISMATCH")
    start = _source_date(value["startDate"])
    end = _source_date(value["endDateExclusive"])
    if start is None or end is None or start >= end:
        raise ModelError("INVALID_TERM_INTERVAL")
    return AcademicTerm(
        term_id=_identifier(value["termId"]),
        institution_id=institution_id,
        school_account_ref_id=school_account_id,
        start_date=start,
        end_date_exclusive=end,
    )


def _artifact(value: Any, account_refs: dict[str, AccountRef]) -> Artifact:
    value = _fields(value, {"artifactId", "sha256", "kind", "observedAt", "accountRefId"})
    sha256 = value["sha256"]
    if type(sha256) is not str or _SHA256.fullmatch(sha256) is None:
        raise ModelError("INVALID_ARTIFACT_HASH")
    account_id = value["accountRefId"]
    if account_id is not None:
        account_id = _identifier(account_id)
        if account_id not in account_refs:
            raise ModelError("MISSING_ACCOUNT")
    return Artifact(
        artifact_id=_identifier(value["artifactId"]),
        sha256=sha256,
        kind=_identifier(value["kind"]),
        observed_at=_utc_instant(value["observedAt"]),
        account_ref_id=account_id,
    )


def _proposal(value: Any, artifact_ids: set[str]) -> Proposal:
    value = _fields(
        value,
        {"proposalId", "artifactId", "sourceLocation", "rawValue", "parserVersion", "mappingVersion", "proposedAmountMinor"},
    )
    artifact_id = _identifier(value["artifactId"])
    if artifact_id not in artifact_ids:
        raise ModelError("MISSING_ARTIFACT")
    raw_value = value["rawValue"]
    if type(raw_value) is not str:
        raise ModelError("INVALID_SCHEMA")
    try:
        decoded_bytes = raw_value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ModelError("INVALID_SCHEMA") from error
    if len(decoded_bytes) > 65536:
        raise ModelError("INVALID_SCHEMA")
    return Proposal(
        proposal_id=_identifier(value["proposalId"]),
        artifact_id=artifact_id,
        source_location=_location(value["sourceLocation"]),
        raw_value=raw_value,
        parser_version=_version(value["parserVersion"]),
        mapping_version=_version(value["mappingVersion"]),
        proposed_amount_minor=(
            None if value["proposedAmountMinor"] is None else _nonnegative_money(value["proposedAmountMinor"])
        ),
    )


def _fact(
    value: Any,
    terms: dict[str, AcademicTerm],
    accounts: dict[str, AccountRef],
    artifacts: dict[str, Artifact],
    proposals: dict[str, Proposal],
) -> Fact:
    value = _fields(
        value,
        {"factId", "termId", "accountRefId", "currency", "role", "amountMinor", "proposalId", "effectiveDate", "source", "reviewId"},
    )
    role = value["role"]
    if type(role) is not str or role not in _ROLES:
        raise ModelError("UNSUPPORTED_ROLE")
    if role == "bank_credit_observed":
        if value["termId"] is not None:
            raise ModelError("INVALID_TERM_BINDING")
        term_id = None
    else:
        term_id = _identifier(value["termId"])
        if term_id not in terms:
            raise ModelError("MISSING_TERM")
    account_id = value["accountRefId"]
    account = None
    if account_id is not None:
        account_id = _identifier(account_id)
        account = accounts.get(account_id)
        if account is None:
            raise ModelError("MISSING_ACCOUNT")
    if role == "bank_credit_observed":
        if account is None or account.kind != "bank":
            raise ModelError("ACCOUNT_KIND_MISMATCH")
    elif role in {"school_credit", "school_charge", "refund_issued", "balance_snapshot"}:
        if account is None or account.kind != "school":
            raise ModelError("ACCOUNT_KIND_MISMATCH")
        if account_id != terms[term_id].school_account_ref_id:
            raise ModelError("TERM_ACCOUNT_MISMATCH")
    elif account is not None:
        if account.kind != "school" or account_id != terms[term_id].school_account_ref_id:
            raise ModelError("TERM_ACCOUNT_MISMATCH")
    source = _source(value["source"], set(artifacts))
    if source.artifact_id is not None:
        artifact_account_id = artifacts[source.artifact_id].account_ref_id
        if artifact_account_id is not None and artifact_account_id != account_id:
            raise ModelError("SOURCE_ACCOUNT_MISMATCH")
    proposal_id = value["proposalId"]
    if proposal_id is not None:
        proposal_id = _identifier(proposal_id)
        proposal = proposals.get(proposal_id)
        if proposal is None:
            raise ModelError("MISSING_PROPOSAL")
        if (
            source.kind != "artifact"
            or source.artifact_id != proposal.artifact_id
            or source.location != proposal.source_location
        ):
            raise ModelError("SOURCE_PROPOSAL_MISMATCH")
    return Fact(
        fact_id=_identifier(value["factId"]),
        term_id=term_id,
        account_ref_id=account_id,
        currency=_currency(value["currency"]),
        role=role,
        amount_minor=_nonnegative_money(value["amountMinor"]),
        proposal_id=proposal_id,
        effective_date=_source_date(value["effectiveDate"]),
        source=source,
        review_id=_identifier(value["reviewId"]),
    )


def _correction(value: Any, artifact_ids: set[str]) -> Correction:
    value = _fields(value, {"factId", "replacementAmountMinor", "cancelled", "source", "reviewId"})
    cancelled = value["cancelled"]
    if type(cancelled) is not bool:
        raise ModelError("INVALID_SCHEMA")
    replacement = value["replacementAmountMinor"]
    if cancelled == (replacement is not None):
        raise ModelError("INVALID_CORRECTION")
    return Correction(
        fact_id=_identifier(value["factId"]),
        replacement_amount_minor=None if cancelled else _nonnegative_money(replacement),
        cancelled=cancelled,
        source=_source(value["source"], artifact_ids),
        review_id=_identifier(value["reviewId"]),
    )


def _coverage(value: Any, accounts: dict[str, AccountRef], artifacts: dict[str, Artifact]) -> CoverageAssertion:
    value = _fields(
        value,
        {"coverageId", "accountRefId", "recordType", "startDate", "endDateExclusive", "basis", "source", "reviewId"},
    )
    account_id = _identifier(value["accountRefId"])
    account = accounts.get(account_id)
    if account is None:
        raise ModelError("MISSING_ACCOUNT")
    if account.kind != "bank":
        raise ModelError("ACCOUNT_KIND_MISMATCH")
    if value["recordType"] != "bank_transactions":
        raise ModelError("UNSUPPORTED_COVERAGE_TYPE")
    start = _source_date(value["startDate"])
    end = _source_date(value["endDateExclusive"])
    if start is None or end is None or start >= end:
        raise ModelError("INVALID_COVERAGE_INTERVAL")
    basis = value["basis"]
    if type(basis) is not str or basis not in {"source_asserted", "user_asserted"}:
        raise ModelError("INVALID_COVERAGE_BASIS")
    source = _source(value["source"], set(artifacts))
    if basis == "source_asserted":
        if source.artifact_id is None or artifacts[source.artifact_id].kind != "bank_statement":
            raise ModelError("INVALID_COVERAGE_SOURCE")
        if artifacts[source.artifact_id].account_ref_id != account_id:
            raise ModelError("SOURCE_ACCOUNT_MISMATCH")
        if artifacts[source.artifact_id].observed_at[:10] < end:
            raise ModelError("INVALID_COVERAGE_CHRONOLOGY")
    elif source.kind != "manual":
        raise ModelError("INVALID_COVERAGE_SOURCE")
    return CoverageAssertion(
        coverage_id=_identifier(value["coverageId"]),
        account_ref_id=account_id,
        record_type="bank_transactions",
        start_date=start,
        end_date_exclusive=end,
        basis=basis,
        source=source,
        review_id=_identifier(value["reviewId"]),
    )


def _retraction(value: Any) -> CoverageRetraction:
    value = _fields(value, {"coverageId", "reason", "reviewId"})
    reason = value["reason"]
    if type(reason) is not str or reason not in {"incorrect_period", "wrong_account", "source_invalid", "other"}:
        raise ModelError("INVALID_RETRACTION_REASON")
    return CoverageRetraction(
        coverage_id=_identifier(value["coverageId"]),
        reason=reason,
        review_id=_identifier(value["reviewId"]),
    )


def _match_decision(value: Any) -> MatchDecision:
    value = _fields(value, {"refundFactId", "bankFactId", "allocatedMinor", "action", "reviewId"})
    action = value["action"]
    if type(action) is not str or action not in {"confirm", "reject"}:
        raise ModelError("INVALID_MATCH_ACTION")
    amount = _nonnegative_money(value["allocatedMinor"])
    if (action == "confirm" and amount == 0) or (action == "reject" and amount != 0):
        raise ModelError("INVALID_MATCH_ALLOCATION")
    return MatchDecision(
        refund_fact_id=_identifier(value["refundFactId"]),
        bank_fact_id=_identifier(value["bankFactId"]),
        allocated_minor=amount,
        action=action,
        review_id=_identifier(value["reviewId"]),
    )


def _event(
    value: Any,
    terms: dict[str, AcademicTerm],
    accounts: dict[str, AccountRef],
    artifacts: dict[str, Artifact],
    proposals: dict[str, Proposal],
) -> Event:
    if type(value) is not dict:
        raise ModelError("INVALID_SCHEMA")
    kind = value.get("kind")
    common = {"eventId", "parents", "recordedAt", "kind"}
    if kind == "approve_fact":
        value = _fields(value, common | {"fact"})
        fact = _fact(value["fact"], terms, accounts, artifacts, proposals)
        correction = None
        coverage = None
        retraction = None
        decision = None
    elif kind == "correct_fact":
        value = _fields(value, common | {"correction"})
        fact = None
        correction = _correction(value["correction"], set(artifacts))
        coverage = None
        retraction = None
        decision = None
    elif kind == "assert_coverage":
        value = _fields(value, common | {"coverage"})
        fact = None
        correction = None
        coverage = _coverage(value["coverage"], accounts, artifacts)
        retraction = None
        decision = None
    elif kind == "retract_coverage":
        value = _fields(value, common | {"retraction"})
        fact = None
        correction = None
        coverage = None
        retraction = _retraction(value["retraction"])
        decision = None
    elif kind == "decide_match":
        value = _fields(value, common | {"decision"})
        fact = None
        correction = None
        coverage = None
        retraction = None
        decision = _match_decision(value["decision"])
    else:
        raise ModelError("UNSUPPORTED_EVENT")
    return Event(
        event_id=_identifier(value["eventId"]),
        parents=_unique_identifiers(value["parents"]),
        recorded_at=_utc_instant(value["recordedAt"]),
        kind=kind,
        fact=fact,
        correction=correction,
        coverage=coverage,
        retraction=retraction,
        decision=decision,
    )


def _ordered_events(events: tuple[Event, ...]) -> tuple[Event, ...]:
    by_id = {event.event_id: event for event in events}
    if len(by_id) != len(events):
        raise ModelError("DUPLICATE_EVENT_ID")
    indegree = {event.event_id: len(event.parents) for event in events}
    children: dict[str, list[str]] = {event.event_id: [] for event in events}
    for event in events:
        for parent_id in event.parents:
            if parent_id not in by_id:
                raise ModelError("MISSING_PARENT")
            children[parent_id].append(event.event_id)
    ready = [event_id for event_id, count in indegree.items() if count == 0]
    heapq.heapify(ready)
    ordered: list[Event] = []
    while ready:
        event_id = heapq.heappop(ready)
        ordered.append(by_id[event_id])
        for child_id in children[event_id]:
            indegree[child_id] -= 1
            if indegree[child_id] == 0:
                heapq.heappush(ready, child_id)
    if len(ordered) != len(events):
        raise ModelError("EVENT_CYCLE")
    return tuple(ordered)


def load_case_json(document: str) -> Case:
    """Parse and fully validate the strict v1 case contract."""

    if type(document) is not str:
        raise ModelError("INVALID_JSON")
    try:
        document_size = len(document.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise ModelError("INVALID_JSON") from error
    if document_size > _MAX_DOCUMENT_BYTES:
        raise ModelError("INPUT_TOO_LARGE")
    try:
        raw = json.loads(document, object_pairs_hook=_unique_pairs)
    except ModelError:
        raise
    except (ValueError, RecursionError) as error:
        raise ModelError("INVALID_JSON") from error
    raw = _fields(
        raw,
        {"schemaVersion", "caseId", "currency", "institutions", "accountRefs", "terms", "artifacts", "proposals", "events"},
    )
    if raw["schemaVersion"] != "1":
        raise ModelError("UNSUPPORTED_VERSION")
    currency = _currency(raw["currency"])
    institutions = tuple(_institution(value) for value in _array(raw["institutions"]))
    institution_ids = {institution.institution_id for institution in institutions}
    if len(institution_ids) != len(institutions):
        raise ModelError("DUPLICATE_INSTITUTION_ID")
    accounts = tuple(_account_ref(value, institution_ids) for value in _array(raw["accountRefs"]))
    accounts_by_id = {account.account_ref_id: account for account in accounts}
    if len(accounts_by_id) != len(accounts):
        raise ModelError("DUPLICATE_ACCOUNT_ID")
    terms = tuple(_term(value, institution_ids, accounts_by_id) for value in _array(raw["terms"]))
    terms_by_id = {term.term_id: term for term in terms}
    if len(terms_by_id) != len(terms):
        raise ModelError("DUPLICATE_TERM_ID")
    artifacts = tuple(_artifact(value, accounts_by_id) for value in _array(raw["artifacts"]))
    artifacts_by_id = {artifact.artifact_id: artifact for artifact in artifacts}
    if len(artifacts_by_id) != len(artifacts):
        raise ModelError("DUPLICATE_ARTIFACT_ID")
    proposals = tuple(_proposal(value, set(artifacts_by_id)) for value in _array(raw["proposals"]))
    proposals_by_id = {proposal.proposal_id: proposal for proposal in proposals}
    if len(proposals_by_id) != len(proposals):
        raise ModelError("DUPLICATE_PROPOSAL_ID")
    events = tuple(
        _event(value, terms_by_id, accounts_by_id, artifacts_by_id, proposals_by_id)
        for value in _array(raw["events"])
    )
    ordered = _ordered_events(events)
    fact_approvals = {event.fact.fact_id: event.event_id for event in ordered if event.fact is not None}
    facts_by_id = {event.fact.fact_id: event.fact for event in ordered if event.fact is not None}
    if sum(event.fact is not None for event in ordered) != len(fact_approvals):
        raise ModelError("DUPLICATE_FACT_ID")
    approved_proposals = [
        event.fact.proposal_id for event in ordered
        if event.fact is not None and event.fact.proposal_id is not None
    ]
    if len(approved_proposals) != len(set(approved_proposals)):
        raise ModelError("DUPLICATE_PROPOSAL_APPROVAL")
    coverage_approvals = {event.coverage.coverage_id: event.event_id for event in ordered if event.coverage is not None}
    if sum(event.coverage is not None for event in ordered) != len(coverage_approvals):
        raise ModelError("DUPLICATE_COVERAGE_ID")
    reviews = [
        event.fact.review_id if event.fact is not None else
        event.correction.review_id if event.correction is not None else
        event.coverage.review_id if event.coverage is not None else
        event.retraction.review_id if event.retraction is not None else
        event.decision.review_id
        for event in ordered
    ]
    if len(reviews) != len(set(reviews)):
        raise ModelError("DUPLICATE_REVIEW_ID")
    for event in ordered:
        if event.correction is not None:
            approval_id = fact_approvals.get(event.correction.fact_id)
            if approval_id is None or approval_id not in event.parents:
                raise ModelError("INVALID_CORRECTION_CAUSALITY")
            source = event.correction.source
            if source.artifact_id is not None:
                artifact_account_id = artifacts_by_id[source.artifact_id].account_ref_id
                if (
                    artifact_account_id is not None
                    and artifact_account_id != facts_by_id[event.correction.fact_id].account_ref_id
                ):
                    raise ModelError("SOURCE_ACCOUNT_MISMATCH")
        if event.retraction is not None:
            approval_id = coverage_approvals.get(event.retraction.coverage_id)
            if approval_id is None or approval_id not in event.parents:
                raise ModelError("INVALID_RETRACTION_CAUSALITY")
        if event.decision is not None:
            decision = event.decision
            refund = facts_by_id.get(decision.refund_fact_id)
            bank = facts_by_id.get(decision.bank_fact_id)
            if refund is None or bank is None:
                raise ModelError("MISSING_FACT")
            if refund.role != "refund_issued" or bank.role != "bank_credit_observed":
                raise ModelError("MATCH_ROLE_MISMATCH")
            if (
                fact_approvals[decision.refund_fact_id] not in event.parents
                or fact_approvals[decision.bank_fact_id] not in event.parents
            ):
                raise ModelError("INVALID_MATCH_CAUSALITY")
    return Case(
        schema_version="1",
        case_id=_identifier(raw["caseId"]),
        currency=currency,
        institutions=tuple(sorted(institutions, key=lambda institution: institution.institution_id)),
        terms=tuple(sorted(terms, key=lambda term: term.term_id)),
        account_refs=tuple(sorted(accounts, key=lambda account: account.account_ref_id)),
        artifacts=tuple(sorted(artifacts, key=lambda artifact: artifact.artifact_id)),
        proposals=tuple(sorted(proposals, key=lambda proposal: proposal.proposal_id)),
        events=ordered,
    )


def snapshot_events(case: Case, heads: tuple[str, ...]) -> tuple[Event, ...]:
    """Return the approved ancestor closure of explicit heads in stable causal order."""

    by_id = {event.event_id: event for event in case.events}
    if type(heads) is not tuple or any(type(head) is not str for head in heads):
        raise ModelError("INVALID_HEADS")
    if len(heads) != len(set(heads)):
        raise ModelError("INVALID_HEADS")
    if any(head not in by_id for head in heads):
        raise ModelError("UNKNOWN_HEAD")
    reached: set[str] = set()
    stack = list(heads)
    while stack:
        event_id = stack.pop()
        if event_id not in reached:
            reached.add(event_id)
            stack.extend(by_id[event_id].parents)
    return tuple(event for event in case.events if event.event_id in reached)
