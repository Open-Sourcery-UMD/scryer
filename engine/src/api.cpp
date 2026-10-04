#include "scryer/api.hpp"

#include "scryer/case.hpp"
#include "scryer/coverage.hpp"
#include "scryer/demo_case.hpp"
#include "scryer/error.hpp"
#include "scryer/lifecycle.hpp"
#include "scryer/matching.hpp"
#include "scryer/money.hpp"
#include "scryer/projection.hpp"
#include "scryer/receipt.hpp"

#include <algorithm>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <map>
#include <new>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace scryer {
namespace {

constexpr std::string_view kEngineVersion = "native-0.1.0";
constexpr std::size_t kMaxBatch = 100;
constexpr std::size_t kMaxTimeline = 256;
constexpr std::size_t kMaxQueueTargets = 100;

void shape(const Json& object, std::initializer_list<std::string_view> required,
           std::initializer_list<std::string_view> optional = {}) {
    if (!object.is_object()) {
        throw ScryerError("INVALID_REQUEST");
    }
    std::set<std::string> allowed;
    for (const auto field : required) {
        allowed.insert(std::string(field));
        if (!object.contains(std::string(field))) {
            throw ScryerError("INVALID_REQUEST");
        }
    }
    for (const auto field : optional) {
        allowed.insert(std::string(field));
    }
    if (object.size() > allowed.size()) {
        throw ScryerError("INVALID_REQUEST");
    }
    for (auto it = object.begin(); it != object.end(); ++it) {
        if (!allowed.contains(it.key())) {
            throw ScryerError("INVALID_REQUEST");
        }
    }
}

std::string string_field(const Json& object, std::string_view key) {
    const auto& value = object.at(std::string(key));
    if (!value.is_string()) {
        throw ScryerError("INVALID_REQUEST");
    }
    return value.get<std::string>();
}

std::vector<std::string> strings(const Json& value, std::size_t limit = 200000) {
    if (!value.is_array() || value.size() > limit) {
        throw ScryerError("INVALID_REQUEST");
    }
    std::vector<std::string> result;
    result.reserve(value.size());
    for (const auto& item : value) {
        if (!item.is_string()) {
            throw ScryerError("INVALID_REQUEST");
        }
        result.push_back(item.get<std::string>());
    }
    return result;
}

int bounded_int(const Json& value, int minimum, int maximum) {
    if (!value.is_number_integer()) {
        throw ScryerError("INVALID_REQUEST");
    }
    if (value.is_number_unsigned()) {
        const auto number = value.get<std::uint64_t>();
        if (number > static_cast<std::uint64_t>(maximum)) {
            throw ScryerError("INVALID_REQUEST");
        }
        return static_cast<int>(number);
    }
    const auto number = value.get<std::int64_t>();
    if (number < minimum || number > maximum) {
        throw ScryerError("INVALID_REQUEST");
    }
    return static_cast<int>(number);
}

Json minor(std::optional<std::int64_t> value) {
    return value ? Json(std::to_string(*value)) : Json(nullptr);
}

Json intervals(const std::vector<Interval>& values) {
    Json result = Json::array();
    for (const auto& [start, end] : values) {
        result.push_back(Json::array({start, end}));
    }
    return result;
}

Json projection_json(const Projection& value) {
    return {
        {"caseId", value.case_id}, {"heads", value.heads}, {"termId", value.term_id},
        {"currency", value.currency}, {"status", value.status},
        {"amountMinor", minor(value.amount_minor)}, {"factIds", value.fact_ids},
        {"limitationCodes", value.limitation_codes}
    };
}

Json comparison_json(const Comparison& value) {
    Json contributions = Json::array();
    for (const auto& item : value.contributions) {
        contributions.push_back({
            {"factId", item.fact_id}, {"beforeMinor", std::to_string(item.before_minor)},
            {"afterMinor", std::to_string(item.after_minor)}, {"deltaMinor", std::to_string(item.delta_minor)}
        });
    }
    return {
        {"status", value.status}, {"before", projection_json(value.before)},
        {"after", projection_json(value.after)}, {"deltaMinor", minor(value.delta_minor)},
        {"contributions", contributions}, {"limitationCodes", value.limitation_codes}
    };
}

Json coverage_json(const CoverageResult& value) {
    return {
        {"accountRefId", value.account_ref_id}, {"startDate", value.start_date},
        {"endDateExclusive", value.end_date_exclusive}, {"status", value.status},
        {"coveredIntervals", intervals(value.covered_intervals)},
        {"missingIntervals", intervals(value.missing_intervals)},
        {"assertionIds", value.assertion_ids}, {"limitationCodes", value.limitation_codes}
    };
}

Json matching_json(const MatchResult& value) {
    Json allocations = Json::array();
    for (const auto& item : value.confirmed_allocations) {
        allocations.push_back({
            {"bankFactId", item.bank_fact_id}, {"bankAccountRefId", item.bank_account_ref_id},
            {"allocatedMinor", std::to_string(item.allocated_minor)},
            {"decisionEventId", item.decision_event_id}
        });
    }
    return {
        {"refundFactId", value.refund_fact_id}, {"bankAccountRefId", value.bank_account_ref_id},
        {"currency", value.currency}, {"status", value.status},
        {"refundAmountMinor", minor(value.refund_amount_minor)},
        {"candidateFactIds", value.candidate_fact_ids}, {"confirmedAllocations", allocations},
        {"remainingMinor", minor(value.remaining_minor)},
        {"coverage", value.coverage ? coverage_json(*value.coverage) : Json(nullptr)},
        {"reasonCodes", value.reason_codes}
    };
}

Json lifecycle_json(const LifecycleResult& value) {
    Json observations = Json::array();
    for (const auto& item : value.observations) {
        observations.push_back({
            {"factId", item.fact_id}, {"role", item.role},
            {"currentAmountMinor", std::to_string(item.current_amount_minor)},
            {"sourceKind", item.source_kind}, {"approvalEventId", item.approval_event_id}
        });
    }
    return {
        {"caseId", value.case_id}, {"heads", value.heads}, {"termId", value.term_id},
        {"aidItemId", value.aid_item_id}, {"recipientKind", value.recipient_kind},
        {"status", value.status}, {"currentOfferMinor", minor(value.current_offer_minor)},
        {"currentAcceptedMinor", minor(value.current_accepted_minor)},
        {"currentPendingMinor", minor(value.current_pending_minor)},
        {"postedMinor", minor(value.posted_minor)}, {"observations", observations},
        {"findingCodes", value.finding_codes}, {"nextActionCodes", value.next_action_codes},
        {"limitationCodes", value.limitation_codes},
        {"grossDisbursedMinor", minor(value.gross_disbursed_minor)},
        {"withheldFeeMinor", minor(value.withheld_fee_minor)},
        {"unexplainedDifferenceMinor", minor(value.unexplained_difference_minor)}
    };
}

std::vector<std::string> maximal_heads(const Case& case_data) {
    std::set<std::string> ids;
    std::set<std::string> parents;
    for (const auto& event : case_data.events) {
        ids.insert(event.event_id);
        parents.insert(event.parents.begin(), event.parents.end());
    }
    std::vector<std::string> result;
    for (const auto& id : ids) {
        if (!parents.contains(id)) {
            result.push_back(id);
        }
    }
    return result;
}

Json validation_json(const Case& case_data) {
    std::vector<std::string> event_ids;
    for (const auto& event : case_data.events) {
        event_ids.push_back(event.event_id);
    }
    std::sort(event_ids.begin(), event_ids.end());
    return {
        {"caseId", case_data.case_id}, {"eventIds", event_ids},
        {"heads", maximal_heads(case_data)},
        {"counts", {{"institutions", case_data.institutions.size()},
                    {"accountRefs", case_data.account_refs.size()},
                    {"terms", case_data.terms.size()}, {"aidItems", case_data.aid_items.size()},
                    {"artifacts", case_data.artifacts.size()}, {"proposals", case_data.proposals.size()},
                    {"events", case_data.events.size()}}}
    };
}

void require_term(const Case& case_data, std::string_view term_id) {
    if (std::none_of(case_data.terms.begin(), case_data.terms.end(), [term_id](const auto& term) {
        return term.term_id == term_id;
    })) {
        throw ScryerError("MISSING_TERM");
    }
}

Json historical_json(const Case& case_data, std::string_view term_id, std::string_view cutoff) {
    require_term(case_data, term_id);
    const auto history = heads_as_known(case_data, cutoff);
    Json projection = nullptr;
    if (history.status == "UNIQUE") {
        projection = projection_json(project_school_surplus(case_data, history.heads, term_id));
    }
    return {
        {"cutoffUtc", history.cutoff_utc}, {"status", history.status},
        {"heads", history.heads}, {"reasonCodes", history.reason_codes},
        {"projection", projection}
    };
}

Json source_json(const SourceRef& source, const Case& case_data) {
    if (source.kind == "manual") {
        return {{"kind", "manual"}, {"entryId", source.entry_id.value_or("")}};
    }
    if (!source.artifact_id || !source.location) {
        throw ScryerError("INVALID_SOURCE");
    }
    const auto artifact = std::find_if(case_data.artifacts.begin(), case_data.artifacts.end(), [&source](const auto& item) {
        return item.artifact_id == *source.artifact_id;
    });
    if (artifact == case_data.artifacts.end()) {
        throw ScryerError("MISSING_ARTIFACT");
    }
    return {
        {"kind", "artifact"}, {"artifactId", *source.artifact_id},
        {"location", *source.location}, {"sha256", artifact->sha256},
        {"observedAt", artifact->observed_at}
    };
}

Json trace_json(const Case& case_data, Heads heads, std::string_view fact_id) {
    const auto events = snapshot(case_data, heads);
    const Event* approval = nullptr;
    std::vector<const Event*> corrections;
    for (const auto* event : events) {
        if (event->fact && event->fact->fact_id == fact_id) {
            approval = event;
        } else if (event->correction && event->correction->fact_id == fact_id) {
            corrections.push_back(event);
        }
    }
    if (approval == nullptr) {
        throw ScryerError("MISSING_FACT_IN_SNAPSHOT");
    }
    const auto& fact = *approval->fact;
    const auto* correction = current_correction(corrections);
    std::int64_t amount = fact.amount_minor;
    const SourceRef* source = &fact.source;
    Json correction_id = nullptr;
    if (correction != nullptr) {
        const auto& payload = *correction->correction;
        amount = payload.cancelled ? 0 : payload.replacement_amount_minor.value();
        source = &payload.source;
        correction_id = correction->event_id;
    }
    Json contribution = nullptr;
    if ((fact.role == "school_credit" || fact.role == "school_charge") && fact.term_id && fact.account_ref_id) {
        const auto term = std::find_if(case_data.terms.begin(), case_data.terms.end(), [&fact](const auto& item) {
            return item.term_id == fact.term_id;
        });
        if (term != case_data.terms.end() && term->school_account_ref_id == fact.account_ref_id) {
            contribution = std::to_string(fact.role == "school_credit" ? amount : checked_negate(amount));
        }
    }
    std::vector<std::string> correction_ids;
    for (const auto* event : corrections) {
        correction_ids.push_back(event->event_id);
    }
    std::sort(correction_ids.begin(), correction_ids.end());
    return {
        {"factId", fact.fact_id}, {"role", fact.role}, {"termId", fact.term_id ? Json(*fact.term_id) : Json(nullptr)},
        {"accountRefId", fact.account_ref_id ? Json(*fact.account_ref_id) : Json(nullptr)},
        {"approvalEventId", approval->event_id}, {"approvalReviewId", fact.review_id},
        {"correctionEventIds", correction_ids}, {"currentCorrectionEventId", correction_id},
        {"originalAmountMinor", std::to_string(fact.amount_minor)},
        {"currentAmountMinor", std::to_string(amount)}, {"contributionMinor", contribution},
        {"originalSourceRef", source_json(fact.source, case_data)},
        {"currentSourceRef", source_json(*source, case_data)}
    };
}

Json queue_json(const Case& case_data, Heads heads, std::string_view term_id,
                const Json& aid_items, const Json& match_targets) {
    const auto aid_ids = strings(aid_items, kMaxQueueTargets);
    if (!match_targets.is_array() || match_targets.size() > kMaxQueueTargets) {
        throw ScryerError("INVALID_REQUEST");
    }
    Json items = Json::array();
    const auto school = project_school_surplus(case_data, heads, term_id);
    if (school.status != "SUPPORTED_BY_UPLOADED_RECORDS") {
        items.push_back({
            {"category", "school_surplus"}, {"status", school.status},
            {"targetId", std::string(term_id)}, {"evidenceFactIds", school.fact_ids},
            {"findingCodes", Json::array({school.status})},
            {"nextActionCodes", Json::array({"REVIEW_SCHOOL_RECORDS"})}, {"priority", "review"}
        });
    }
    for (const auto& aid_id : aid_ids) {
        const auto aid = project_aid_lifecycle(case_data, heads, term_id, aid_id);
        if (aid.finding_codes.empty() && aid.status == "SUPPORTED_BY_UPLOADED_RECORDS") {
            continue;
        }
        std::vector<std::string> facts;
        for (const auto& observation : aid.observations) {
            facts.push_back(observation.fact_id);
        }
        auto actions = aid.next_action_codes;
        if (actions.empty()) {
            actions.push_back("REVIEW_AID_RECORDS");
        }
        items.push_back({
            {"category", "aid_lifecycle"}, {"status", aid.status}, {"targetId", aid_id},
            {"evidenceFactIds", facts}, {"findingCodes", aid.finding_codes},
            {"nextActionCodes", actions}, {"priority", "review"}
        });
    }
    for (const auto& target : match_targets) {
        shape(target, {"refundFactId", "bankAccountRefId"});
        const auto refund_id = string_field(target, "refundFactId");
        const auto account_id = string_field(target, "bankAccountRefId");
        const auto match = suggest_refund_deposits(case_data, heads, refund_id, account_id);
        if (match.status == "MATCHED_BY_REVIEW") {
            continue;
        }
        std::vector<std::string> evidence = match.candidate_fact_ids;
        evidence.push_back(refund_id);
        std::sort(evidence.begin(), evidence.end());
        evidence.erase(std::unique(evidence.begin(), evidence.end()), evidence.end());
        items.push_back({
            {"category", "matching"}, {"status", match.status},
            {"targetId", refund_id + ":" + account_id}, {"evidenceFactIds", evidence},
            {"findingCodes", match.reason_codes},
            {"nextActionCodes", Json::array({"REVIEW_REFUND_AND_BANK_RECORDS"})},
            {"priority", "review"}
        });
    }
    std::sort(items.begin(), items.end(), [](const Json& left, const Json& right) {
        return std::pair{left.at("category").get<std::string>(), left.at("targetId").get<std::string>()} <
               std::pair{right.at("category").get<std::string>(), right.at("targetId").get<std::string>()};
    });
    return items;
}

Json case_operation(const Case& case_data, const Json& query) {
    const auto operation = string_field(query, "operation");
    if (operation == "validate") {
        shape(query, {"operation"});
        return validation_json(case_data);
    }
    if (operation == "project") {
        shape(query, {"operation", "heads", "termId"});
        const auto heads = strings(query.at("heads"));
        return projection_json(project_school_surplus(case_data, heads, string_field(query, "termId")));
    }
    if (operation == "current") {
        shape(query, {"operation", "termId"});
        const auto term_id = string_field(query, "termId");
        require_term(case_data, term_id);
        const auto heads = maximal_heads(case_data);
        if (heads.size() != 1) {
            return {{"status", heads.empty() ? "EMPTY" : "AMBIGUOUS"}, {"heads", heads},
                    {"reasonCodes", heads.empty() ? Json::array() : Json::array({"DIVERGENT_HEADS"})},
                    {"projection", nullptr}};
        }
        return {{"status", "UNIQUE"}, {"heads", heads}, {"reasonCodes", Json::array()},
                {"projection", projection_json(project_school_surplus(case_data, heads, term_id))}};
    }
    if (operation == "historical") {
        shape(query, {"operation", "cutoffUtc", "termId"});
        return historical_json(case_data, string_field(query, "termId"), string_field(query, "cutoffUtc"));
    }
    if (operation == "timeline") {
        shape(query, {"operation", "cutoffsUtc", "termId"});
        const auto term_id = string_field(query, "termId");
        require_term(case_data, term_id);
        const auto cutoffs = strings(query.at("cutoffsUtc"), kMaxTimeline);
        Json result = Json::array();
        for (const auto& cutoff : cutoffs) {
            result.push_back(historical_json(case_data, term_id, cutoff));
        }
        return result;
    }
    if (operation == "compare") {
        shape(query, {"operation", "beforeHeads", "afterHeads", "termId"});
        const auto before = strings(query.at("beforeHeads"));
        const auto after = strings(query.at("afterHeads"));
        return comparison_json(compare_school_surplus(case_data, before, after, string_field(query, "termId")));
    }
    if (operation == "coverage") {
        shape(query, {"operation", "heads", "accountRefId", "startDate", "endDateExclusive"});
        const auto heads = strings(query.at("heads"));
        return coverage_json(evaluate_bank_coverage(case_data, heads, string_field(query, "accountRefId"),
                                                    string_field(query, "startDate"), string_field(query, "endDateExclusive")));
    }
    if (operation == "matching") {
        shape(query, {"operation", "heads", "refundFactId", "bankAccountRefId"},
              {"candidateLimit", "windowDays"});
        const auto heads = strings(query.at("heads"));
        const auto limit = query.contains("candidateLimit") ? bounded_int(query.at("candidateLimit"), 1, 10000) : 1000;
        const auto window = query.contains("windowDays") ? bounded_int(query.at("windowDays"), 0, 90) : 30;
        return matching_json(suggest_refund_deposits(case_data, heads, string_field(query, "refundFactId"),
                                                     string_field(query, "bankAccountRefId"), limit, window));
    }
    if (operation == "lifecycle") {
        shape(query, {"operation", "heads", "termId", "aidItemId"});
        const auto heads = strings(query.at("heads"));
        return lifecycle_json(project_aid_lifecycle(case_data, heads, string_field(query, "termId"),
                                                    string_field(query, "aidItemId")));
    }
    if (operation == "receipt") {
        shape(query, {"operation", "heads", "termId"}, {"producerVersion"});
        const auto heads = strings(query.at("heads"));
        const auto version = query.contains("producerVersion") ? string_field(query, "producerVersion") :
            std::string(kEngineVersion);
        return make_receipt(case_data, heads, string_field(query, "termId"), version);
    }
    if (operation == "verify-receipt" || operation == "reproduce-receipt") {
        shape(query, {"operation", "archived"});
        const auto rebuilt = reproduce_receipt(case_data, query.at("archived"));
        return operation == "verify-receipt" ? Json{{"valid", true}, {"code", "VALID"}} : rebuilt;
    }
    if (operation == "reanalyze-receipt") {
        shape(query, {"operation", "archived", "newHeads"}, {"producerVersion"});
        const auto heads = strings(query.at("newHeads"));
        if (!query.contains("producerVersion")) {
            const auto result = reanalyze_receipt(case_data, query.at("archived"), heads);
            return {{"priorDigest", result.prior_digest}, {"receipt", result.receipt}};
        }
        const auto old = reproduce_receipt(case_data, query.at("archived"));
        const auto receipt = make_receipt(case_data, heads, old.at("termId").get<std::string>(),
                                          string_field(query, "producerVersion"));
        return {{"priorDigest", old.at("digest")}, {"receipt", receipt}};
    }
    if (operation == "discrepancy-queue") {
        shape(query, {"operation", "heads", "termId", "aidItemIds", "matchTargets"});
        const auto heads = strings(query.at("heads"));
        return queue_json(case_data, heads, string_field(query, "termId"),
                          query.at("aidItemIds"), query.at("matchTargets"));
    }
    if (operation == "trace") {
        shape(query, {"operation", "heads", "factId"});
        const auto heads = strings(query.at("heads"));
        return trace_json(case_data, heads, string_field(query, "factId"));
    }
    throw ScryerError("UNSUPPORTED_OPERATION");
}

Json demo_json() {
    const auto case_data = parse_case(parse_document(kDemoCase));
    const std::vector<std::string> before_heads{"event-base-charge"};
    const std::vector<std::string> after_heads{"event-extra-charge"};
    const auto before = project_school_surplus(case_data, before_heads, "2026-fall");
    const auto after = project_school_surplus(case_data, after_heads, "2026-fall");
    const auto comparison = compare_school_surplus(case_data, before_heads, after_heads, "2026-fall");
    const auto receipt = make_receipt(case_data, after_heads, "2026-fall");
    const auto refund = trace_json(case_data, std::vector<std::string>{"event-refund-issued"}, "issued-refund");
    const auto bank = trace_json(case_data, std::vector<std::string>{"event-bank-credit"}, "bank-credit");
    return {
        {"caseId", case_data.case_id}, {"before", projection_json(before)},
        {"after", projection_json(after)}, {"comparison", comparison_json(comparison)},
        {"receipt", receipt}, {"refundObservation", refund}, {"bankObservation", bank}
    };
}

Json dispatch(const Json& query) {
    const auto operation = string_field(query, "operation");
    if (operation == "capabilities") {
        shape(query, {"operation"});
        return {
            {"operations", std::vector<std::string>{
                "batch", "capabilities", "compare", "coverage", "current", "demo", "discrepancy-queue",
                "historical", "lifecycle", "matching", "project", "reanalyze-receipt", "receipt",
                "reproduce-receipt", "schema", "timeline", "trace", "validate", "verify-receipt"
            }},
            {"ruleVersion", "school-surplus-1"}, {"producerVersion", std::string(kEngineVersion)},
            {"maxDocumentBytes", 20 * 1024 * 1024}, {"maxEvents", 200000},
            {"maxBatch", kMaxBatch}, {"maxTimeline", kMaxTimeline}
        };
    }
    if (operation == "schema") {
        shape(query, {"operation"});
        return {
            {"caseSchemaVersion", "1"}, {"requestSchemaVersion", "1"},
            {"caseFields", std::vector<std::string>{
                "schemaVersion", "caseId", "currency", "institutions", "accountRefs",
                "terms", "aidItems", "artifacts", "proposals", "events"
            }},
            {"maxDocumentBytes", 20 * 1024 * 1024}, {"maxJsonDepth", 64}, {"maxEvents", 200000}
        };
    }
    if (operation == "demo") {
        shape(query, {"operation"});
        return demo_json();
    }
    if (operation == "validate") {
        shape(query, {"operation", "case"});
        return validation_json(parse_case(query.at("case")));
    }
    if (operation == "batch") {
        shape(query, {"operation", "case", "requests"});
        const auto case_data = parse_case(query.at("case"));
        const auto& requests = query.at("requests");
        if (!requests.is_array() || requests.size() > kMaxBatch) {
            throw ScryerError("INVALID_REQUEST");
        }
        Json responses = Json::array();
        for (const auto& subrequest : requests) {
            if (!subrequest.is_object()) {
                throw ScryerError("INVALID_REQUEST");
            }
            const auto suboperation = string_field(subrequest, "operation");
            if (suboperation == "batch" || suboperation == "demo" || suboperation == "capabilities" ||
                suboperation == "schema" || subrequest.contains("case") ||
                subrequest.contains("schemaVersion")) {
                throw ScryerError("INVALID_REQUEST");
            }
            responses.push_back({{"operation", suboperation}, {"result", case_operation(case_data, subrequest)}});
        }
        return responses;
    }
    if (!query.contains("case")) {
        throw ScryerError("INVALID_REQUEST");
    }
    const auto case_data = parse_case(query.at("case"));
    Json without_case = query;
    without_case.erase("case");
    return case_operation(case_data, without_case);
}

}  // namespace

Response evaluate(const Request& request) {
    try {
        const auto& document = request.document;
        if (!document.is_object() || !document.contains("schemaVersion") ||
            document.at("schemaVersion") != "1" || !document.contains("operation") ||
            !document.at("operation").is_string()) {
            throw ScryerError("INVALID_REQUEST");
        }
        const auto operation = document.at("operation").get<std::string>();
        Json query = document;
        query.erase("schemaVersion");
        return {Json{{"schemaVersion", "1"}, {"engineVersion", std::string(kEngineVersion)},
                     {"operation", operation}, {"result", dispatch(query)}}};
    } catch (const Json::exception&) {
        throw ScryerError("INVALID_REQUEST");
    } catch (const std::bad_alloc&) {
        throw ScryerError("COMPUTATION_LIMIT");
    }
}

}  // namespace scryer
