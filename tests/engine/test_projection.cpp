#include "scryer/case.hpp"
#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"
#include "scryer/projection.hpp"

#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

void require(bool ok) {
    if (!ok) {
        throw std::runtime_error("projection test assertion failed");
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
    throw std::runtime_error("expected typed projection error");
}

scryer::Json fixture(std::string_view name) {
    std::ifstream file("../tests/reference/fixtures/" + std::string(name) + ".json", std::ios::binary);
    require(file.good());
    return scryer::parse_document(std::string(std::istreambuf_iterator<char>(file), {}));
}

const scryer::Contribution& contribution(const scryer::Comparison& comparison, std::string_view fact_id) {
    for (const auto& item : comparison.contributions) {
        if (item.fact_id == fact_id) {
            return item;
        }
    }
    throw std::runtime_error("missing contribution");
}

}  // namespace

int main() {
    using scryer::compare_school_surplus;
    using scryer::parse_case;
    using scryer::project_school_surplus;
    const auto golden = parse_case(fixture("golden-case"));
    const std::vector<std::string> before{"event-base-charge"};
    const std::vector<std::string> after{"event-extra-charge"};
    const auto first = project_school_surplus(golden, before, "2026-fall");
    require(first.status == "SUPPORTED_BY_UPLOADED_RECORDS" && first.amount_minor == 150000);
    require(first.fact_ids == std::vector<std::string>({"base-charge", "grant", "other-credit"}));
    const auto second = project_school_surplus(golden, after, "2026-fall");
    require(second.amount_minor == 90000);
    const auto change = compare_school_surplus(golden, before, after, "2026-fall");
    require(change.delta_minor == -60000 && change.contributions.size() == 2);
    require(contribution(change, "grant").delta_minor == -30000);
    require(contribution(change, "extra-charge").delta_minor == -30000);
    const std::vector<std::string> empty;
    const auto no_facts = project_school_surplus(golden, empty, "2026-fall");
    require(no_facts.status == "INSUFFICIENT_COVERAGE" && !no_facts.amount_minor);
    expect_error("MISSING_TERM", [&] { (void)project_school_surplus(golden, before, "unknown"); });
    const std::vector<std::string> bank_head{"event-bank-credit"};
    const auto unrelated = compare_school_surplus(golden, after, bank_head, "2026-fall");
    require(unrelated.delta_minor == 0 && unrelated.contributions.empty());

    const auto reversal = parse_case(fixture("reversal-case"));
    const std::vector<std::string> corrected{"event-grant-correction-v2"};
    const std::vector<std::string> canceled{"event-charge-cancel"};
    require(project_school_surplus(reversal, after, "2026-fall").amount_minor == 90000);
    require(project_school_surplus(reversal, corrected, "2026-fall").amount_minor == 70000);
    require(project_school_surplus(reversal, canceled, "2026-fall").amount_minor == 100000);
    const auto reversal_delta = compare_school_surplus(reversal, after, canceled, "2026-fall");
    require(reversal_delta.delta_minor == 10000 && reversal_delta.contributions.size() == 2);
    require(contribution(reversal_delta, "grant").delta_minor == -20000);
    require(contribution(reversal_delta, "extra-charge").delta_minor == 30000);

    const auto manual = parse_case(fixture("manual-case"));
    require(project_school_surplus(manual, before, "2026-fall").status == "USER_ASSERTED");
    const auto ambiguous = parse_case(fixture("ambiguous-case"));
    const std::vector<std::string> divergent{"event-grant-correction", "event-grant-correction-b"};
    const auto conflict = project_school_surplus(ambiguous, divergent, "2026-fall");
    require(conflict.status == "CONTRADICTORY_EVIDENCE" && !conflict.amount_minor);
    require(conflict.fact_ids == first.fact_ids);
    const auto blocked = compare_school_surplus(ambiguous, before, divergent, "2026-fall");
    require(blocked.status == "CONTRADICTORY_EVIDENCE" && !blocked.delta_minor);
    auto joined_conflict_raw = fixture("ambiguous-case");
    joined_conflict_raw["events"].push_back(scryer::Json{{"eventId", "event-join"},
        {"parents", scryer::Json::array({"event-bank-credit", "event-grant-correction-b"})},
        {"recordedAt", "2026-10-04T12:00:00Z"}, {"kind", "resolve_branches"},
        {"resolution", scryer::Json{{"reviewId", "review-join"}}}});
    const auto joined_conflict = parse_case(joined_conflict_raw);
    const std::vector<std::string> join_head{"event-join"};
    const auto still_conflicted = project_school_surplus(joined_conflict, join_head, "2026-fall");
    require(still_conflicted.status == "CONTRADICTORY_EVIDENCE" && !still_conflicted.amount_minor);

    auto high = fixture("golden-case");
    high["events"][0]["fact"]["amountMinor"] = "9223372036854775807";
    high["events"][1]["fact"]["amountMinor"] = "1";
    high["events"][2]["fact"]["amountMinor"] = "0";
    const auto overflow = parse_case(high);
    expect_error("MONEY_OVERFLOW", [&] { (void)project_school_surplus(overflow, before, "2026-fall"); });

    auto net_fits = high;
    auto tail = net_fits["events"][2];
    tail["eventId"] = "event-tail-charge";
    tail["parents"] = scryer::Json::array({"event-base-charge"});
    tail["fact"]["factId"] = "zz-charge";
    tail["fact"]["reviewId"] = "review-tail-charge";
    tail["fact"]["amountMinor"] = "1";
    tail["fact"]["source"]["location"] = "row:tail";
    net_fits["events"].push_back(tail);
    const auto intermediate_overflow = parse_case(net_fits);
    const std::vector<std::string> tail_head{"event-tail-charge"};
    expect_error("MONEY_OVERFLOW", [&] {
        (void)project_school_surplus(intermediate_overflow, tail_head, "2026-fall");
    });

    auto delta_high = fixture("golden-case");
    delta_high["events"] = scryer::Json::array({delta_high["events"][0], delta_high["events"][2]});
    delta_high["events"][0]["fact"]["amountMinor"] = "9223372036854775807";
    delta_high["events"][1]["parents"] = scryer::Json::array();
    delta_high["events"][1]["fact"]["amountMinor"] = "9223372036854775807";
    const auto delta_overflow = parse_case(delta_high);
    const std::vector<std::string> charge_only{"event-base-charge"};
    const std::vector<std::string> credit_only{"event-grant"};
    expect_error("MONEY_OVERFLOW", [&] {
        (void)compare_school_surplus(delta_overflow, charge_only, credit_only, "2026-fall");
    });
}
