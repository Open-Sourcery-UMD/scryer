#include "scryer/case.hpp"
#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"
#include "scryer/projection.hpp"

#include <cstdint>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

namespace {

scryer::Json money(std::optional<std::int64_t> value) {
    return value ? scryer::Json(std::to_string(*value)) : scryer::Json(nullptr);
}

scryer::Json projection(const scryer::Projection& value) {
    return {
        {"status", value.status}, {"currency", value.currency}, {"amountMinor", money(value.amount_minor)},
        {"factIds", value.fact_ids}, {"limitationCodes", value.limitation_codes}, {"heads", value.heads}
    };
}

scryer::Json comparison(const scryer::Comparison& value) {
    scryer::Json contributions = scryer::Json::array();
    for (const auto& item : value.contributions) {
        contributions.push_back({
            {"factId", item.fact_id}, {"beforeMinor", std::to_string(item.before_minor)},
            {"afterMinor", std::to_string(item.after_minor)}, {"deltaMinor", std::to_string(item.delta_minor)}
        });
    }
    return {
        {"status", value.status}, {"deltaMinor", money(value.delta_minor)},
        {"before", projection(value.before)}, {"after", projection(value.after)},
        {"contributions", contributions}, {"limitationCodes", value.limitation_codes}
    };
}

scryer::Json evaluate(const scryer::Json& request) {
    const auto case_data = scryer::parse_case(request.at("case"));
    const auto operation = request.at("operation").get<std::string>();
    if (operation == "project") {
        const auto heads = request.at("heads").get<std::vector<std::string>>();
        return projection(scryer::project_school_surplus(case_data, heads, request.at("termId").get<std::string>()));
    }
    if (operation == "compare") {
        const auto before = request.at("beforeHeads").get<std::vector<std::string>>();
        const auto after = request.at("afterHeads").get<std::vector<std::string>>();
        return comparison(scryer::compare_school_surplus(case_data, before, after, request.at("termId").get<std::string>()));
    }
    if (operation == "history") {
        const auto result = scryer::heads_as_known(case_data, request.at("cutoffUtc").get<std::string>());
        return {{"status", result.status}, {"heads", result.heads}, {"reasonCodes", result.reason_codes}};
    }
    throw scryer::ScryerError("UNSUPPORTED_OPERATION");
}

}  // namespace

int main() {
    std::string line;
    while (std::getline(std::cin, line)) {
        try {
            std::cout << scryer::canonical_json(evaluate(scryer::parse_document(line))) << '\n';
        } catch (const scryer::ScryerError& error) {
            std::cout << scryer::canonical_json({{"error", error.code()}}) << '\n';
        }
    }
}
