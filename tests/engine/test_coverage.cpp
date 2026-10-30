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
    expect_error("ACCOUNT_KIND_MISMATCH", [&] {
        (void)scryer::evaluate_bank_coverage(matching, covered_head, "school-a", "2026-09-06", "2026-10-07");
    });
    expect_error("INVALID_COVERAGE_INTERVAL", [&] {
        (void)scryer::evaluate_bank_coverage(matching, covered_head, "bank-a", "2026-10-07", "2026-09-06");
    });
    const auto both_sides = scryer::evaluate_bank_coverage(
        matching, covered_head, "bank-a", "2026-09-01", "2026-10-10"
    );
    require(both_sides.missing_intervals == std::vector<scryer::Interval>({
        {"2026-09-01", "2026-09-06"}, {"2026-10-07", "2026-10-10"}
    }));
    const auto outside = scryer::evaluate_bank_coverage(
        matching, covered_head, "bank-a", "2026-09-01", "2026-09-05"
    );
    require(outside.covered_intervals.empty());

    auto overlap_raw = fixture("matching-case");
    auto overlap = overlap_raw["events"][7];
    overlap["eventId"] = "event-overlap";
    overlap["parents"] = scryer::Json::array({"event-coverage"});
    overlap["coverage"]["coverageId"] = "coverage-overlap";
    overlap["coverage"]["reviewId"] = "review-overlap";
    overlap["coverage"]["startDate"] = "2026-09-20";
    overlap_raw["events"].push_back(overlap);
    const auto overlapping = scryer::parse_case(overlap_raw);
    const std::vector<std::string> overlap_head{"event-overlap"};
    const auto united = scryer::evaluate_bank_coverage(
        overlapping, overlap_head, "bank-a", "2026-09-06", "2026-10-07"
    );
    require(united.covered_intervals == std::vector<scryer::Interval>({{"2026-09-06", "2026-10-07"}}));
    require(united.assertion_ids == std::vector<std::string>({"coverage-a", "coverage-overlap"}));

    auto disjoint_raw = fixture("matching-case");
    auto disjoint = disjoint_raw["events"][7];
    disjoint["eventId"] = "event-disjoint";
    disjoint["parents"] = scryer::Json::array({"event-coverage"});
    disjoint["recordedAt"] = "2026-10-11T10:00:00Z";
    disjoint["coverage"]["coverageId"] = "coverage-disjoint";
    disjoint["coverage"]["reviewId"] = "review-disjoint";
    disjoint["coverage"]["startDate"] = "2026-10-08";
    disjoint["coverage"]["endDateExclusive"] = "2026-10-10";
    disjoint["coverage"]["basis"] = "user_asserted";
    disjoint["coverage"]["source"] = { {"kind", "manual"}, {"entryId", "coverage-gap"} };
    disjoint_raw["events"].push_back(disjoint);
    const auto separated = scryer::parse_case(disjoint_raw);
    const std::vector<std::string> disjoint_head{"event-disjoint"};
    const auto separated_result = scryer::evaluate_bank_coverage(
        separated, disjoint_head, "bank-a", "2026-09-06", "2026-10-10"
    );
    require(separated_result.covered_intervals.size() == 2);
    require(separated_result.missing_intervals == std::vector<scryer::Interval>({
        {"2026-10-07", "2026-10-08"}
    }));

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
