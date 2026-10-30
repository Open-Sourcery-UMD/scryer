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

    // A deposit reviewed for another refund must not be suggested a second time.
    auto shared_deposit_raw = fixture("matching-case");
    auto second_refund = shared_deposit_raw["events"][5];
    second_refund["eventId"] = "event-other-refund";
    second_refund["parents"] = scryer::Json::array({"event-coverage"});
    second_refund["recordedAt"] = "2026-10-08T11:00:00Z";
    second_refund["fact"]["factId"] = "other-refund";
    second_refund["fact"]["source"]["location"] = "page:2";
    second_refund["fact"]["reviewId"] = "review-other-refund";
    shared_deposit_raw["events"].push_back(second_refund);
    auto other_confirm = shared_deposit_raw["events"][8];
    other_confirm["eventId"] = "event-other-confirm";
    other_confirm["parents"] = scryer::Json::array({"event-other-refund", "event-bank-credit"});
    other_confirm["recordedAt"] = "2026-10-09T11:00:00Z";
    other_confirm["decision"]["refundFactId"] = "other-refund";
    other_confirm["decision"]["reviewId"] = "review-other-confirm";
    shared_deposit_raw["events"].push_back(other_confirm);
    const std::vector<std::string> other_confirm_head{"event-other-confirm"};
    const auto shared_deposit = scryer::parse_case(shared_deposit_raw);
    const auto already_used = scryer::suggest_refund_deposits(
        shared_deposit, other_confirm_head, "issued-refund", "bank-a"
    );
    require(already_used.status == "NO_CANDIDATE_IN_APPROVED_FACTS");
    require(already_used.candidate_fact_ids.empty());
    require(already_used.remaining_minor == 90000);

    shared_deposit_raw["events"][9]["fact"]["amountMinor"] = "80000";
    const auto overallocated_other = scryer::parse_case(shared_deposit_raw);
    const auto overallocated_other_result = scryer::suggest_refund_deposits(
        overallocated_other, other_confirm_head, "issued-refund", "bank-a"
    );
    require(overallocated_other_result.status == "CONTRADICTORY_EVIDENCE");
    require(std::find(overallocated_other_result.reason_codes.begin(), overallocated_other_result.reason_codes.end(),
                      "REFUND_OVERALLOCATED") != overallocated_other_result.reason_codes.end());

    // A review of another refund on another bank account must not consume this account's candidate.
    shared_deposit_raw["events"][9]["fact"]["amountMinor"] = "90000";
    shared_deposit_raw["accountRefs"].push_back({
        {"accountRefId", "bank-b"}, {"kind", "bank"}, {"institutionId", nullptr},
        {"holderKind", "student"}
    });
    auto other_bank_credit = shared_deposit_raw["events"][6];
    other_bank_credit["eventId"] = "event-other-bank-credit";
    other_bank_credit["parents"] = scryer::Json::array({"event-coverage"});
    other_bank_credit["recordedAt"] = "2026-10-08T12:00:00Z";
    other_bank_credit["fact"]["factId"] = "other-bank-credit";
    other_bank_credit["fact"]["accountRefId"] = "bank-b";
    other_bank_credit["fact"]["source"] = {{"kind", "manual"}, {"entryId", "entry-other-bank"}};
    other_bank_credit["fact"]["reviewId"] = "review-other-bank-credit";
    shared_deposit_raw["events"].push_back(other_bank_credit);
    auto other_bank_confirm = other_confirm;
    other_bank_confirm["eventId"] = "event-other-bank-confirm";
    other_bank_confirm["parents"] = scryer::Json::array({"event-other-refund", "event-other-bank-credit"});
    other_bank_confirm["recordedAt"] = "2026-10-09T12:00:00Z";
    other_bank_confirm["decision"]["bankFactId"] = "other-bank-credit";
    other_bank_confirm["decision"]["reviewId"] = "review-other-bank-confirm";
    shared_deposit_raw["events"].push_back(other_bank_confirm);
    const auto independent_bank = scryer::parse_case(shared_deposit_raw);
    const std::vector<std::string> other_bank_head{"event-other-bank-confirm"};
    const auto unaffected = scryer::suggest_refund_deposits(
        independent_bank, other_bank_head, "issued-refund", "bank-a"
    );
    require(unaffected.status == "SUGGESTED");
    require(unaffected.candidate_fact_ids == std::vector<std::string>{"bank-credit"});

    auto too_late_raw = fixture("matching-case");
    too_late_raw["events"][5]["fact"]["effectiveDate"] = "9999-12-31";
    const auto too_late = scryer::parse_case(too_late_raw);
    expect_error("UNSUPPORTED_DATE_RANGE", [&] {
        (void)scryer::suggest_refund_deposits(too_late, coverage_head, "issued-refund", "bank-a");
    });

    auto undated_confirmed_raw = fixture("matching-case");
    undated_confirmed_raw["events"][5]["fact"]["effectiveDate"] = nullptr;
    const auto undated_confirmed = scryer::parse_case(undated_confirmed_raw);
    const auto date_missing = scryer::suggest_refund_deposits(
        undated_confirmed, confirm_head, "issued-refund", "bank-a");
    require(date_missing.status == "MATCHED_BY_REVIEW");
    require(std::find(date_missing.reason_codes.begin(), date_missing.reason_codes.end(),
                      "CONFIRMED_WITHOUT_REFUND_DATE") != date_missing.reason_codes.end());

    auto out_of_window_raw = fixture("matching-case");
    out_of_window_raw["events"][6]["fact"]["effectiveDate"] = "2026-10-08";
    const auto out_of_window = scryer::parse_case(out_of_window_raw);
    const auto outside = scryer::suggest_refund_deposits(
        out_of_window, confirm_head, "issued-refund", "bank-a");
    require(outside.status == "MATCHED_BY_REVIEW");
    require(std::find(outside.reason_codes.begin(), outside.reason_codes.end(),
                      "CONFIRMED_OUTSIDE_SEARCH_WINDOW") != outside.reason_codes.end());
    auto undated_bank_raw = fixture("matching-case");
    undated_bank_raw["events"][6]["fact"]["effectiveDate"] = nullptr;
    const auto undated_bank = scryer::parse_case(undated_bank_raw);
    const auto bank_without_date = scryer::suggest_refund_deposits(
        undated_bank, confirm_head, "issued-refund", "bank-a");
    require(std::find(bank_without_date.reason_codes.begin(), bank_without_date.reason_codes.end(),
                      "CONFIRMED_OUTSIDE_SEARCH_WINDOW") != bank_without_date.reason_codes.end());

    auto partial_recipient_raw = fixture("recipient-case");
    partial_recipient_raw["events"][8]["decision"]["allocatedMinor"] = "50000";
    const auto partial_recipient = scryer::parse_case(partial_recipient_raw);
    const auto recipient_partial = scryer::suggest_refund_deposits(
        partial_recipient, confirm_head, "issued-refund", "bank-a");
    require(recipient_partial.status == "PARTIALLY_MATCHED_BY_REVIEW");
    require(recipient_partial.remaining_minor == 40000);

    auto refund_over_raw = fixture("split-case");
    refund_over_raw["events"][5]["fact"]["amountMinor"] = "80000";
    const auto refund_over = scryer::parse_case(refund_over_raw);
    const auto overallocated_refund = scryer::suggest_refund_deposits(
        refund_over, full_head, "issued-refund", "bank-a");
    require(overallocated_refund.status == "CONTRADICTORY_EVIDENCE");
    require(std::find(overallocated_refund.reason_codes.begin(), overallocated_refund.reason_codes.end(),
                      "REFUND_OVERALLOCATED") != overallocated_refund.reason_codes.end());

    auto user_coverage_raw = fixture("matching-case");
    user_coverage_raw["events"][7]["coverage"]["basis"] = "user_asserted";
    user_coverage_raw["events"][7]["coverage"]["source"] = {
        {"kind", "manual"}, {"entryId", "coverage-entry"}
    };
    const auto user_coverage = scryer::parse_case(user_coverage_raw);
    const auto asserted = scryer::suggest_refund_deposits(
        user_coverage, coverage_head, "issued-refund", "bank-a");
    require(std::find(asserted.reason_codes.begin(), asserted.reason_codes.end(),
                      "USER_ASSERTED_COVERAGE") != asserted.reason_codes.end());

    auto competing_bank_raw = fixture("matching-case");
    for (const auto& suffix : {"a", "b"}) {
        const std::string ending = suffix;
        competing_bank_raw["events"].push_back({
            {"eventId", "event-bank-correction-" + ending},
            {"parents", scryer::Json::array({"event-bank-credit", "event-coverage"})},
            {"recordedAt", "2026-10-10T10:00:00Z"}, {"kind", "correct_fact"},
            {"correction", {{"factId", "bank-credit"},
                            {"replacementAmountMinor", ending == "a" ? "80000" : "70000"},
                            {"cancelled", false},
                            {"source", {{"kind", "artifact"}, {"artifactId", "bank-a"},
                                        {"location", "row:1-revised-" + ending}}},
                            {"reviewId", "review-bank-correction-" + ending}}}
        });
    }
    const auto competing_bank = scryer::parse_case(competing_bank_raw);
    const std::vector<std::string> competing_bank_heads{
        "event-bank-correction-a", "event-bank-correction-b"
    };
    const auto bank_conflict = scryer::suggest_refund_deposits(
        competing_bank, competing_bank_heads, "issued-refund", "bank-a");
    require(bank_conflict.status == "CONTRADICTORY_EVIDENCE");
    require(std::find(bank_conflict.reason_codes.begin(), bank_conflict.reason_codes.end(),
                      "UNRESOLVED_CORRECTION_CONFLICT") != bank_conflict.reason_codes.end());
}
