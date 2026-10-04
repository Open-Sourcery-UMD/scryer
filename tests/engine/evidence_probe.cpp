#include "scryer/case.hpp"
#include "scryer/coverage.hpp"
#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"
#include "scryer/lifecycle.hpp"
#include "scryer/matching.hpp"

#include <cstdint>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

namespace {

scryer::Json minor(std::optional<std::int64_t> value) {
    return value ? scryer::Json(std::to_string(*value)) : scryer::Json(nullptr);
}

scryer::Json intervals(const std::vector<scryer::Interval>& values) {
    scryer::Json result = scryer::Json::array();
    for (const auto& [start, end] : values) {
        result.push_back(scryer::Json::array({start, end}));
    }
    return result;
}

scryer::Json coverage(const scryer::CoverageResult& value) {
    return {
        {"accountRefId", value.account_ref_id}, {"startDate", value.start_date},
        {"endDateExclusive", value.end_date_exclusive}, {"status", value.status},
        {"coveredIntervals", intervals(value.covered_intervals)},
        {"missingIntervals", intervals(value.missing_intervals)},
        {"assertionIds", value.assertion_ids}, {"limitationCodes", value.limitation_codes}
    };
}

scryer::Json matching(const scryer::MatchResult& value) {
    scryer::Json allocations = scryer::Json::array();
    for (const auto& item : value.confirmed_allocations) {
        allocations.push_back({
            {"bankFactId", item.bank_fact_id}, {"bankAccountRefId", item.bank_account_ref_id},
            {"allocatedMinor", std::to_string(item.allocated_minor)},
            {"decisionEventId", item.decision_event_id}
        });
    }
    return {
        {"refundFactId", value.refund_fact_id}, {"bankAccountRefId", value.bank_account_ref_id},
        {"currency", value.currency}, {"status", value.status},
        {"refundAmountMinor", minor(value.refund_amount_minor)},
        {"candidateFactIds", value.candidate_fact_ids}, {"confirmedAllocations", allocations},
        {"remainingMinor", minor(value.remaining_minor)},
        {"coverage", value.coverage ? coverage(*value.coverage) : scryer::Json(nullptr)},
        {"reasonCodes", value.reason_codes}
    };
}

scryer::Json lifecycle(const scryer::LifecycleResult& value) {
    scryer::Json observations = scryer::Json::array();
    for (const auto& item : value.observations) {
        observations.push_back({
            {"factId", item.fact_id}, {"role", item.role},
            {"currentAmountMinor", std::to_string(item.current_amount_minor)},
            {"sourceKind", item.source_kind}, {"approvalEventId", item.approval_event_id}
        });
    }
    return {
        {"caseId", value.case_id}, {"heads", value.heads}, {"termId", value.term_id},
        {"aidItemId", value.aid_item_id}, {"recipientKind", value.recipient_kind},
        {"status", value.status}, {"currentOfferMinor", minor(value.current_offer_minor)},
        {"currentAcceptedMinor", minor(value.current_accepted_minor)},
        {"currentPendingMinor", minor(value.current_pending_minor)},
        {"postedMinor", minor(value.posted_minor)}, {"observations", observations},
        {"findingCodes", value.finding_codes}, {"nextActionCodes", value.next_action_codes},
        {"limitationCodes", value.limitation_codes},
        {"grossDisbursedMinor", minor(value.gross_disbursed_minor)},
        {"withheldFeeMinor", minor(value.withheld_fee_minor)},
        {"unexplainedDifferenceMinor", minor(value.unexplained_difference_minor)}
    };
}

scryer::Json evaluate(const scryer::Json& request) {
    const auto case_data = scryer::parse_case(request.at("case"));
    const auto operation = request.at("operation").get<std::string>();
    const auto heads = request.at("heads").get<std::vector<std::string>>();
    if (operation == "coverage") {
        return coverage(scryer::evaluate_bank_coverage(
            case_data, heads, request.at("accountRefId").get<std::string>(),
            request.at("startDate").get<std::string>(), request.at("endDateExclusive").get<std::string>()
        ));
    }
    if (operation == "matching") {
        return matching(scryer::suggest_refund_deposits(
            case_data, heads, request.at("refundFactId").get<std::string>(),
            request.at("bankAccountRefId").get<std::string>()
        ));
    }
    if (operation == "lifecycle") {
        return lifecycle(scryer::project_aid_lifecycle(
            case_data, heads, request.at("termId").get<std::string>(),
            request.at("aidItemId").get<std::string>()
        ));
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
