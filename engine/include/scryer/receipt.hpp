#pragma once

#include "scryer/case.hpp"

#include <string>
#include <string_view>

namespace scryer {

struct ReanalysisResult {
    std::string prior_digest;
    Json receipt;
};

[[nodiscard]] std::string sha256_hex(std::string_view bytes);
[[nodiscard]] Json make_receipt(
    const Case& case_data, Heads heads, std::string_view term_id,
    std::string_view producer_version = "native-0.1.0"
);
[[nodiscard]] Json reproduce_receipt(const Case& case_data, const Json& archived);
[[nodiscard]] ReanalysisResult reanalyze_receipt(const Case& case_data, const Json& archived, Heads new_heads);

}  // namespace scryer
