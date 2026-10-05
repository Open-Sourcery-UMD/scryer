#include "scryer/case.hpp"
#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"
#include "scryer/matching.hpp"

#include <algorithm>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

void require(bool ok) {
    if (!ok) {
        throw std::runtime_error("matching test assertion failed");
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
    throw std::runtime_error("expected typed matching error");
}

scryer::Json fixture(std::string_view name) {
    std::ifstream file("../tests/reference/fixtures/" + std::string(name) + ".json", std::ios::binary);
    require(file.good());
    return scryer::parse_document(std::string(std::istreambuf_iterator<char>(file), {}));
}

}  // namespace

int main() {
    const auto matching = scryer::parse_case(fixture("matching-case"));
    const std::vector<std::string> coverage_head{"event-coverage"};
    const std::vector<std::string> confirm_head{"event-confirm"};
    const auto suggested = scryer::suggest_refund_deposits(
        matching, coverage_head, "issued-refund", "bank-a"
    );
    require(suggested.status == "SUGGESTED");
    require(suggested.candidate_fact_ids == std::vector<std::string>{"bank-credit"});
    require(suggested.remaining_minor == 90000 && suggested.coverage);
    require(suggested.coverage->status == "SUPPORTED_BY_UPLOADED_RECORDS");
    const auto reviewed = scryer::suggest_refund_deposits(
        matching, confirm_head, "issued-refund", "bank-a"
    );
    require(reviewed.status == "MATCHED_BY_REVIEW" && reviewed.remaining_minor == 0);
    require(reviewed.confirmed_allocations.size() == 1);
    require(reviewed.confirmed_allocations[0].allocated_minor == 90000);
    expect_error("INVALID_CANDIDATE_LIMIT", [&] {
        (void)scryer::suggest_refund_deposits(matching, coverage_head, "issued-refund", "bank-a", 0);
    });
    expect_error("INVALID_MATCH_WINDOW", [&] {
        (void)scryer::suggest_refund_deposits(matching, coverage_head, "issued-refund", "bank-a", 1000, 91);
    });
    expect_error("INVALID_CANDIDATE_LIMIT", [&] {
        (void)scryer::suggest_refund_deposits(matching, coverage_head, "issued-refund", "bank-a", 10001);
    });
    expect_error("INVALID_MATCH_WINDOW", [&] {
        (void)scryer::suggest_refund_deposits(matching, coverage_head, "issued-refund", "bank-a", 1000, -1);
    });
    expect_error("MISSING_ACCOUNT", [&] {
        (void)scryer::suggest_refund_deposits(matching, coverage_head, "issued-refund", "bank-missing");
    });
    expect_error("ACCOUNT_KIND_MISMATCH", [&] {
        (void)scryer::suggest_refund_deposits(matching, coverage_head, "issued-refund", "school-a");
    });
    expect_error("MISSING_FACT_IN_SNAPSHOT", [&] {
        (void)scryer::suggest_refund_deposits(matching, coverage_head, "refund-missing", "bank-a");
    });
    expect_error("MATCH_ROLE_MISMATCH", [&] {
        (void)scryer::suggest_refund_deposits(matching, coverage_head, "grant", "bank-a");
    });

    auto cancelled_raw = fixture("matching-case");
    cancelled_raw["events"].push_back({
        {"eventId", "event-refund-cancel"},
        {"parents", scryer::Json::array({"event-refund-issued", "event-coverage"})},
        {"recordedAt", "2026-10-10T10:00:00Z"}, {"kind", "correct_fact"},
        {"correction", {{"factId", "issued-refund"}, {"replacementAmountMinor", nullptr},
                        {"cancelled", true},
                        {"source", {{"kind", "artifact"}, {"artifactId", "refund-a"},
                                    {"location", "page:1-cancelled"}}},
                        {"reviewId", "review-refund-cancel"}}}
    });
    const auto cancelled = scryer::parse_case(cancelled_raw);
    const std::vector<std::string> cancelled_head{"event-refund-cancel"};
    const auto cancelled_result = scryer::suggest_refund_deposits(
        cancelled, cancelled_head, "issued-refund", "bank-a"
    );
    require(cancelled_result.status == "REFUND_CANCELLED" && cancelled_result.remaining_minor == 0);

    auto undated_raw = fixture("matching-case");
    undated_raw["events"][5]["fact"]["effectiveDate"] = nullptr;
    const auto undated = scryer::parse_case(undated_raw);
    const auto undated_result = scryer::suggest_refund_deposits(
        undated, coverage_head, "issued-refund", "bank-a"
    );
    require(undated_result.status == "INSUFFICIENT_COVERAGE");
    require(std::find(undated_result.reason_codes.begin(), undated_result.reason_codes.end(),
                      "MISSING_REFUND_DATE") != undated_result.reason_codes.end());

    auto manual_raw = fixture("matching-case");
    manual_raw["events"][6]["fact"]["source"] = {
        {"kind", "manual"}, {"entryId", "entry-bank-credit"}
    };
    const auto manual = scryer::parse_case(manual_raw);
    const auto manual_result = scryer::suggest_refund_deposits(
        manual, coverage_head, "issued-refund", "bank-a"
    );
    require(manual_result.status == "SUGGESTED");
    require(std::find(manual_result.reason_codes.begin(), manual_result.reason_codes.end(),
                      "MANUAL_BANK_OBSERVATION") != manual_result.reason_codes.end());

    auto competing_decisions_raw = fixture("matching-case");
    auto parallel_rejection = competing_decisions_raw["events"][8];
    parallel_rejection["eventId"] = "event-parallel-rejection";
    parallel_rejection["decision"]["action"] = "reject";
    parallel_rejection["decision"]["allocatedMinor"] = "0";
    parallel_rejection["decision"]["reviewId"] = "review-parallel-rejection";
    competing_decisions_raw["events"].push_back(parallel_rejection);
    const auto competing_decisions = scryer::parse_case(competing_decisions_raw);
    const std::vector<std::string> competing_decision_heads{
        "event-confirm", "event-parallel-rejection"
    };
    const auto competing_result = scryer::suggest_refund_deposits(
        competing_decisions, competing_decision_heads,
        "issued-refund", "bank-a"
    );
    require(competing_result.status == "CONTRADICTORY_EVIDENCE");
    require(std::find(competing_result.reason_codes.begin(), competing_result.reason_codes.end(),
                      "CONFLICTING_MATCH_DECISIONS") != competing_result.reason_codes.end());

    auto superseded_raw = fixture("matching-case");
    auto reviewed_rejection = superseded_raw["events"][8];
    reviewed_rejection["eventId"] = "event-reviewed-rejection";
    reviewed_rejection["parents"] = scryer::Json::array({
        "event-refund-issued", "event-bank-credit", "event-confirm"
    });
    reviewed_rejection["recordedAt"] = "2026-10-10T10:00:00Z";
    reviewed_rejection["decision"]["action"] = "reject";
    reviewed_rejection["decision"]["allocatedMinor"] = "0";
    reviewed_rejection["decision"]["reviewId"] = "review-reviewed-rejection";
    superseded_raw["events"].push_back(reviewed_rejection);
    const auto superseded = scryer::parse_case(superseded_raw);
    const std::vector<std::string> superseded_head{"event-reviewed-rejection"};
    const auto superseded_result = scryer::suggest_refund_deposits(
        superseded, superseded_head, "issued-refund", "bank-a"
    );
    require(superseded_result.status == "NO_CANDIDATE_IN_APPROVED_FACTS");

    auto competing_corrections_raw = fixture("matching-case");
    for (const auto& suffix : {"a", "b"}) {
        const std::string ending = suffix;
        competing_corrections_raw["events"].push_back({
            {"eventId", "event-refund-correction-" + ending},
            {"parents", scryer::Json::array({"event-refund-issued", "event-coverage"})},
            {"recordedAt", "2026-10-10T10:00:00Z"}, {"kind", "correct_fact"},
            {"correction", {{"factId", "issued-refund"},
                            {"replacementAmountMinor", ending == "a" ? "80000" : "70000"},
                            {"cancelled", false},
                            {"source", {{"kind", "artifact"}, {"artifactId", "refund-a"},
                                        {"location", "page:1-revised-" + ending}}},
                            {"reviewId", "review-refund-correction-" + ending}}}
        });
    }
    const auto competing_corrections = scryer::parse_case(competing_corrections_raw);
    const std::vector<std::string> competing_correction_heads{
        "event-refund-correction-a", "event-refund-correction-b"
    };
    const auto correction_result = scryer::suggest_refund_deposits(
        competing_corrections, competing_correction_heads,
        "issued-refund", "bank-a"
    );
    require(correction_result.status == "CONTRADICTORY_EVIDENCE");
    require(std::find(correction_result.reason_codes.begin(), correction_result.reason_codes.end(),
                      "UNRESOLVED_CORRECTION_CONFLICT") != correction_result.reason_codes.end());

    const auto split = scryer::parse_case(fixture("split-case"));
    const auto ambiguous = scryer::suggest_refund_deposits(split, coverage_head, "issued-refund", "bank-a");
    require(ambiguous.status == "AMBIGUOUS" && ambiguous.candidate_fact_ids.size() == 2);
    const auto limited = scryer::suggest_refund_deposits(split, coverage_head, "issued-refund", "bank-a", 1);
    require(limited.status == "COMPUTATION_LIMIT");
    const std::vector<std::string> partial_head{"event-confirm-a"};
    const auto partial = scryer::suggest_refund_deposits(split, partial_head, "issued-refund", "bank-a");
    require(partial.status == "PARTIALLY_MATCHED_BY_REVIEW" && partial.remaining_minor == 50000);
    require(partial.confirmed_allocations.size() == 1);
    const std::vector<std::string> full_head{"event-confirm-b"};
    const auto full = scryer::suggest_refund_deposits(split, full_head, "issued-refund", "bank-a");
    require(full.status == "MATCHED_BY_REVIEW" && full.remaining_minor == 0);
    require(full.confirmed_allocations.size() == 2);

    const auto recipient = scryer::parse_case(fixture("recipient-case"));
    const auto suppressed = scryer::suggest_refund_deposits(recipient, coverage_head, "issued-refund", "bank-a");
    require(suppressed.status == "INSUFFICIENT_COVERAGE" && suppressed.candidate_fact_ids.empty());
    require(suppressed.reason_codes == std::vector<std::string>({
        "HEURISTIC_DATE_WINDOW", "RECIPIENT_METADATA_USER_REVIEWED", "RECIPIENT_MISMATCH",
        "SOURCE_AUTHENTICITY_NOT_VERIFIED"
    }));
    const auto exception = scryer::suggest_refund_deposits(recipient, confirm_head, "issued-refund", "bank-a");
    require(exception.status == "MATCHED_BY_REVIEW" && exception.remaining_minor == 0);
    require(exception.confirmed_allocations.size() == 1);
    require(std::find(exception.reason_codes.begin(), exception.reason_codes.end(),
                      "RECIPIENT_EXCEPTION_SOURCE_REVIEWED") != exception.reason_codes.end());

    auto unknown_raw = fixture("matching-case");
    unknown_raw["accountRefs"][1]["holderKind"] = "unknown";
    unknown_raw["events"].erase(unknown_raw["events"].end() - 1);
    const auto unknown = scryer::parse_case(unknown_raw);
    const auto unknown_result = scryer::suggest_refund_deposits(unknown, coverage_head, "issued-refund", "bank-a");
    require(unknown_result.status == "INSUFFICIENT_COVERAGE");
    require(unknown_result.candidate_fact_ids.empty());

    auto over_raw = fixture("matching-case");
    over_raw["events"][8]["decision"]["allocatedMinor"] = "100000";
    const auto overallocated = scryer::parse_case(over_raw);
    const auto over_result = scryer::suggest_refund_deposits(overallocated, confirm_head, "issued-refund", "bank-a");
    require(over_result.status == "CONTRADICTORY_EVIDENCE");
    require(std::find(over_result.reason_codes.begin(), over_result.reason_codes.end(),
                      "BANK_OVERALLOCATED") != over_result.reason_codes.end());

    auto rejected_raw = fixture("matching-case");
    rejected_raw["events"][8]["decision"]["action"] = "reject";
    rejected_raw["events"][8]["decision"]["allocatedMinor"] = "0";
    const auto rejected = scryer::parse_case(rejected_raw);
    const auto no_candidate = scryer::suggest_refund_deposits(rejected, confirm_head, "issued-refund", "bank-a");
    require(no_candidate.status == "NO_CANDIDATE_IN_APPROVED_FACTS");
    require(no_candidate.candidate_fact_ids.empty());

    auto corrected_raw = fixture("matching-case");
    corrected_raw["events"].push_back({
        {"eventId", "event-bank-correction"},
        {"parents", scryer::Json::array({"event-bank-credit", "event-confirm"})},
        {"recordedAt", "2026-10-10T10:00:00Z"}, {"kind", "correct_fact"},
        {"correction", {{"factId", "bank-credit"}, {"replacementAmountMinor", "60000"},
                        {"cancelled", false},
                        {"source", {{"kind", "artifact"}, {"artifactId", "bank-a"},
                                    {"location", "row:1-revised"}}},
                        {"reviewId", "review-bank-correction"}}}
    });
    const auto corrected = scryer::parse_case(corrected_raw);
    const std::vector<std::string> corrected_head{"event-bank-correction"};
    const auto corrected_result = scryer::suggest_refund_deposits(
        corrected, corrected_head, "issued-refund", "bank-a"
    );
    require(corrected_result.status == "CONTRADICTORY_EVIDENCE");
    require(std::find(corrected_result.reason_codes.begin(), corrected_result.reason_codes.end(),
                      "BANK_OVERALLOCATED") != corrected_result.reason_codes.end());

    auto other_account_raw = fixture("matching-case");
    other_account_raw["accountRefs"].push_back({
        {"accountRefId", "bank-b"}, {"kind", "bank"}, {"institutionId", nullptr},
        {"holderKind", "student"}
    });
    const auto other_account = scryer::parse_case(other_account_raw);
    const auto other_account_result = scryer::suggest_refund_deposits(
        other_account, confirm_head, "issued-refund", "bank-b"
    );
    require(other_account_result.status == "MATCHED_ON_OTHER_ACCOUNT_BY_REVIEW");
    require(other_account_result.confirmed_allocations.empty());
}
