#include "scryer/matching.hpp"

#include "scryer/error.hpp"
#include "scryer/money.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

namespace scryer {
namespace {

using Corrections = std::map<std::string, std::vector<const Event*>>;
using Pair = std::pair<std::string, std::string>;

std::int64_t current_amount(const Fact& fact, const Corrections& corrections) {
    const auto found = corrections.find(fact.fact_id);
    if (found == corrections.end()) {
        return fact.amount_minor;
    }
    const auto* current = current_correction(found->second);
    if (current == nullptr) {
        return fact.amount_minor;
    }
    if (!current->correction) {
        throw ScryerError("INVALID_EVENT_STATE");
    }
    const auto& payload = *current->correction;
    if (payload.cancelled) {
        return 0;
    }
    if (!payload.replacement_amount_minor) {
        throw ScryerError("INVALID_CORRECTION");
    }
    return *payload.replacement_amount_minor;
}

const Event* current_decision(const std::vector<const Event*>& decisions) {
    std::set<std::string> ids;
    for (const auto* event : decisions) {
        ids.insert(event->event_id);
    }
    std::set<std::string> superseded;
    for (const auto* event : decisions) {
        for (const auto& parent : event->parents) {
            if (ids.contains(parent)) {
                superseded.insert(parent);
            }
        }
    }
    const Event* current = nullptr;
    for (const auto* event : decisions) {
        if (!superseded.contains(event->event_id)) {
            if (current != nullptr) {
                throw ScryerError("CONFLICTING_MATCH_DECISIONS");
            }
            current = event;
        }
    }
    if (current == nullptr) {
        throw ScryerError("CONFLICTING_MATCH_DECISIONS");
    }
    return current;
}

std::string add_days(const std::string& date_text, int count) {
    const int year_value = std::stoi(date_text.substr(0, 4));
    const auto month_value = static_cast<unsigned>(std::stoi(date_text.substr(5, 2)));
    const auto day_value = static_cast<unsigned>(std::stoi(date_text.substr(8, 2)));
    const std::chrono::year_month_day civil{
        std::chrono::year{year_value}, std::chrono::month{month_value}, std::chrono::day{day_value}
    };
    const auto later = std::chrono::year_month_day{
        std::chrono::sys_days{civil} + std::chrono::days{count}
    };
    const int later_year = static_cast<int>(later.year());
    if (later_year < 1 || later_year > 9999) {
        throw ScryerError("UNSUPPORTED_DATE_RANGE");
    }
    char buffer[11];
    if (std::snprintf(buffer, sizeof(buffer), "%04d-%02u-%02u", later_year,
                      static_cast<unsigned>(later.month()), static_cast<unsigned>(later.day())) != 10) {
        throw ScryerError("UNSUPPORTED_DATE_RANGE");
    }
    return buffer;
}

MatchResult result(
    std::string_view refund_id, std::string_view account_id, std::string status,
    std::optional<std::int64_t> amount, const std::set<std::string>& reasons,
    std::vector<std::string> candidates = {}, std::vector<Allocation> allocations = {},
    std::optional<std::int64_t> remaining = std::nullopt,
    std::optional<CoverageResult> coverage = std::nullopt
) {
    return {std::string(refund_id), std::string(account_id), "USD", std::move(status), amount,
            std::move(candidates), std::move(allocations), remaining, std::move(coverage),
            {reasons.begin(), reasons.end()}};
}

}  // namespace

MatchResult suggest_refund_deposits(
    const Case& case_data, Heads heads, std::string_view refund_fact_id,
    std::string_view bank_account_ref_id, int candidate_limit, int window_days
) {
    if (candidate_limit < 1 || candidate_limit > 10000) {
        throw ScryerError("INVALID_CANDIDATE_LIMIT");
    }
    if (window_days < 0 || window_days > 90) {
        throw ScryerError("INVALID_MATCH_WINDOW");
    }
    const auto account = std::find_if(case_data.account_refs.begin(), case_data.account_refs.end(),
        [bank_account_ref_id](const auto& item) { return item.account_ref_id == bank_account_ref_id; });
    if (account == case_data.account_refs.end()) {
        throw ScryerError("MISSING_ACCOUNT");
    }
    if (account->kind != "bank") {
        throw ScryerError("ACCOUNT_KIND_MISMATCH");
    }
    const auto events = snapshot(case_data, heads);
    std::map<std::string, const Fact*> approvals;
    std::map<std::string, const Fact*> bank_facts;
    Corrections corrections;
    std::map<Pair, std::vector<const Event*>> decisions;
    for (const auto* event : events) {
        if (event->fact) {
            const auto& fact = *event->fact;
            if (fact.currency != case_data.currency) {
                throw ScryerError("CURRENCY_MISMATCH");
            }
            approvals.emplace(fact.fact_id, &fact);
            if (fact.role == "bank_credit_observed") {
                bank_facts.emplace(fact.fact_id, &fact);
            }
        } else if (event->correction) {
            corrections[event->correction->fact_id].push_back(event);
        } else if (event->decision) {
            const auto& decision = *event->decision;
            decisions[{decision.refund_fact_id, decision.bank_fact_id}].push_back(event);
        }
    }
    const auto refund = approvals.find(std::string(refund_fact_id));
    if (refund == approvals.end()) {
        throw ScryerError("MISSING_FACT_IN_SNAPSHOT");
    }
    if (refund->second->role != "refund_issued") {
        throw ScryerError("MATCH_ROLE_MISMATCH");
    }
    std::set<std::string> reasons{"RECIPIENT_METADATA_USER_REVIEWED", "SOURCE_AUTHENTICITY_NOT_VERIFIED"};
    const bool recipient_known = refund->second->recipient_kind != "unknown" && account->holder_kind != "unknown";
    const bool recipient_matches = recipient_known && refund->second->recipient_kind == account->holder_kind;
    if (!recipient_known) {
        reasons.insert("RECIPIENT_IDENTITY_UNKNOWN");
    } else if (!recipient_matches) {
        reasons.insert("RECIPIENT_MISMATCH");
    }
    std::int64_t refund_amount = 0;
    try {
        refund_amount = current_amount(*refund->second, corrections);
    } catch (const ScryerError& error) {
        if (error.code() != "UNRESOLVED_CORRECTION_CONFLICT") {
            throw;
        }
        reasons.insert(std::string(error.code()));
        return result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", std::nullopt, reasons);
    }
    std::map<Pair, const Event*> active;
    for (const auto& [pair, pair_events] : decisions) {
        const auto bank = bank_facts.find(pair.second);
        const bool relevant = pair.first == refund_fact_id ||
            (bank != bank_facts.end() && bank->second->account_ref_id == bank_account_ref_id);
        if (!relevant) {
            continue;
        }
        try {
            active.emplace(pair, current_decision(pair_events));
        } catch (const ScryerError& error) {
            reasons.insert(std::string(error.code()));
            return result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount, reasons);
        }
    }
    std::map<std::string, std::int64_t> allocated_by_bank;
    std::map<std::string, std::int64_t> allocated_by_refund;
    std::vector<Allocation> own_allocations;
    for (const auto& [pair, event] : active) {
        const auto& decision = *event->decision;
        if (decision.action != "confirm") {
            continue;
        }
        try {
            allocated_by_bank[pair.second] = checked_add(allocated_by_bank[pair.second], decision.allocated_minor);
        } catch (const ScryerError& error) {
            if (error.code() != "MONEY_OVERFLOW") { throw; }
            reasons.insert("BANK_OVERALLOCATED");
            return result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount, reasons);
        }
        try {
            allocated_by_refund[pair.first] = checked_add(allocated_by_refund[pair.first], decision.allocated_minor);
        } catch (const ScryerError& error) {
            if (error.code() != "MONEY_OVERFLOW") { throw; }
            reasons.insert("REFUND_OVERALLOCATED");
            return result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount, reasons);
        }
        if (pair.first == refund_fact_id) {
            const auto bank = bank_facts.at(pair.second);
            if (bank->account_ref_id == bank_account_ref_id) {
                own_allocations.push_back({pair.second, *bank->account_ref_id, decision.allocated_minor, event->event_id});
                if (decision.recipient_evidence) {
                    reasons.insert("RECIPIENT_EXCEPTION_SOURCE_REVIEWED");
                }
            }
        }
    }
    for (const auto& [bank_id, allocated] : allocated_by_bank) {
        std::int64_t amount = 0;
        try {
            amount = current_amount(*bank_facts.at(bank_id), corrections);
        } catch (const ScryerError& error) {
            if (error.code() != "UNRESOLVED_CORRECTION_CONFLICT") { throw; }
            reasons.insert(std::string(error.code()));
            return result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount, reasons);
        }
        if (allocated > amount) {
            reasons.insert("BANK_OVERALLOCATED");
            return result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount, reasons);
        }
    }
    for (const auto& [other_refund_id, allocated] : allocated_by_refund) {
        std::int64_t amount = 0;
        try {
            amount = other_refund_id == refund_fact_id ? refund_amount :
                current_amount(*approvals.at(other_refund_id), corrections);
        } catch (const ScryerError& error) {
            if (error.code() != "UNRESOLVED_CORRECTION_CONFLICT") { throw; }
            reasons.insert(std::string(error.code()));
            return result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount, reasons);
        }
        if (allocated > amount) {
            reasons.insert("REFUND_OVERALLOCATED");
            return result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount, reasons);
        }
    }
    const auto remaining = refund_amount - allocated_by_refund[std::string(refund_fact_id)];
    std::sort(own_allocations.begin(), own_allocations.end(), [](const auto& left, const auto& right) {
        return std::tie(left.bank_fact_id, left.decision_event_id) <
               std::tie(right.bank_fact_id, right.decision_event_id);
    });
    if (refund_amount == 0) {
        return result(refund_fact_id, bank_account_ref_id, "REFUND_CANCELLED", 0, reasons,
                      {}, std::move(own_allocations), 0);
    }
    std::optional<CoverageResult> coverage;
    const auto& window_start = refund->second->effective_date;
    std::optional<std::string> window_end;
    if (!window_start) {
        reasons.insert("MISSING_REFUND_DATE");
    } else {
        window_end = add_days(*window_start, window_days + 1);
        coverage = evaluate_bank_coverage(case_data, heads, bank_account_ref_id, *window_start, *window_end);
        reasons.insert("HEURISTIC_DATE_WINDOW");
        if (coverage->status == "INSUFFICIENT_COVERAGE") {
            reasons.insert("COVERAGE_GAP");
        } else if (coverage->status == "USER_ASSERTED") {
            reasons.insert("USER_ASSERTED_COVERAGE");
        }
    }
    for (const auto& allocation : own_allocations) {
        const auto* bank = bank_facts.at(allocation.bank_fact_id);
        if (bank->source.kind == "manual") {
            reasons.insert("MANUAL_BANK_OBSERVATION");
        }
        if (!window_start || !window_end) {
            reasons.insert("CONFIRMED_WITHOUT_REFUND_DATE");
        } else if (!bank->effective_date || *bank->effective_date < *window_start ||
                   *bank->effective_date >= *window_end) {
            reasons.insert("CONFIRMED_OUTSIDE_SEARCH_WINDOW");
        }
    }
    if (remaining == 0) {
        if (own_allocations.empty()) {
            reasons.insert("REFUND_ALLOCATED_TO_OTHER_ACCOUNT");
            return result(refund_fact_id, bank_account_ref_id, "MATCHED_ON_OTHER_ACCOUNT_BY_REVIEW",
                          refund_amount, reasons, {}, {}, 0, std::move(coverage));
        }
        return result(refund_fact_id, bank_account_ref_id, "MATCHED_BY_REVIEW", refund_amount, reasons,
                      {}, std::move(own_allocations), 0, std::move(coverage));
    }
    if (!recipient_matches) {
        const auto status = own_allocations.empty() ? "INSUFFICIENT_COVERAGE" : "PARTIALLY_MATCHED_BY_REVIEW";
        return result(refund_fact_id, bank_account_ref_id, status, refund_amount, reasons,
                      {}, std::move(own_allocations), remaining, std::move(coverage));
    }
    std::vector<const Fact*> candidates;
    if (window_start && window_end) {
        for (const auto& [bank_id, bank] : bank_facts) {
            if (bank->account_ref_id != bank_account_ref_id || !bank->effective_date ||
                *bank->effective_date < *window_start || *bank->effective_date >= *window_end ||
                active.contains({std::string(refund_fact_id), bank_id})) {
                continue;
            }
            std::int64_t bank_amount = 0;
            try {
                bank_amount = current_amount(*bank, corrections);
            } catch (const ScryerError& error) {
                if (error.code() != "UNRESOLVED_CORRECTION_CONFLICT") { throw; }
                reasons.insert(std::string(error.code()));
                return result(refund_fact_id, bank_account_ref_id, "CONTRADICTORY_EVIDENCE", refund_amount,
                              reasons, {}, std::move(own_allocations), remaining, std::move(coverage));
            }
            if (bank_amount > allocated_by_bank[bank_id]) {
                candidates.push_back(bank);
                if (bank->source.kind == "manual") {
                    reasons.insert("MANUAL_BANK_OBSERVATION");
                }
                if (static_cast<int>(candidates.size()) > candidate_limit) {
                    reasons.insert("CANDIDATE_LIMIT_EXCEEDED");
                    return result(refund_fact_id, bank_account_ref_id, "COMPUTATION_LIMIT", refund_amount,
                                  reasons, {}, std::move(own_allocations), remaining, std::move(coverage));
                }
            }
        }
    }
    std::sort(candidates.begin(), candidates.end(), [](const auto* left, const auto* right) {
        return std::tie(left->effective_date, left->fact_id) < std::tie(right->effective_date, right->fact_id);
    });
    std::vector<std::string> candidate_ids;
    for (const auto* bank : candidates) {
        candidate_ids.push_back(bank->fact_id);
    }
    std::string status;
    if (!own_allocations.empty()) {
        status = "PARTIALLY_MATCHED_BY_REVIEW";
    } else if (candidate_ids.size() > 1) {
        status = "AMBIGUOUS";
    } else if (!candidate_ids.empty()) {
        status = "SUGGESTED";
    } else if (coverage && coverage->status == "SUPPORTED_BY_UPLOADED_RECORDS") {
        status = "NO_CANDIDATE_IN_APPROVED_FACTS";
        reasons.insert("NOT_PROOF_OF_NONPAYMENT");
        reasons.insert("SOURCE_SET_MAY_BE_INCOMPLETE");
    } else {
        status = "INSUFFICIENT_COVERAGE";
    }
    return result(refund_fact_id, bank_account_ref_id, std::move(status), refund_amount, reasons,
                  std::move(candidate_ids), std::move(own_allocations), remaining, std::move(coverage));
}

}  // namespace scryer
