#pragma once

#include "scryer/case.hpp"
#include "scryer/coverage.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace scryer {

struct Allocation {
    std::string bank_fact_id;
    std::string bank_account_ref_id;
    std::int64_t allocated_minor;
    std::string decision_event_id;
};

struct MatchResult {
    std::string refund_fact_id;
    std::string bank_account_ref_id;
    std::string currency;
    std::string status;
    std::optional<std::int64_t> refund_amount_minor;
    std::vector<std::string> candidate_fact_ids;
    std::vector<Allocation> confirmed_allocations;
    std::optional<std::int64_t> remaining_minor;
    std::optional<CoverageResult> coverage;
    std::vector<std::string> reason_codes;
};

[[nodiscard]] MatchResult suggest_refund_deposits(
    const Case& case_data, Heads heads, std::string_view refund_fact_id,
    std::string_view bank_account_ref_id, int candidate_limit = 1000, int window_days = 30
);

}  // namespace scryer
