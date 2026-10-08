#include "scryer/case.hpp"
#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"
#include "scryer/lifecycle.hpp"

#include <algorithm>
#include <fstream>
#include <iterator>
#include <source_location>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

void require(bool ok, std::source_location where = std::source_location::current()) {
    if (!ok) {
        throw std::runtime_error("lifecycle test assertion failed at line " +
                                 std::to_string(where.line()));
    }
}

scryer::Json fixture(std::string_view name) {
    std::ifstream file("../tests/reference/fixtures/" + std::string(name) + ".json", std::ios::binary);
    require(file.good());
    return scryer::parse_document(std::string(std::istreambuf_iterator<char>(file), {}));
}

bool has(const std::vector<std::string>& codes, std::string_view code) {
    return std::find(codes.begin(), codes.end(), code) != codes.end();
}

template <class Callable>
void expect_error(std::string_view code, Callable&& action) {
    try {
        action();
    } catch (const scryer::ScryerError& error) {
        require(error.code() == code);
        return;
    }
    throw std::runtime_error("expected typed lifecycle error");
}

}  // namespace

int main() {
    const auto lifecycle = scryer::parse_case(fixture("lifecycle-case"));
    const std::vector<std::string> posted_head{"event-other-credit"};
    const auto posted = scryer::project_aid_lifecycle(lifecycle, posted_head, "2026-fall", "aid-grant");
    require(posted.status == "SUPPORTED_BY_UPLOADED_RECORDS" && posted.posted_minor == 650000);
    require(!posted.current_offer_minor && has(posted.finding_codes, "OFFER_NOT_OBSERVED"));
    require(has(posted.finding_codes, "ACCEPTANCE_NOT_OBSERVED"));
    const std::vector<std::string> late_head{"event-offer-late"};
    const auto late = scryer::project_aid_lifecycle(lifecycle, late_head, "2026-fall", "aid-grant");
    require(late.posted_minor == 620000 && late.current_offer_minor == 700000);
    require(!has(late.finding_codes, "OFFER_NOT_OBSERVED"));

    const auto annual = scryer::parse_case(fixture("annual-case"));
    const std::vector<std::string> annual_head{"event-annual-offer"};
    const auto unallocated = scryer::project_aid_lifecycle(annual, annual_head, "2026-fall", "aid-annual");
    require(unallocated.status == "UNSUPPORTED_INPUT" && unallocated.posted_minor == 0);
    require(has(unallocated.finding_codes, "ANNUAL_UNALLOCATED"));

    const auto gross_net = scryer::parse_case(fixture("gross-net-case"));
    const std::vector<std::string> offer_head{"event-offer"};
    const auto offer = scryer::project_aid_lifecycle(gross_net, offer_head, "2026-fall", "loan-a");
    require(offer.status == "OBSERVED" && offer.current_offer_minor == 100000);
    require(!offer.gross_disbursed_minor && !offer.withheld_fee_minor);
    const std::vector<std::string> gross_head{"event-posted"};
    const auto unexplained = scryer::project_aid_lifecycle(gross_net, gross_head, "2026-fall", "loan-a");
    require(unexplained.gross_disbursed_minor == 100000 && unexplained.posted_minor == 99000);
    require(!unexplained.withheld_fee_minor && unexplained.unexplained_difference_minor == 1000);
    require(has(unexplained.finding_codes, "FEE_EVIDENCE_MISSING"));
    const std::vector<std::string> fee_head{"event-fee"};
    const auto explained = scryer::project_aid_lifecycle(gross_net, fee_head, "2026-fall", "loan-a");
    require(explained.withheld_fee_minor == 1000 && explained.unexplained_difference_minor == 0);
    require(!has(explained.finding_codes, "GROSS_NET_GAP_UNEXPLAINED"));

    auto work_raw = fixture("gross-net-case");
    work_raw["events"][0]["fact"]["role"] = "work_study_offer";
    const auto work = scryer::parse_case(work_raw);
    const auto work_offer = scryer::project_aid_lifecycle(work, offer_head, "2026-fall", "loan-a");
    require(work_offer.status == "OBSERVED" && work_offer.posted_minor == 0);
    require(has(work_offer.finding_codes, "WORK_STUDY_NOT_POSTED"));
    const auto work_posted = scryer::project_aid_lifecycle(work, gross_head, "2026-fall", "loan-a");
    require(has(work_posted.finding_codes, "WORK_STUDY_POSTING_REQUIRES_REVIEW"));

    auto parent_raw = fixture("lifecycle-case");
    parent_raw["aidItems"][0]["recipientKind"] = "parent";
    const auto parent = scryer::parse_case(parent_raw);
    const std::vector<std::string> grant_head{"event-grant"};
    require(has(scryer::project_aid_lifecycle(parent, grant_head, "2026-fall", "aid-grant").finding_codes,
                "NON_STUDENT_RECIPIENT"));
    auto manual_raw = fixture("lifecycle-case");
    manual_raw["events"][0]["fact"]["source"] = {{"kind", "manual"}, {"entryId", "manual-grant"}};
    const auto manual = scryer::parse_case(manual_raw);
    require(scryer::project_aid_lifecycle(manual, grant_head, "2026-fall", "aid-grant").status == "USER_ASSERTED");

    auto conflict_raw = fixture("lifecycle-case");
    auto competing = conflict_raw["events"][3];
    competing["eventId"] = "event-grant-correction-b";
    competing["correction"]["replacementAmountMinor"] = "250000";
    competing["correction"]["reviewId"] = "review-grant-correction-b";
    conflict_raw["events"].push_back(competing);
    const auto conflict_case = scryer::parse_case(conflict_raw);
    const std::vector<std::string> conflict_heads{"event-grant-correction", "event-grant-correction-b"};
    const auto conflict = scryer::project_aid_lifecycle(conflict_case, conflict_heads, "2026-fall", "aid-grant");
    require(conflict.status == "CONTRADICTORY_EVIDENCE" && !conflict.posted_minor);

    auto multiple_raw = fixture("gross-net-case");
    auto second_offer = multiple_raw["events"][0];
    second_offer["eventId"] = "event-offer-b";
    second_offer["parents"] = scryer::Json::array({"event-offer"});
    second_offer["fact"]["factId"] = "aid-offer-b";
    second_offer["fact"]["reviewId"] = "review-aid-offer-b";
    second_offer["fact"]["amountMinor"] = "90000";
    second_offer["fact"]["source"]["location"] = "row:offer-b";
    multiple_raw["events"].push_back(second_offer);
    const auto multiple_case = scryer::parse_case(multiple_raw);
    const std::vector<std::string> multiple_head{"event-offer-b"};
    const auto multiple = scryer::project_aid_lifecycle(multiple_case, multiple_head, "2026-fall", "loan-a");
    require(multiple.status == "AMBIGUOUS" && !multiple.current_offer_minor);
    require(has(multiple.finding_codes, "MULTIPLE_OFFER_SNAPSHOTS"));

    auto pending_raw = fixture("gross-net-case");
    pending_raw["events"][0]["fact"]["role"] = "aid_pending";
    const auto pending_case = scryer::parse_case(pending_raw);
    const auto pending = scryer::project_aid_lifecycle(pending_case, offer_head, "2026-fall", "loan-a");
    require(pending.status == "PENDING" && pending.current_pending_minor == 100000);
    require(has(pending.finding_codes, "PENDING_NOT_POSTED"));

    expect_error("MISSING_TERM", [&] {
        (void)scryer::project_aid_lifecycle(lifecycle, posted_head, "missing", "aid-grant");
    });
    expect_error("MISSING_AID_ITEM", [&] {
        (void)scryer::project_aid_lifecycle(lifecycle, posted_head, "2026-fall", "missing");
    });
    auto other_term_raw = fixture("lifecycle-case");
    auto other_term = other_term_raw["terms"][0];
    other_term["termId"] = "2027-spring";
    other_term["startDate"] = "2027-01-01";
    other_term["endDateExclusive"] = "2027-06-01";
    other_term_raw["terms"].push_back(other_term);
    const auto other_term_case = scryer::parse_case(other_term_raw);
    expect_error("AID_ITEM_TERM_MISMATCH", [&] {
        (void)scryer::project_aid_lifecycle(other_term_case, posted_head, "2027-spring", "aid-grant");
    });
    const std::vector<std::string> no_heads;
    const auto no_evidence = scryer::project_aid_lifecycle(lifecycle, no_heads, "2026-fall", "aid-grant");
    require(no_evidence.status == "INSUFFICIENT_COVERAGE");
    require(has(no_evidence.next_action_codes, "ADD_REVIEWED_EVIDENCE"));

    auto cancelled_raw = fixture("lifecycle-case");
    cancelled_raw["events"][3]["correction"]["cancelled"] = true;
    cancelled_raw["events"][3]["correction"]["replacementAmountMinor"] = nullptr;
    const auto cancelled_case = scryer::parse_case(cancelled_raw);
    const std::vector<std::string> corrected_head{"event-grant-correction"};
    const auto cancelled = scryer::project_aid_lifecycle(cancelled_case, corrected_head,
                                                        "2026-fall", "aid-grant");
    require(std::any_of(cancelled.observations.begin(), cancelled.observations.end(),
                        [](const auto& item) { return item.fact_id == "grant" &&
                                                     item.current_amount_minor == 0; }));

    auto corrected_manual_raw = fixture("lifecycle-case");
    corrected_manual_raw["events"][3]["correction"]["source"] = {
        {"kind", "manual"}, {"entryId", "correction-entry"}
    };
    const auto corrected_manual = scryer::parse_case(corrected_manual_raw);
    const auto corrected_result = scryer::project_aid_lifecycle(corrected_manual, corrected_head,
                                                               "2026-fall", "aid-grant");
    require(corrected_result.status == "USER_ASSERTED");
    require(has(corrected_result.limitation_codes, "MANUAL_SOURCE"));

    auto unknown_recipient_raw = fixture("lifecycle-case");
    unknown_recipient_raw["aidItems"][0]["recipientKind"] = "unknown";
    const auto unknown_recipient = scryer::parse_case(unknown_recipient_raw);
    require(has(scryer::project_aid_lifecycle(unknown_recipient, grant_head,
                "2026-fall", "aid-grant").finding_codes, "RECIPIENT_UNKNOWN"));
    auto third_party_raw = fixture("lifecycle-case");
    third_party_raw["aidItems"][0]["recipientKind"] = "third_party";
    const auto third_party = scryer::parse_case(third_party_raw);
    require(has(scryer::project_aid_lifecycle(third_party, grant_head,
                "2026-fall", "aid-grant").finding_codes, "NON_STUDENT_RECIPIENT"));

    auto fee_only_raw = fixture("gross-net-case");
    fee_only_raw["events"][3]["parents"] = scryer::Json::array();
    const auto fee_only = scryer::parse_case(fee_only_raw);
    const auto fee_without_gross = scryer::project_aid_lifecycle(fee_only, fee_head,
                                                                 "2026-fall", "loan-a");
    require(fee_without_gross.status == "OBSERVED");
    require(has(fee_without_gross.finding_codes, "GROSS_DISBURSEMENT_NOT_OBSERVED"));

    auto accepted_raw = fixture("gross-net-case");
    accepted_raw["events"][0]["fact"]["role"] = "aid_accepted";
    const auto accepted = scryer::parse_case(accepted_raw);
    const auto accepted_result = scryer::project_aid_lifecycle(accepted, offer_head,
                                                              "2026-fall", "loan-a");
    require(accepted_result.current_accepted_minor == 100000);
    require(has(accepted_result.finding_codes, "OFFER_NOT_OBSERVED"));
    auto zero_offer_raw = fixture("gross-net-case");
    zero_offer_raw["events"][0]["fact"]["amountMinor"] = "0";
    const auto zero_offer = scryer::parse_case(zero_offer_raw);
    require(scryer::project_aid_lifecycle(zero_offer, offer_head,
                "2026-fall", "loan-a").current_offer_minor == 0);

    auto multiple_accepted_raw = accepted_raw;
    auto second_accepted = multiple_accepted_raw["events"][0];
    second_accepted["eventId"] = "event-accepted-b";
    second_accepted["parents"] = scryer::Json::array({"event-offer"});
    second_accepted["fact"]["factId"] = "accepted-b";
    second_accepted["fact"]["reviewId"] = "review-accepted-b";
    multiple_accepted_raw["events"].push_back(second_accepted);
    const auto multiple_accepted = scryer::parse_case(multiple_accepted_raw);
    const std::vector<std::string> accepted_head{"event-accepted-b"};
    const auto accepted_conflict = scryer::project_aid_lifecycle(multiple_accepted, accepted_head,
                                                                "2026-fall", "loan-a");
    require(accepted_conflict.status == "AMBIGUOUS");
    require(has(accepted_conflict.finding_codes, "MULTIPLE_ACCEPTANCE_SNAPSHOTS"));
}
