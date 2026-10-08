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
        if (error.code() != code) {
            throw std::runtime_error("expected " + std::string(code) + ", got " +
                                     std::string(error.code()));
        }
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

    const auto reject_golden = [&](std::string_view code, auto&& change) {
        auto candidate = fixture("golden-case");
        change(candidate);
        expect_error(code, [&] { (void)parse_case(candidate); });
    };
    reject_golden("UNSUPPORTED_VERSION", [](auto& value) { value["schemaVersion"] = "2"; });
    reject_golden("INVALID_ID", [](auto& value) { value["caseId"] = "bad/id"; });
    reject_golden("INVALID_HOLDER_KIND", [](auto& value) {
        value["accountRefs"][0]["holderKind"] = "student";
    });
    reject_golden("ACCOUNT_KIND_MISMATCH", [](auto& value) {
        value["accountRefs"][1]["institutionId"] = "institution-a";
    });
    reject_golden("INVALID_HOLDER_KIND", [](auto& value) {
        value["accountRefs"][1]["holderKind"] = nullptr;
    });
    reject_golden("MISSING_INSTITUTION", [](auto& value) {
        value["terms"][0]["institutionId"] = "institution-missing";
    });
    reject_golden("INVALID_TERM_INTERVAL", [](auto& value) {
        value["terms"][0]["endDateExclusive"] = value["terms"][0]["startDate"];
    });
    reject_golden("INVALID_ARTIFACT_HASH", [](auto& value) {
        value["artifacts"][0]["sha256"] = std::string(64, 'g');
    });
    reject_golden("MISSING_ACCOUNT", [](auto& value) {
        value["artifacts"][1]["accountRefId"] = "account-missing";
    });
    reject_golden("INVALID_SCHEMA", [](auto& value) {
        value["proposals"][0]["rawValue"] = std::string(65537, 'x');
    });
    reject_golden("DUPLICATE_EVENT_ID", [](auto& value) {
        value["events"][1]["eventId"] = value["events"][0]["eventId"];
    });
    reject_golden("DUPLICATE_FACT_ID", [](auto& value) {
        value["events"][1]["fact"]["factId"] = value["events"][0]["fact"]["factId"];
    });
    reject_golden("UNSUPPORTED_EVENT", [](auto& value) { value["events"][0]["kind"] = "nope"; });
    reject_golden("UNSUPPORTED_ROLE", [](auto& value) {
        value["events"][0]["fact"]["role"] = "unverified_credit";
    });
    reject_golden("INVALID_RECIPIENT_KIND", [](auto& value) {
        value["events"][5]["fact"]["recipientKind"] = nullptr;
    });
    reject_golden("INVALID_TERM_BINDING", [](auto& value) {
        value["events"][6]["fact"]["termId"] = "2026-fall";
    });
    reject_golden("SOURCE_ACCOUNT_MISMATCH", [](auto& value) {
        value["events"][6]["fact"]["source"]["artifactId"] = "bill-a";
    });
    reject_golden("MISSING_AID_ITEM", [](auto& value) {
        value["events"][0]["fact"]["aidItemId"] = "aid-item-missing";
    });
    reject_golden("INVALID_MONEY", [](auto& value) {
        value["events"][0]["fact"]["amountMinor"] = "-1";
    });
    reject_golden("SOURCE_ACCOUNT_MISMATCH", [](auto& value) {
        value["events"][3]["correction"]["source"]["artifactId"] = "bank-a";
    });
    reject_golden("INVALID_CORRECTION", [](auto& value) {
        value["events"][3]["correction"]["cancelled"] = true;
    });
    // Malformed records must fail at the boundary before any projection can use them.
    reject_golden("INVALID_SCHEMA", [](auto& value) { value["events"] = nullptr; });
    reject_golden("INVALID_SCHEMA", [](auto& value) { value["institutions"] = {}; });
    reject_golden("UNSUPPORTED_CURRENCY", [](auto& value) { value["currency"] = 1; });
    reject_golden("INVALID_ID", [](auto& value) { value["caseId"] = ""; });
    reject_golden("INVALID_ID", [](auto& value) { value["caseId"] = std::string(65, 'a'); });
    reject_golden("INVALID_ID", [](auto& value) { value["caseId"] = "_invalid"; });
    reject_golden("INVALID_ID", [](auto& value) { value["caseId"] = 5; });
    reject_golden("DUPLICATE_INSTITUTION_ID", [](auto& value) {
        value["institutions"].push_back(value["institutions"][0]);
    });
    reject_golden("ACCOUNT_KIND_MISMATCH", [](auto& value) {
        value["accountRefs"][0]["kind"] = "wallet";
    });
    reject_golden("ACCOUNT_KIND_MISMATCH", [](auto& value) {
        value["accountRefs"][1]["institutionId"] = "institution-a";
    });
    reject_golden("INVALID_HOLDER_KIND", [](auto& value) {
        value["accountRefs"][1]["holderKind"] = "alien";
    });
    reject_golden("MISSING_ACCOUNT", [](auto& value) {
        value["terms"][0]["schoolAccountRefId"] = "missing";
    });
    reject_golden("MISSING_INSTITUTION", [](auto& value) {
        value["terms"][0]["institutionId"] = "missing";
    });
    reject_golden("DUPLICATE_TERM_ID", [](auto& value) {
        value["terms"].push_back(value["terms"][0]);
    });
    reject_golden("INVALID_DATE", [](auto& value) { value["terms"][0]["startDate"] = "2026-00-01"; });
    reject_golden("INVALID_DATE", [](auto& value) { value["terms"][0]["startDate"] = "2026-13-01"; });
    reject_golden("INVALID_DATE", [](auto& value) { value["terms"][0]["startDate"] = "2026-01-00"; });
    reject_golden("INVALID_DATE", [](auto& value) { value["terms"][0]["startDate"] = "0000-01-01"; });
    reject_golden("INVALID_DATE", [](auto& value) { value["terms"][0]["startDate"] = "1900-02-29"; });
    reject_golden("INVALID_DATE", [](auto& value) { value["terms"][0]["startDate"] = "2026/09/01"; });
    reject_golden("INVALID_DATE", [](auto& value) { value["terms"][0]["startDate"] = "2026-09-0x"; });
    reject_golden("INVALID_ARTIFACT_HASH", [](auto& value) {
        value["artifacts"][0]["sha256"] = std::string(63, 'a');
    });
    reject_golden("DUPLICATE_ARTIFACT_ID", [](auto& value) {
        value["artifacts"].push_back(value["artifacts"][0]);
    });
    reject_golden("INVALID_INSTANT", [](auto& value) {
        value["artifacts"][0]["observedAt"] = "2026-10-04T25:00:00Z";
    });
    reject_golden("INVALID_INSTANT", [](auto& value) {
        value["artifacts"][0]["observedAt"] = "2026-10-04T00:60:00Z";
    });
    reject_golden("INVALID_INSTANT", [](auto& value) {
        value["artifacts"][0]["observedAt"] = "2026-10-04T00:00:60Z";
    });
    reject_golden("INVALID_INSTANT", [](auto& value) {
        value["artifacts"][0]["observedAt"] = "2026-10-04 00:00:00Z";
    });
    reject_golden("INVALID_INSTANT", [](auto& value) {
        value["artifacts"][0]["observedAt"] = "2026-02-30T00:00:00Z";
    });
    reject_golden("MISSING_ARTIFACT", [](auto& value) {
        value["proposals"][0]["artifactId"] = "missing";
    });
    reject_golden("DUPLICATE_PROPOSAL_ID", [](auto& value) {
        value["proposals"].push_back(value["proposals"][0]);
    });
    reject_golden("INVALID_SOURCE_LOCATION", [](auto& value) {
        value["proposals"][0]["sourceLocation"] = "";
    });
    reject_golden("INVALID_SOURCE_LOCATION", [](auto& value) {
        value["proposals"][0]["sourceLocation"] = "bad location";
    });
    reject_golden("INVALID_SOURCE_LOCATION", [](auto& value) {
        value["proposals"][0]["sourceLocation"] = std::string(257, 'x');
    });
    reject_golden("INVALID_VERSION", [](auto& value) {
        value["proposals"][0]["parserVersion"] = "bad/version";
    });
    reject_golden("INVALID_VERSION", [](auto& value) {
        value["proposals"][0]["mappingVersion"] = "";
    });
    reject_golden("INVALID_SCHEMA", [](auto& value) { value["events"][0] = 1; });
    reject_golden("INVALID_SCHEMA", [](auto& value) { value["events"][0].erase("kind"); });
    reject_golden("INVALID_SOURCE", [](auto& value) {
        value["events"][0]["fact"]["source"] = scryer::Json::object();
    });
    reject_golden("INVALID_SOURCE", [](auto& value) {
        value["events"][0]["fact"]["source"]["kind"] = "invented";
    });
    reject_golden("INVALID_MONEY", [](auto& value) {
        value["events"][0]["fact"]["amountMinor"] = "-1";
    });
    reject_golden("INVALID_RECIPIENT_KIND", [](auto& value) {
        value["events"][5]["fact"]["recipientKind"] = nullptr;
    });
    reject_golden("ACCOUNT_KIND_MISMATCH", [](auto& value) {
        value["events"][6]["fact"]["accountRefId"] = "school-a";
    });
    reject_golden("ACCOUNT_KIND_MISMATCH", [](auto& value) {
        value["events"][0]["fact"]["accountRefId"] = "bank-a";
    });
    reject_golden("SOURCE_PROPOSAL_MISMATCH", [](auto& value) {
        value["events"][2]["fact"]["proposalId"] = "proposal-unreviewed";
        value["events"][2]["fact"]["source"]["location"] = "row:other";
    });
    const auto reject_matching = [&](std::string_view code, auto&& change) {
        auto candidate = fixture("matching-case");
        change(candidate);
        expect_error(code, [&] { (void)parse_case(candidate); });
    };
    reject_matching("MISSING_ACCOUNT", [](auto& value) {
        value["events"][7]["coverage"]["accountRefId"] = "missing";
    });
    reject_matching("ACCOUNT_KIND_MISMATCH", [](auto& value) {
        value["events"][7]["coverage"]["accountRefId"] = "school-a";
    });
    reject_matching("UNSUPPORTED_COVERAGE_TYPE", [](auto& value) {
        value["events"][7]["coverage"]["recordType"] = "all_records";
    });
    reject_matching("INVALID_COVERAGE_INTERVAL", [](auto& value) {
        value["events"][7]["coverage"]["endDateExclusive"] = "2026-09-06";
    });
    reject_matching("INVALID_COVERAGE_BASIS", [](auto& value) {
        value["events"][7]["coverage"]["basis"] = "inferred";
    });
    reject_matching("INVALID_COVERAGE_SOURCE", [](auto& value) {
        value["events"][7]["coverage"]["source"] = {
            {"kind", "manual"}, {"entryId", "unsupported-source"}
        };
    });
    reject_matching("INVALID_COVERAGE_SOURCE", [](auto& value) {
        value["events"][7]["coverage"]["source"]["artifactId"] = "refund-a";
    });
    reject_matching("SOURCE_ACCOUNT_MISMATCH", [](auto& value) {
        for (auto& artifact : value["artifacts"]) {
            if (artifact["artifactId"] == "bank-period") artifact["accountRefId"] = "school-a";
        }
    });
    reject_matching("INVALID_COVERAGE_CHRONOLOGY", [](auto& value) {
        value["events"][7]["coverage"]["endDateExclusive"] = "2026-10-10";
    });
    reject_matching("INVALID_COVERAGE_SOURCE", [](auto& value) {
        value["events"][7]["coverage"]["basis"] = "user_asserted";
    });
    reject_matching("DUPLICATE_COVERAGE_ID", [](auto& value) {
        auto second = value["events"][7];
        second["eventId"] = "event-coverage-repeat";
        second["coverage"]["reviewId"] = "review-coverage-repeat";
        value["events"].push_back(second);
    });
    reject_matching("DUPLICATE_REVIEW_ID", [](auto& value) {
        value["events"][7]["coverage"]["reviewId"] = "review-confirm";
    });
    reject_matching("MISSING_FACT", [](auto& value) {
        value["events"][8]["decision"]["refundFactId"] = "missing";
    });
    reject_matching("MISSING_FACT", [](auto& value) {
        value["events"][8]["decision"]["bankFactId"] = "missing";
    });
    reject_matching("MATCH_ROLE_MISMATCH", [](auto& value) {
        value["events"][8]["decision"]["bankFactId"] = "grant";
    });
    reject_matching("INVALID_MATCH_ACTION", [](auto& value) {
        value["events"][8]["decision"]["action"] = "maybe";
    });
    reject_matching("INVALID_MATCH_ALLOCATION", [](auto& value) {
        value["events"][8]["decision"]["allocatedMinor"] = "0";
    });
    reject_matching("INVALID_MATCH_ALLOCATION", [](auto& value) {
        value["events"][8]["decision"]["action"] = "reject";
    });
    reject_matching("INVALID_RECIPIENT_EVIDENCE", [](auto& value) {
        value["events"][8]["decision"]["action"] = "reject";
        value["events"][8]["decision"]["allocatedMinor"] = "0";
        value["events"][8]["decision"]["recipientEvidence"] = {
            {"kind", "manual"}, {"entryId", "recipient-note"}
        };
    });
    reject_matching("INVALID_MATCH_CAUSALITY", [](auto& value) {
        value["events"][8]["parents"] = scryer::Json::array({"event-refund-issued", "event-coverage"});
    });
    reject_matching("MATCH_RECIPIENT_EVIDENCE_REQUIRED", [](auto& value) {
        value["accountRefs"][1]["holderKind"] = "parent";
    });
    reject_matching("INVALID_RECIPIENT_EVIDENCE", [](auto& value) {
        value["events"][8]["decision"]["recipientEvidence"] = {
            {"kind", "artifact"}, {"artifactId", "bank-period"}, {"location", "row:1"}
        };
    });
    const auto reject_gross = [&](std::string_view code, auto&& change) {
        auto candidate = fixture("gross-net-case");
        change(candidate);
        expect_error(code, [&] { (void)parse_case(candidate); });
    };
    reject_gross("INVALID_AID_DISBURSEMENT_SOURCE", [](auto& value) {
        value["events"][1]["fact"]["accountRefId"] = "school-a";
    });
    reject_gross("INVALID_AID_DISBURSEMENT_SOURCE", [](auto& value) {
        value["events"][1]["fact"]["source"]["artifactId"] = "offer-a";
    });
    reject_gross("INVALID_AID_DISBURSEMENT_CHRONOLOGY", [](auto& value) {
        for (auto& artifact : value["artifacts"]) {
            if (artifact["artifactId"] == "disbursement-a")
                artifact["observedAt"] = "2026-09-04T10:00:00Z";
        }
    });
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
