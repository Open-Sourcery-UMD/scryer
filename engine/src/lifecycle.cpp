#include "scryer/lifecycle.hpp"

#include "scryer/error.hpp"
#include "scryer/money.hpp"

#include <algorithm>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace scryer {
namespace {

using ByRole = std::map<std::string, std::vector<const LifecycleObservation*>>;

std::vector<std::string> sorted(const std::set<std::string>& values) {
    return {values.begin(), values.end()};
}

std::optional<std::int64_t> snapshot_value(const ByRole& by_role, std::string_view role) {
    const auto found = by_role.find(std::string(role));
    if (found == by_role.end()) {
        return std::nullopt;
    }
    std::int64_t active_amount = 0;
    std::size_t active_count = 0;
    for (const auto* entry : found->second) {
        if (entry->current_amount_minor > 0) {
            active_amount = entry->current_amount_minor;
            ++active_count;
        }
    }
    if (active_count == 1) {
        return active_amount;
    }
    return active_count == 0 ? std::optional<std::int64_t>{0} : std::nullopt;
}

std::int64_t sum_role(const ByRole& by_role, std::string_view role) {
    std::int64_t total = 0;
    const auto found = by_role.find(std::string(role));
    if (found != by_role.end()) {
        for (const auto* entry : found->second) {
            total = checked_add(total, entry->current_amount_minor);
        }
    }
    return total;
}

bool has_role(const ByRole& by_role, std::string_view role) {
    const auto found = by_role.find(std::string(role));
    return found != by_role.end() && !found->second.empty();
}

}  // namespace

