#pragma once

#include "scryer/case.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace scryer {

struct Projection {
    std::string case_id;
    std::vector<std::string> heads;
    std::string term_id;
    std::string currency;
    std::string status;
    std::optional<std::int64_t> amount_minor;
    std::vector<std::string> fact_ids;
    std::vector<std::string> limitation_codes;
};

struct Contribution {
    std::string fact_id;
    std::int64_t before_minor;
    std::int64_t after_minor;
    std::int64_t delta_minor;
};

struct Comparison {
    std::string status;
    Projection before;
    Projection after;
    std::optional<std::int64_t> delta_minor;
    std::vector<Contribution> contributions;
    std::vector<std::string> limitation_codes;
};

[[nodiscard]] Projection project_school_surplus(const Case& case_data, Heads heads, std::string_view term_id);
[[nodiscard]] Comparison compare_school_surplus(
    const Case& case_data, Heads before_heads, Heads after_heads, std::string_view term_id
);

}  // namespace scryer
