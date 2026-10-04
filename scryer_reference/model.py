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


@dataclass(frozen=True)
class Proposal:
    proposal_id: str
    artifact_id: str
    source_location: str
    raw_value: str


@dataclass(frozen=True)
class Fact:
    fact_id: str
    term_id: str
    role: str
    amount_minor: int
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
class Event:
    event_id: str
    parents: tuple[str, ...]
    recorded_at: str
    kind: str
    fact: Fact | None = None
    correction: Correction | None = None


@dataclass(frozen=True)
class Case:
    schema_version: str
    case_id: str
    term_ids: tuple[str, ...]
    artifacts: tuple[Artifact, ...]
    proposals: tuple[Proposal, ...]
    events: tuple[Event, ...]


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


def _artifact(value: Any) -> Artifact:
    value = _fields(value, {"artifactId", "sha256", "kind", "observedAt"})
    sha256 = value["sha256"]
    if type(sha256) is not str or _SHA256.fullmatch(sha256) is None:
        raise ModelError("INVALID_ARTIFACT_HASH")
    return Artifact(
        artifact_id=_identifier(value["artifactId"]),
        sha256=sha256,
        kind=_identifier(value["kind"]),
        observed_at=_utc_instant(value["observedAt"]),
    )


def _proposal(value: Any, artifact_ids: set[str]) -> Proposal:
    value = _fields(value, {"proposalId", "artifactId", "sourceLocation", "rawValue"})
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
    )


def _fact(value: Any, term_ids: set[str], artifact_ids: set[str]) -> Fact:
    value = _fields(value, {"factId", "termId", "role", "amountMinor", "effectiveDate", "source", "reviewId"})
    term_id = _identifier(value["termId"])
    if term_id not in term_ids:
        raise ModelError("MISSING_TERM")
    role = value["role"]
    if type(role) is not str or role not in _ROLES:
        raise ModelError("UNSUPPORTED_ROLE")
    return Fact(
        fact_id=_identifier(value["factId"]),
        term_id=term_id,
        role=role,
        amount_minor=_nonnegative_money(value["amountMinor"]),
        effective_date=_source_date(value["effectiveDate"]),
        source=_source(value["source"], artifact_ids),
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


def _event(value: Any, term_ids: set[str], artifact_ids: set[str]) -> Event:
    if type(value) is not dict:
        raise ModelError("INVALID_SCHEMA")
    kind = value.get("kind")
    common = {"eventId", "parents", "recordedAt", "kind"}
    if kind == "approve_fact":
        value = _fields(value, common | {"fact"})
        fact = _fact(value["fact"], term_ids, artifact_ids)
        correction = None
    elif kind == "correct_fact":
        value = _fields(value, common | {"correction"})
        fact = None
        correction = _correction(value["correction"], artifact_ids)
    else:
        raise ModelError("UNSUPPORTED_EVENT")
    return Event(
        event_id=_identifier(value["eventId"]),
        parents=_unique_identifiers(value["parents"]),
        recorded_at=_utc_instant(value["recordedAt"]),
        kind=kind,
        fact=fact,
        correction=correction,
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
    raw = _fields(raw, {"schemaVersion", "caseId", "termIds", "artifacts", "proposals", "events"})
    if raw["schemaVersion"] != "1":
        raise ModelError("UNSUPPORTED_VERSION")
    term_ids = _unique_identifiers(raw["termIds"])
    artifacts = tuple(_artifact(value) for value in _array(raw["artifacts"]))
    artifact_ids = {artifact.artifact_id for artifact in artifacts}
    if len(artifact_ids) != len(artifacts):
        raise ModelError("DUPLICATE_ARTIFACT_ID")
    proposals = tuple(_proposal(value, artifact_ids) for value in _array(raw["proposals"]))
    if len({proposal.proposal_id for proposal in proposals}) != len(proposals):
        raise ModelError("DUPLICATE_PROPOSAL_ID")
    events = tuple(_event(value, set(term_ids), artifact_ids) for value in _array(raw["events"]))
    ordered = _ordered_events(events)
    fact_approvals = {event.fact.fact_id: event.event_id for event in ordered if event.fact is not None}
    if sum(event.fact is not None for event in ordered) != len(fact_approvals):
        raise ModelError("DUPLICATE_FACT_ID")
    reviews = [event.fact.review_id if event.fact else event.correction.review_id for event in ordered]
    if len(reviews) != len(set(reviews)):
        raise ModelError("DUPLICATE_REVIEW_ID")
    for event in ordered:
        if event.correction is not None:
            approval_id = fact_approvals.get(event.correction.fact_id)
            if approval_id is None or approval_id not in event.parents:
                raise ModelError("INVALID_CORRECTION_CAUSALITY")
    return Case(
        schema_version="1",
        case_id=_identifier(raw["caseId"]),
        term_ids=tuple(sorted(term_ids)),
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