LifecycleResult project_aid_lifecycle(
    const Case& case_data, Heads heads, std::string_view term_id, std::string_view aid_item_id
) {
    const auto term = std::find_if(case_data.terms.begin(), case_data.terms.end(), [term_id](const auto& item) {
        return item.term_id == term_id;
    });
    if (term == case_data.terms.end()) {
        throw ScryerError("MISSING_TERM");
    }
    const auto aid = std::find_if(case_data.aid_items.begin(), case_data.aid_items.end(), [aid_item_id](const auto& item) {
        return item.aid_item_id == aid_item_id;
    });
    if (aid == case_data.aid_items.end()) {
        throw ScryerError("MISSING_AID_ITEM");
    }
    const auto events = snapshot(case_data, heads);
    LifecycleResult result;
    result.case_id = case_data.case_id;
    result.heads.assign(heads.begin(), heads.end());
    std::sort(result.heads.begin(), result.heads.end());
    result.term_id = std::string(term_id);
    result.aid_item_id = std::string(aid_item_id);
    result.recipient_kind = aid->recipient_kind;
    std::set<std::string> limits{"NOT_ENTITLEMENT", "RECIPIENT_USER_RECORDED", "SOURCE_AUTHENTICITY_NOT_VERIFIED"};
    if (!aid->term_id) {
        result.status = "UNSUPPORTED_INPUT";
        result.posted_minor = 0;
        result.finding_codes = {"ANNUAL_UNALLOCATED"};
        result.next_action_codes = {"REVIEW_TERM_ALLOCATION"};
        result.limitation_codes = sorted(limits);
        return result;
    }
    if (aid->term_id != term_id || aid->institution_id != term->institution_id) {
        throw ScryerError("AID_ITEM_TERM_MISMATCH");
    }
    std::vector<const Event*> approvals;
    std::map<std::string, std::vector<const Event*>> corrections;
    for (const auto* event : events) {
        if (event->fact && event->fact->aid_item_id == aid_item_id) {
            approvals.push_back(event);
        } else if (event->correction) {
            corrections[event->correction->fact_id].push_back(event);
        }
    }
    try {
        for (const auto* event : approvals) {
            const auto& fact = *event->fact;
            if (fact.currency != case_data.currency) {
                throw ScryerError("CURRENCY_MISMATCH");
            }
            std::int64_t amount = fact.amount_minor;
            std::string source_kind = fact.source.kind;
            const auto found = corrections.find(fact.fact_id);
            const auto* correction = found == corrections.end() ? nullptr : current_correction(found->second);
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
                source_kind = fact.source.kind == "manual" || payload.source.kind == "manual" ? "manual" : "artifact";
            }
            result.observations.push_back({fact.fact_id, fact.role, amount, source_kind, event->event_id});
        }
    } catch (const ScryerError& error) {
        if (error.code() != "UNRESOLVED_CORRECTION_CONFLICT") {
            throw;
        }
        result.status = "CONTRADICTORY_EVIDENCE";
        result.observations.clear();
        result.finding_codes = {"UNRESOLVED_CORRECTION_CONFLICT"};
        result.next_action_codes = {"RESOLVE_EVIDENCE_CONFLICT"};
        result.limitation_codes = sorted(limits);
        return result;
    }
    std::sort(result.observations.begin(), result.observations.end(), [](const auto& left, const auto& right) {
        return left.fact_id < right.fact_id;
    });
    ByRole by_role;
    for (const auto& observation : result.observations) {
        by_role[observation.role].push_back(&observation);
    }
    const auto posted = sum_role(by_role, "school_credit");
    result.posted_minor = posted;
    if (has_role(by_role, "aid_gross_disbursement")) {
        result.gross_disbursed_minor = sum_role(by_role, "aid_gross_disbursement");
    }
    if (has_role(by_role, "aid_fee_withheld")) {
        result.withheld_fee_minor = sum_role(by_role, "aid_fee_withheld");
    }
    std::set<std::string> findings;
    std::set<std::string> actions;
    if (result.gross_disbursed_minor && has_role(by_role, "school_credit")) {
        const auto after_fee = checked_add(*result.gross_disbursed_minor,
                                           -result.withheld_fee_minor.value_or(0));
        result.unexplained_difference_minor = checked_add(after_fee, -posted);
        if (!result.withheld_fee_minor) {
            findings.insert("FEE_EVIDENCE_MISSING");
        }
        if (*result.unexplained_difference_minor != 0) {
            findings.insert("GROSS_NET_GAP_UNEXPLAINED");
            actions.insert("REVIEW_DISBURSEMENT_DETAILS");
        }
    } else if (result.withheld_fee_minor && !result.gross_disbursed_minor) {
        findings.insert("GROSS_DISBURSEMENT_NOT_OBSERVED");
        actions.insert("REVIEW_DISBURSEMENT_DETAILS");
    }
    for (const auto& [role, code] : {
        std::pair<std::string_view, std::string_view>{"aid_offer", "MULTIPLE_OFFER_SNAPSHOTS"},
        {"aid_accepted", "MULTIPLE_ACCEPTANCE_SNAPSHOTS"},
        {"aid_pending", "MULTIPLE_PENDING_SNAPSHOTS"}
    }) {
        const auto found = by_role.find(std::string(role));
        if (found == by_role.end()) {
            continue;
        }
        const auto active = std::count_if(found->second.begin(), found->second.end(), [](const auto* observation) {
            return observation->current_amount_minor > 0;
        });
        if (active > 1) {
            findings.insert(std::string(code));
            actions.insert("REVIEW_REVISED_AWARD");
        }
    }
    if ((posted > 0 || has_role(by_role, "aid_accepted") || has_role(by_role, "aid_pending")) &&
        !has_role(by_role, "aid_offer")) {
        findings.insert("OFFER_NOT_OBSERVED");
    }
    if (posted > 0 && !has_role(by_role, "aid_accepted")) {
        findings.insert("ACCEPTANCE_NOT_OBSERVED");
    }
    if (has_role(by_role, "work_study_offer")) {
        if (posted == 0) {
            findings.insert("WORK_STUDY_NOT_POSTED");
        } else {
            findings.insert("WORK_STUDY_POSTING_REQUIRES_REVIEW");
            actions.insert("REVIEW_POSTING_SOURCE");
        }
    }
    if (aid->recipient_kind == "parent" || aid->recipient_kind == "third_party") {
        findings.insert("NON_STUDENT_RECIPIENT");
        actions.insert("VERIFY_RECIPIENT_ACCOUNT");
    } else if (aid->recipient_kind == "unknown") {
        findings.insert("RECIPIENT_UNKNOWN");
        actions.insert("REVIEW_RECIPIENT");
    }
    result.current_pending_minor = snapshot_value(by_role, "aid_pending");
    if (result.current_pending_minor && *result.current_pending_minor > 0 && posted == 0) {
        findings.insert("PENDING_NOT_POSTED");
        actions.insert("CHECK_SCHOOL_POSTING");
    }
    const bool manual = std::any_of(result.observations.begin(), result.observations.end(), [](const auto& item) {
        return item.source_kind == "manual";
    });
    const bool manual_posting = std::any_of(result.observations.begin(), result.observations.end(), [](const auto& item) {
        return item.role == "school_credit" && item.source_kind == "manual";
    });
    if (std::any_of(findings.begin(), findings.end(), [](const auto& code) { return code.starts_with("MULTIPLE_"); })) {
        result.status = "AMBIGUOUS";
    } else if (posted > 0) {
        result.status = manual_posting ? "USER_ASSERTED" : "SUPPORTED_BY_UPLOADED_RECORDS";
    } else if (result.current_pending_minor && *result.current_pending_minor > 0) {
        result.status = "PENDING";
    } else if (!result.observations.empty()) {
        result.status = manual ? "USER_ASSERTED" : "OBSERVED";
    } else {
        result.status = "INSUFFICIENT_COVERAGE";
        actions.insert("ADD_REVIEWED_EVIDENCE");
    }
    if (manual) {
        limits.insert("MANUAL_SOURCE");
    }
    result.current_offer_minor = snapshot_value(by_role, "aid_offer");
    result.current_accepted_minor = snapshot_value(by_role, "aid_accepted");
    result.finding_codes = sorted(findings);
    result.next_action_codes = sorted(actions);
    result.limitation_codes = sorted(limits);
    return result;
}

}  // namespace scryer
