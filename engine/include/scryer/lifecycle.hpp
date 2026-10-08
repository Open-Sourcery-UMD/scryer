#pragma once

#include "scryer/case.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace scryer {

struct LifecycleObservation {
    std::string fact_id;
    std::string role;
    std::int64_t current_amount_minor;
    std::string source_kind;
    std::string approval_event_id;
};

struct LifecycleResult {
    std::string case_id;
    std::vector<std::string> heads;
    std::string term_id;
    std::string aid_item_id;
    std::string recipient_kind;
    std::string status;
    std::optional<std::int64_t> current_offer_minor;
    std::optional<std::int64_t> current_accepted_minor;
    std::optional<std::int64_t> current_pending_minor;
    std::optional<std::int64_t> posted_minor;
    std::vector<LifecycleObservation> observations;
    std::vector<std::string> finding_codes;
    std::vector<std::string> next_action_codes;
    std::vector<std::string> limitation_codes;
    std::optional<std::int64_t> gross_disbursed_minor;
    std::optional<std::int64_t> withheld_fee_minor;
    std::optional<std::int64_t> unexplained_difference_minor;
};

[[nodiscard]] LifecycleResult project_aid_lifecycle(
    const Case& case_data, Heads heads, std::string_view term_id, std::string_view aid_item_id
);

}  // namespace scryer
