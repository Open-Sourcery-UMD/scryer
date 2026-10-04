#include "scryer/receipt.hpp"

#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"
#include "scryer/money.hpp"
#include "scryer/projection.hpp"
#include "picosha2.h"

#include <algorithm>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

namespace scryer {
namespace {

bool supported_producer(std::string_view version) {
    return version == "reference-0.1.0" || version == "reference-0.2.0" || version == "native-0.1.0";
}

Json nullable(const std::optional<std::string>& value) {
    return value ? Json(*value) : Json(nullptr);
}

Json nullable_minor(const std::optional<std::int64_t>& value) {
    return value ? Json(std::to_string(*value)) : Json(nullptr);
}

Json source_json(const SourceRef& source, const Case& case_data) {
    if (source.kind == "manual") {
        if (!source.entry_id) {
            throw ScryerError("INVALID_SOURCE");
        }
        return {{"kind", "manual"}, {"entryId", *source.entry_id}};
    }
    if (source.kind != "artifact" || !source.artifact_id || !source.location) {
        throw ScryerError("INVALID_SOURCE");
    }
    const auto artifact = std::find_if(case_data.artifacts.begin(), case_data.artifacts.end(), [&source](const auto& item) {
        return item.artifact_id == *source.artifact_id;
    });
    if (artifact == case_data.artifacts.end()) {
        throw ScryerError("MISSING_ARTIFACT");
    }
    return {
        {"kind", "artifact"}, {"artifactId", *source.artifact_id}, {"location", *source.location},
        {"sha256", artifact->sha256}, {"observedAt", artifact->observed_at}
    };
}

const Event* current_correction(const std::vector<const Event*>& corrections) {
    if (corrections.empty()) {
        return nullptr;
    }
    std::unordered_set<std::string> ids;
    ids.reserve(corrections.size());
    for (const auto* event : corrections) {
        ids.insert(event->event_id);
    }
    std::unordered_set<std::string> superseded;
    for (const auto* event : corrections) {
        for (const auto& parent : event->parents) {
            if (ids.contains(parent)) {
                superseded.insert(parent);
            }
        }
    }
    const Event* current = nullptr;
    for (const auto* event : corrections) {
        if (!superseded.contains(event->event_id)) {
            if (current != nullptr) {
                throw ScryerError("UNRESOLVED_CORRECTION_CONFLICT");
            }
            current = event;
        }
    }
    if (current == nullptr) {
        throw ScryerError("UNRESOLVED_CORRECTION_CONFLICT");
    }
    return current;
}

Json receipt_step(
    const std::string& fact_id, const Event& approval, const Event* correction,
    const Case& case_data, const std::map<std::string, const Proposal*>& proposals
) {
    if (!approval.fact) {
        throw ScryerError("INVALID_EVENT_STATE");
    }
    const auto& fact = *approval.fact;
    std::int64_t amount = fact.amount_minor;
    const SourceRef* source = &fact.source;
    Json correction_id = nullptr;
    Json correction_review = nullptr;
    Json correction_recorded = nullptr;
    if (correction != nullptr) {
        if (!correction->correction) {
            throw ScryerError("INVALID_EVENT_STATE");
        }
        const auto& payload = *correction->correction;
        if (payload.cancelled) {
            amount = 0;
        } else if (payload.replacement_amount_minor) {
            amount = *payload.replacement_amount_minor;
        } else {
            throw ScryerError("INVALID_CORRECTION");
        }
        source = &payload.source;
        correction_id = correction->event_id;
        correction_review = payload.review_id;
        correction_recorded = correction->recorded_at;
    }
    const Proposal* proposal = nullptr;
    if (fact.proposal_id) {
        const auto found = proposals.find(*fact.proposal_id);
        if (found == proposals.end()) {
            throw ScryerError("MISSING_PROPOSAL");
        }
        proposal = found->second;
    }
    const auto contribution = fact.role == "school_credit" ? amount : checked_negate(amount);
    return {
        {"factId", fact_id}, {"aidItemId", nullable(fact.aid_item_id)},
        {"proposalId", nullable(fact.proposal_id)},
        {"proposedAmountMinor", proposal ? nullable_minor(proposal->proposed_amount_minor) : Json(nullptr)},
        {"parserVersion", proposal ? Json(proposal->parser_version) : Json(nullptr)},
        {"mappingVersion", proposal ? Json(proposal->mapping_version) : Json(nullptr)},
        {"role", fact.role}, {"originalAmountMinor", std::to_string(fact.amount_minor)},
        {"currentAmountMinor", std::to_string(amount)}, {"contributionMinor", std::to_string(contribution)},
        {"approvalEventId", approval.event_id}, {"approvalReviewId", fact.review_id},
        {"approvalRecordedAt", approval.recorded_at}, {"correctionEventId", correction_id},
        {"correctionReviewId", correction_review}, {"correctionRecordedAt", correction_recorded},
        {"effectiveDate", nullable(fact.effective_date)},
        {"originalSourceRef", source_json(fact.source, case_data)}, {"sourceRef", source_json(*source, case_data)}
    };
}

}  // namespace

std::string sha256_hex(std::string_view bytes) {
    return picosha2::hash256_hex_string(bytes.begin(), bytes.end());
}

Json make_receipt(const Case& case_data, Heads heads, std::string_view term_id, std::string_view producer_version) {
    if (!supported_producer(producer_version)) {
        throw ScryerError("UNSUPPORTED_ENGINE_VERSION");
    }
    const auto projection = project_school_surplus(case_data, heads, term_id);
    if (!projection.amount_minor) {
        throw ScryerError("UNSUPPORTED_RECEIPT_STATUS");
    }
    const auto term = std::find_if(case_data.terms.begin(), case_data.terms.end(), [term_id](const auto& item) {
        return item.term_id == term_id;
    });
    if (term == case_data.terms.end()) {
        throw ScryerError("MISSING_TERM");
    }
    const auto events = snapshot(case_data, heads);
    std::map<std::string, const Event*> approvals;
    std::map<std::string, std::vector<const Event*>> corrections;
    for (const auto* event : events) {
        if (event->fact) {
            approvals.emplace(event->fact->fact_id, event);
        } else if (event->correction) {
            corrections[event->correction->fact_id].push_back(event);
        }
    }
    std::map<std::string, const Proposal*> proposals;
    for (const auto& proposal : case_data.proposals) {
        proposals.emplace(proposal.proposal_id, &proposal);
    }
    Json steps = Json::array();
    for (const auto& fact_id : projection.fact_ids) {
        const auto approval = approvals.find(fact_id);
        if (approval == approvals.end()) {
            throw ScryerError("INVALID_EVENT_STATE");
        }
        steps.push_back(receipt_step(
            fact_id, *approval->second, current_correction(corrections[fact_id]), case_data, proposals
        ));
    }
    std::set<std::string> limitations(projection.limitation_codes.begin(), projection.limitation_codes.end());
    limitations.insert("SOURCE_AUTHENTICITY_NOT_VERIFIED");
    const std::vector<std::string> sorted_limitations(limitations.begin(), limitations.end());
    Json core = {
        {"schemaVersion", "1"}, {"engineVersion", std::string(producer_version)},
        {"ruleVersion", "school-surplus-1"}, {"metric", "school_surplus"},
        {"caseId", case_data.case_id}, {"currency", case_data.currency}, {"heads", projection.heads},
        {"termId", std::string(term_id)}, {"institutionId", term->institution_id},
        {"accountRefId", term->school_account_ref_id}, {"status", projection.status},
        {"amountMinor", std::to_string(*projection.amount_minor)},
        {"facts", steps}, {"limitations", sorted_limitations}
    };
    const auto canonical = canonical_json(core);
    core["digest"] = sha256_hex(canonical);
    return core;
}

Json reproduce_receipt(const Case& case_data, const Json& archived) {
    if (!archived.is_object()) {
        throw ScryerError("INVALID_HISTORICAL_RECEIPT");
    }
    if (!archived.contains("ruleVersion") || archived.at("ruleVersion") != "school-surplus-1") {
        throw ScryerError("UNSUPPORTED_RULE");
    }
    if (!archived.contains("engineVersion") || !archived.at("engineVersion").is_string() ||
        !supported_producer(archived.at("engineVersion").get<std::string>())) {
        throw ScryerError("UNSUPPORTED_ENGINE_VERSION");
    }
    try {
        const auto heads = archived.at("heads").get<std::vector<std::string>>();
        const auto term_id = archived.at("termId").get<std::string>();
        const auto version = archived.at("engineVersion").get<std::string>();
        const auto rebuilt = make_receipt(case_data, heads, term_id, version);
        if (rebuilt != archived) {
            throw ScryerError("INVALID_HISTORICAL_RECEIPT");
        }
        return rebuilt;
    } catch (const Json::exception&) {
        throw ScryerError("INVALID_HISTORICAL_RECEIPT");
    } catch (const ScryerError& error) {
        if (error.code() == "INVALID_HISTORICAL_RECEIPT") {
            throw;
        }
        throw ScryerError("INVALID_HISTORICAL_RECEIPT");
    }
}

ReanalysisResult reanalyze_receipt(const Case& case_data, const Json& archived, Heads new_heads) {
    const auto old = reproduce_receipt(case_data, archived);
    const auto newer = make_receipt(case_data, new_heads, old.at("termId").get<std::string>(), "native-0.1.0");
    return {old.at("digest").get<std::string>(), newer};
}

}  // namespace scryer
