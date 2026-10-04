#include "scryer/coverage.hpp"

#include "scryer/error.hpp"

#include <algorithm>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace scryer {
namespace {

std::vector<Interval> unite(std::vector<Interval> intervals) {
    std::sort(intervals.begin(), intervals.end());
    std::vector<Interval> merged;
    for (auto& interval : intervals) {
        if (!merged.empty() && interval.first <= merged.back().second) {
            merged.back().second = std::max(merged.back().second, interval.second);
        } else {
            merged.push_back(std::move(interval));
        }
    }
    return merged;
}

std::vector<Interval> missing(std::string_view start, std::string_view end, const std::vector<Interval>& covered) {
    std::vector<Interval> gaps;
    std::string cursor(start);
    for (const auto& interval : covered) {
        if (cursor < interval.first) {
            gaps.emplace_back(cursor, interval.first);
        }
        cursor = std::max(cursor, interval.second);
    }
    if (cursor < end) {
        gaps.emplace_back(cursor, std::string(end));
    }
    return gaps;
}

}  // namespace

CoverageResult evaluate_bank_coverage(
    const Case& case_data, Heads heads, std::string_view account_ref_id,
    std::string_view start_date, std::string_view end_date_exclusive
) {
    const auto account = std::find_if(case_data.account_refs.begin(), case_data.account_refs.end(),
        [account_ref_id](const auto& item) { return item.account_ref_id == account_ref_id; });
    if (account == case_data.account_refs.end()) {
        throw ScryerError("MISSING_ACCOUNT");
    }
    if (account->kind != "bank") {
        throw ScryerError("ACCOUNT_KIND_MISMATCH");
    }
    std::string start;
    std::string end;
    try {
        start = canonical_date(start_date);
        end = canonical_date(end_date_exclusive);
    } catch (const ScryerError& error) {
        if (error.code() != "INVALID_DATE") {
            throw;
        }
        throw ScryerError("INVALID_COVERAGE_INTERVAL");
    }
    if (start >= end) {
        throw ScryerError("INVALID_COVERAGE_INTERVAL");
    }
    const auto events = snapshot(case_data, heads);
    std::set<std::string> retracted;
    for (const auto* event : events) {
        if (event->retraction) {
            retracted.insert(event->retraction->coverage_id);
        }
    }
    std::vector<Interval> covered;
    std::vector<Interval> source_covered;
    std::vector<std::string> assertion_ids;
    for (const auto* event : events) {
        if (!event->coverage) {
            continue;
        }
        const auto& assertion = *event->coverage;
        if (assertion.account_ref_id != account_ref_id || assertion.record_type != "bank_transactions" ||
            retracted.contains(assertion.coverage_id)) {
            continue;
        }
        const auto clipped_start = std::max(start, assertion.start_date);
        const auto clipped_end = std::min(end, assertion.end_date_exclusive);
        if (clipped_start >= clipped_end) {
            continue;
        }
        covered.emplace_back(clipped_start, clipped_end);
        if (assertion.basis == "source_asserted") {
            source_covered.emplace_back(clipped_start, clipped_end);
        }
        assertion_ids.push_back(assertion.coverage_id);
    }
    covered = unite(std::move(covered));
    source_covered = unite(std::move(source_covered));
    auto gaps = missing(start, end, covered);
    const auto source_gaps = missing(start, end, source_covered);
    const std::string status = !gaps.empty() ? "INSUFFICIENT_COVERAGE" :
                               source_gaps.empty() ? "SUPPORTED_BY_UPLOADED_RECORDS" : "USER_ASSERTED";
    std::vector<std::string> limitations{"SOURCE_AUTHENTICITY_NOT_VERIFIED"};
    if (!gaps.empty()) {
        limitations.insert(limitations.begin(), "COVERAGE_GAP");
    }
    if (status == "USER_ASSERTED") {
        limitations.push_back("USER_ASSERTED_COVERAGE");
    }
    std::sort(assertion_ids.begin(), assertion_ids.end());
    return {std::string(account_ref_id), std::move(start), std::move(end), status,
            std::move(covered), std::move(gaps), std::move(assertion_ids), std::move(limitations)};
}

}  // namespace scryer
