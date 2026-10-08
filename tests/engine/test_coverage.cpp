#include "scryer/case.hpp"
#include "scryer/coverage.hpp"
#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"

#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

void require(bool ok) {
    if (!ok) {
        throw std::runtime_error("coverage test assertion failed");
    }
}

template <class Callable>
void expect_error(std::string_view code, Callable&& action) {
    try {
        action();
    } catch (const scryer::ScryerError& error) {
        require(error.code() == code);
        return;
    }
    throw std::runtime_error("expected typed coverage error");
}

scryer::Json fixture(std::string_view name) {
    std::ifstream file("../tests/reference/fixtures/" + std::string(name) + ".json", std::ios::binary);
    require(file.good());
    return scryer::parse_document(std::string(std::istreambuf_iterator<char>(file), {}));
}

}  // namespace

int main() {
    const auto matching = scryer::parse_case(fixture("matching-case"));
    const std::vector<std::string> covered_head{"event-coverage"};
    const auto full = scryer::evaluate_bank_coverage(
        matching, covered_head, "bank-a", "2026-09-06", "2026-10-07"
    );
    require(full.status == "SUPPORTED_BY_UPLOADED_RECORDS");
    require(full.covered_intervals == std::vector<scryer::Interval>({{"2026-09-06", "2026-10-07"}}));
    require(full.missing_intervals.empty());
    require(full.assertion_ids == std::vector<std::string>{"coverage-a"});
    const auto gap = scryer::evaluate_bank_coverage(
        matching, covered_head, "bank-a", "2026-09-06", "2026-10-10"
    );
    require(gap.status == "INSUFFICIENT_COVERAGE");
    require(gap.missing_intervals == std::vector<scryer::Interval>({{"2026-10-07", "2026-10-10"}}));
    const std::vector<std::string> before_coverage{"event-bank-credit"};
    const auto no_period = scryer::evaluate_bank_coverage(
        matching, before_coverage, "bank-a", "2026-09-06", "2026-10-07"
    );
    require(no_period.status == "INSUFFICIENT_COVERAGE");
    require(no_period.covered_intervals.empty());
    expect_error("MISSING_ACCOUNT", [&] {
        (void)scryer::evaluate_bank_coverage(matching, covered_head, "absent", "2026-09-06", "2026-10-07");
    });
    expect_error("INVALID_COVERAGE_INTERVAL", [&] {
        (void)scryer::evaluate_bank_coverage(matching, covered_head, "bank-a", "2026-02-30", "2026-10-07");
    });

    auto manual_raw = fixture("matching-case");
    manual_raw["events"][7]["coverage"]["basis"] = "user_asserted";
    manual_raw["events"][7]["coverage"]["source"] = {{"kind", "manual"}, {"entryId", "manual-period"}};
    const auto manual = scryer::parse_case(manual_raw);
    require(scryer::evaluate_bank_coverage(
        manual, covered_head, "bank-a", "2026-09-06", "2026-10-07"
    ).status == "USER_ASSERTED");

    auto retracted_raw = fixture("matching-case");
    retracted_raw["events"].push_back({
        {"eventId", "event-retract"}, {"parents", scryer::Json::array({"event-coverage"})},
        {"recordedAt", "2026-10-09T10:00:00Z"}, {"kind", "retract_coverage"},
        {"retraction", {{"coverageId", "coverage-a"}, {"reason", "incorrect_period"},
                        {"reviewId", "review-retract"}}}
    });
    const auto retracted = scryer::parse_case(retracted_raw);
    const std::vector<std::string> after_retraction{"event-retract"};
    const auto retracted_result = scryer::evaluate_bank_coverage(
        retracted, after_retraction, "bank-a", "2026-09-06", "2026-10-07"
    );
    require(retracted_result.status == "INSUFFICIENT_COVERAGE");
    require(retracted_result.assertion_ids.empty());
}
