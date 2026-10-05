#include "scryer/case.hpp"
#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"

#include <algorithm>
#include <array>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

void require(bool ok) {
    if (!ok) {
        throw std::runtime_error("case test assertion failed");
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
    throw std::runtime_error("expected typed case error");
}

scryer::Json fixture(std::string_view name) {
    const std::string path = "../tests/reference/fixtures/" + std::string(name) + ".json";
    std::ifstream file(path, std::ios::binary);
    require(file.good());
    return scryer::parse_document(std::string(std::istreambuf_iterator<char>(file), {}));
}

std::vector<std::string> ids(const std::vector<const scryer::Event*>& events) {
    std::vector<std::string> result;
    for (const auto* event : events) {
        result.push_back(event->event_id);
    }
    return result;
}

}  // namespace

int main() {
    using scryer::parse_case;
    using scryer::snapshot;
    auto raw = fixture("golden-case");
    const auto case_a = parse_case(raw);
    require(case_a.case_id == "case-golden");
    require(case_a.currency == "USD");
    require(case_a.terms.size() == 1);
    require(case_a.events.size() == 7);
    const std::vector<std::string> head{"event-extra-charge"};
    require(ids(snapshot(case_a, head)) == std::vector<std::string>({
        "event-grant", "event-other-credit", "event-base-charge", "event-grant-correction", "event-extra-charge"
    }));
    raw["unexpected"] = true;
    expect_error("INVALID_SCHEMA", [&] { (void)parse_case(raw); });

    raw = fixture("golden-case");
    raw["events"][0]["fact"]["source"]["artifactId"] = "missing";
    expect_error("MISSING_ARTIFACT", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["accountRefs"].push_back(raw["accountRefs"][0]);
    expect_error("DUPLICATE_ACCOUNT_ID", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["terms"][0]["schoolAccountRefId"] = "bank-a";
    expect_error("TERM_ACCOUNT_MISMATCH", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["events"][5]["fact"]["recipientKind"] = "alien";
    expect_error("INVALID_RECIPIENT_KIND", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["events"][0]["fact"]["reviewId"] = raw["events"][1]["fact"]["reviewId"];
    expect_error("DUPLICATE_REVIEW_ID", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["events"][0]["parents"] = scryer::Json::array({"event-other-credit"});
    expect_error("EVENT_CYCLE", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["events"][0]["parents"] = scryer::Json::array({"absent"});
    expect_error("MISSING_PARENT", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["events"][0]["fact"]["amountMinor"] = 300000;
    expect_error("INVALID_MONEY", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["events"][0]["fact"]["effectiveDate"] = "2026-02-30";
    expect_error("INVALID_DATE", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["events"][0]["fact"]["currency"] = "EUR";
    expect_error("UNSUPPORTED_CURRENCY", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["events"][0]["fact"]["proposalId"] = "missing";
    expect_error("MISSING_PROPOSAL", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["events"][0]["fact"]["proposalId"] = "proposal-unreviewed";
    expect_error("SOURCE_PROPOSAL_MISMATCH", [&] { (void)parse_case(raw); });
    raw = fixture("golden-case");
    raw["events"][3]["parents"] = scryer::Json::array({"event-base-charge"});
    expect_error("INVALID_CORRECTION_CAUSALITY", [&] { (void)parse_case(raw); });
    const std::vector<std::string> bad_heads{"event-grant", "event-grant"};
    expect_error("INVALID_HEADS", [&] { (void)snapshot(case_a, bad_heads); });
    const std::vector<std::string> unknown_head{"not-an-event"};
    expect_error("UNKNOWN_HEAD", [&] { (void)snapshot(case_a, unknown_head); });

    auto reverse = fixture("golden-case");
    std::reverse(reverse["events"].begin(), reverse["events"].end());
    const auto case_b = parse_case(reverse);
    require(ids(snapshot(case_b, head)) == ids(snapshot(case_a, head)));
    const auto ambiguous = parse_case(fixture("ambiguous-case"));
    const std::vector<std::string> branches{"event-grant-correction", "event-grant-correction-b"};
    const auto branch_snapshot = ids(snapshot(ambiguous, branches));
    require(branch_snapshot.size() >= 2);
    require(branch_snapshot.back() == "event-grant-correction-b");
    const std::array fixtures{
        "golden-case", "matching-case", "lifecycle-case", "ambiguous-case", "manual-case",
        "split-case", "annual-case", "recipient-case", "gross-net-case", "reversal-case"
    };
    for (const auto* name : fixtures) {
        const auto parsed = parse_case(fixture(name));
        require(!parsed.case_id.empty());
    }
    const auto known = scryer::heads_as_known(case_a, "2026-09-04T10:00:00Z");
    require(known.status == "UNIQUE");
    require(known.heads == std::vector<std::string>{"event-extra-charge"});
    const auto divergent = scryer::heads_as_known(ambiguous, "2026-09-03T12:00:00Z");
    require(divergent.status == "AMBIGUOUS");
    require(divergent.heads == branches);
    require(divergent.reason_codes == std::vector<std::string>{"DIVERGENT_HEADS"});
    auto join_raw = fixture("golden-case");
    auto branch_a = join_raw["events"].back();
    branch_a["eventId"] = "event-branch-a";
    branch_a["parents"] = scryer::Json::array({"event-bank-credit"});
    branch_a["recordedAt"] = "2026-10-03T12:00:00Z";
    branch_a["fact"]["factId"] = "bank-branch-a";
    branch_a["fact"]["reviewId"] = "review-branch-a";
    branch_a["fact"]["proposalId"] = nullptr;
    branch_a["fact"]["source"] = scryer::Json{{"kind", "manual"}, {"entryId", "entry-branch-a"}};
    auto branch_b = branch_a;
    branch_b["eventId"] = "event-branch-b";
    branch_b["fact"]["factId"] = "bank-branch-b";
    branch_b["fact"]["reviewId"] = "review-branch-b";
    branch_b["fact"]["source"]["entryId"] = "entry-branch-b";
    join_raw["events"].push_back(branch_a);
    join_raw["events"].push_back(branch_b);
    join_raw["events"].push_back(scryer::Json{{"eventId", "event-join"},
        {"parents", scryer::Json::array({"event-branch-a", "event-branch-b"})},
        {"recordedAt", "2026-10-04T12:00:00Z"}, {"kind", "resolve_branches"},
        {"resolution", scryer::Json{{"reviewId", "review-join"}}}});
    const auto joined_case = parse_case(join_raw);
    const std::vector<std::string> joined_head{"event-join"};
    require(ids(snapshot(joined_case, joined_head)).size() == case_a.events.size() + 3);
    auto invalid_join = join_raw;
    invalid_join["events"].back()["parents"] = scryer::Json::array({"event-branch-a"});
    expect_error("INVALID_RESOLUTION_PARENTS", [&] { (void)parse_case(invalid_join); });
    invalid_join = join_raw;
    invalid_join["events"].back()["parents"] = scryer::Json::array({"event-branch-a", "event-branch-a"});
    expect_error("DUPLICATE_ID", [&] { (void)parse_case(invalid_join); });
    invalid_join = join_raw;
    invalid_join["events"].back()["parents"] = scryer::Json::array({"event-branch-a", "missing"});
    expect_error("MISSING_PARENT", [&] { (void)parse_case(invalid_join); });
    invalid_join = join_raw;
    invalid_join["events"].back()["resolution"]["reviewId"] = "review-grant";
    expect_error("DUPLICATE_REVIEW_ID", [&] { (void)parse_case(invalid_join); });
    invalid_join = join_raw;
    invalid_join["events"].back()["resolution"]["note"] = "bad";
    expect_error("INVALID_SCHEMA", [&] { (void)parse_case(invalid_join); });
    expect_error("INVALID_INSTANT", [&] { (void)scryer::heads_as_known(case_a, "2026-02-30T12:00:00Z"); });
}
