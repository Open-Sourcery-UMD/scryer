#pragma once

#include "scryer/case.hpp"

#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace scryer {

using Interval = std::pair<std::string, std::string>;

struct CoverageResult {
    std::string account_ref_id;
    std::string start_date;
    std::string end_date_exclusive;
    std::string status;
    std::vector<Interval> covered_intervals;
    std::vector<Interval> missing_intervals;
    std::vector<std::string> assertion_ids;
    std::vector<std::string> limitation_codes;
};

[[nodiscard]] CoverageResult evaluate_bank_coverage(
    const Case& case_data, Heads heads, std::string_view account_ref_id,
    std::string_view start_date, std::string_view end_date_exclusive
);

}  // namespace scryer
