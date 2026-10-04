"""Explicit historical reproduction and later reanalysis of local reference receipts."""

from dataclasses import dataclass

from .check_receipt import check_receipt
from .model import Case, ModelError
from .receipt import _SUPPORTED_REFERENCE_ENGINES, make_school_surplus_receipt


@dataclass(frozen=True)
class ReanalysisResult:
    prior_digest: str
    receipt: dict[str, object]


def reproduce_school_surplus_receipt(case: Case, archived: dict[str, object]) -> dict[str, object]:
    """Rebuild under recorded heads/rule/producer; never substitute current heads."""

    if type(archived) is not dict:
        raise ModelError("INVALID_HISTORICAL_RECEIPT")
    if archived.get("ruleVersion") != "school-surplus-1":
        raise ModelError("UNSUPPORTED_RULE")
    engine = archived.get("engineVersion")
    if type(engine) is not str or engine not in _SUPPORTED_REFERENCE_ENGINES:
        raise ModelError("UNSUPPORTED_ENGINE_VERSION")
    if not check_receipt(case, archived).valid:
        raise ModelError("INVALID_HISTORICAL_RECEIPT")
    heads = archived["heads"]
    term_id = archived["termId"]
    if type(heads) is not list or type(term_id) is not str:
        raise ModelError("INVALID_HISTORICAL_RECEIPT")
    rebuilt = make_school_surplus_receipt(case, tuple(heads), term_id, engine_version=engine)
    if rebuilt != archived:
        raise ModelError("HISTORICAL_REPRODUCTION_MISMATCH")
    return rebuilt


def reanalyze_school_surplus_receipt(
    case: Case, archived: dict[str, object], new_heads: tuple[str, ...]
) -> ReanalysisResult:
    """Produce a new receipt on explicitly selected heads and link the old digest."""

    reproduce_school_surplus_receipt(case, archived)
    receipt = make_school_surplus_receipt(
        case, new_heads, archived["termId"], engine_version="reference-0.2.0"
    )
    return ReanalysisResult(prior_digest=archived["digest"], receipt=receipt)
