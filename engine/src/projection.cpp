#include "scryer/projection.hpp"

#include "scryer/error.hpp"
#include "scryer/money.hpp"

#include <algorithm>
#include <cstdint>
#include <limits>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace scryer {
namespace {

struct Evaluation {
    Projection projection;
    std::map<std::string, std::int64_t> contributions;
};

std::int64_t checked_subtract(std::int64_t left, std::int64_t right) {
    if ((right < 0 && left > std::numeric_limits<std::int64_t>::max() + right) ||
        (right > 0 && left < std::numeric_limits<std::int64_t>::min() + right)) {
        throw ScryerError("MONEY_OVERFLOW");
    }
    return left - right;
}

std::vector<std::string> sorted_heads(Heads heads) {
    std::vector<std::string> result(heads.begin(), heads.end());
    std::sort(result.begin(), result.end());
    return result;
}

Evaluation evaluate(const Case& case_data, Heads heads, std::string_view term_id) {
    const auto term = std::find_if(case_data.terms.begin(), case_data.terms.end(), [term_id](const auto& item) {
        return item.term_id == term_id;
    });
    if (term == case_data.terms.end()) {
        throw ScryerError("MISSING_TERM");
    }
    const auto events = snapshot(case_data, heads);
    std::map<std::string, const Fact*> facts;
    std::map<std::string, std::vector<const Event*>> corrections;
    for (const auto* event : events) {
        if (event->fact) {
            facts.emplace(event->fact->fact_id, &*event->fact);
        } else if (event->correction) {
            corrections[event->correction->fact_id].push_back(event);
        }
    }
    std::vector<std::string> posted_ids;
    for (const auto& [id, fact] : facts) {
        if (fact->currency != case_data.currency) {
            throw ScryerError("CURRENCY_MISMATCH");
        }
        if (fact->term_id == term->term_id && fact->account_ref_id == term->school_account_ref_id &&
            (fact->role == "school_credit" || fact->role == "school_charge")) {
            posted_ids.push_back(id);
        }
    }
    Projection result{case_data.case_id, sorted_heads(heads), std::string(term_id), case_data.currency,
                      "", std::nullopt, posted_ids, {}};
    Evaluation evaluation{std::move(result), {}};
    bool manually_asserted = false;
    for (const auto& fact_id : posted_ids) {
        const auto* fact = facts.at(fact_id);
        const Event* correction = nullptr;
        try {
            correction = current_correction(corrections[fact_id]);
        } catch (const ScryerError& error) {
            if (error.code() != "UNRESOLVED_CORRECTION_CONFLICT") {
                throw;
            }
            evaluation.projection.status = "CONTRADICTORY_EVIDENCE";
            evaluation.projection.limitation_codes = {"NOT_ENTITLEMENT", "UNRESOLVED_CORRECTION_CONFLICT"};
            evaluation.contributions.clear();
            return evaluation;
        }
        std::int64_t amount = fact->amount_minor;
        const SourceRef* source = &fact->source;
        if (correction != nullptr) {
            const auto& payload = *correction->correction;
            if (payload.cancelled) {
                amount = 0;
            } else if (payload.replacement_amount_minor) {
                amount = *payload.replacement_amount_minor;
            } else {
                throw ScryerError("INVALID_CORRECTION");
            }
            source = &payload.source;
        }
        evaluation.contributions.emplace(fact_id, fact->role == "school_credit" ? amount : checked_negate(amount));
        manually_asserted |= fact->source.kind == "manual" || source->kind == "manual";
    }
    if (evaluation.contributions.empty()) {
        evaluation.projection.status = "INSUFFICIENT_COVERAGE";
        evaluation.projection.limitation_codes = {"NO_POSTED_SCHOOL_MOVEMENTS", "NOT_ENTITLEMENT"};
        return evaluation;
    }
    std::int64_t total = 0;
    for (const auto& [_, amount] : evaluation.contributions) {
        total = checked_add(total, amount);
    }
    evaluation.projection.status = manually_asserted ? "USER_ASSERTED" : "SUPPORTED_BY_UPLOADED_RECORDS";
    evaluation.projection.amount_minor = total;
    evaluation.projection.limitation_codes = manually_asserted ?
        std::vector<std::string>{"MANUAL_SOURCE", "NOT_ENTITLEMENT", "SOURCE_SET_MAY_BE_INCOMPLETE"} :
        std::vector<std::string>{"NOT_ENTITLEMENT", "SOURCE_SET_MAY_BE_INCOMPLETE"};
    return evaluation;
}

std::vector<std::string> union_limitations(const Projection& before, const Projection& after) {
    std::set<std::string> codes(before.limitation_codes.begin(), before.limitation_codes.end());
    codes.insert(after.limitation_codes.begin(), after.limitation_codes.end());
    return {codes.begin(), codes.end()};
}

}  // namespace

Projection project_school_surplus(const Case& case_data, Heads heads, std::string_view term_id) {
    return evaluate(case_data, heads, term_id).projection;
}

Comparison compare_school_surplus(
    const Case& case_data, Heads before_heads, Heads after_heads, std::string_view term_id
) {
    auto before = evaluate(case_data, before_heads, term_id);
    auto after = evaluate(case_data, after_heads, term_id);
    Comparison result{"", std::move(before.projection), std::move(after.projection), std::nullopt, {}, {}};
    result.limitation_codes = union_limitations(result.before, result.after);
    if (!result.before.amount_minor || !result.after.amount_minor) {
        result.status = result.before.status == "CONTRADICTORY_EVIDENCE" ||
                        result.after.status == "CONTRADICTORY_EVIDENCE" ?
            "CONTRADICTORY_EVIDENCE" : "INSUFFICIENT_COVERAGE";
        return result;
    }
    result.delta_minor = checked_subtract(*result.after.amount_minor, *result.before.amount_minor);
    std::set<std::string> fact_ids;
    for (const auto& [id, _] : before.contributions) {
        fact_ids.insert(id);
    }
    for (const auto& [id, _] : after.contributions) {
        fact_ids.insert(id);
    }
    std::int64_t attribution_total = 0;
    for (const auto& id : fact_ids) {
        const auto left = before.contributions.contains(id) ? before.contributions.at(id) : 0;
        const auto right = after.contributions.contains(id) ? after.contributions.at(id) : 0;
        if (left != right) {
            const auto delta = checked_subtract(right, left);
            result.contributions.push_back({id, left, right, delta});
            attribution_total = checked_add(attribution_total, delta);
        }
    }
    if (attribution_total != *result.delta_minor) {
        throw ScryerError("ATTRIBUTION_INCOMPLETE");
    }
    result.status = result.before.status == "USER_ASSERTED" || result.after.status == "USER_ASSERTED" ?
        "USER_ASSERTED" : "SUPPORTED_BY_UPLOADED_RECORDS";
    return result;
}

}  // namespace scryer
