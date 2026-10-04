#include "scryer/case.hpp"

#include "scryer/error.hpp"
#include "scryer/money.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <queue>
#include <set>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace scryer {
namespace {

constexpr std::size_t kMaxEvents = 200000;
constexpr std::array<std::string_view, 11> kRoles{
    "school_credit", "school_charge", "refund_issued", "bank_credit_observed",
    "aid_offer", "aid_accepted", "aid_pending", "aid_gross_disbursement",
    "aid_fee_withheld", "balance_snapshot", "work_study_offer"
};
constexpr std::array<std::string_view, 4> kRecipients{"student", "parent", "third_party", "unknown"};

template <std::size_t N>
bool contains(const std::array<std::string_view, N>& values, std::string_view needle) {
    return std::find(values.begin(), values.end(), needle) != values.end();
}

bool digit(char c) noexcept { return c >= '0' && c <= '9'; }
bool letter(char c) noexcept { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
bool alnum(char c) noexcept { return digit(c) || letter(c); }

void fields(const Json& value, std::initializer_list<std::string_view> names) {
    if (!value.is_object() || value.size() != names.size()) {
        throw ScryerError("INVALID_SCHEMA");
    }
    for (auto name : names) {
        if (!value.contains(std::string(name))) {
            throw ScryerError("INVALID_SCHEMA");
        }
    }
}

const Json& array(const Json& value) {
    if (!value.is_array() || value.size() > kMaxEvents) {
        throw ScryerError("INVALID_SCHEMA");
    }
    return value;
}

std::string string(const Json& value, std::string_view code = "INVALID_SCHEMA") {
    if (!value.is_string()) {
        throw ScryerError(code);
    }
    return value.get<std::string>();
}

std::string identifier(const Json& value) {
    auto text = string(value, "INVALID_ID");
    if (text.empty() || text.size() > 64 || !alnum(text.front())) {
        throw ScryerError("INVALID_ID");
    }
    for (char c : text) {
        if (!alnum(c) && c != '_' && c != '-') {
            throw ScryerError("INVALID_ID");
        }
    }
    return text;
}

std::optional<std::string> optional_id(const Json& value) {
    return value.is_null() ? std::nullopt : std::optional<std::string>{identifier(value)};
}

std::optional<std::string> optional_recipient(const Json& value, std::string_view error) {
    if (value.is_null()) {
        return std::nullopt;
    }
    if (!value.is_string()) {
        throw ScryerError(error);
    }
    auto result = value.get<std::string>();
    if (!contains(kRecipients, result)) {
        throw ScryerError(error);
    }
    return result;
}

std::string version(const Json& value) {
    auto text = string(value, "INVALID_VERSION");
    if (text.empty() || text.size() > 64 || !alnum(text.front())) {
        throw ScryerError("INVALID_VERSION");
    }
    for (char c : text) {
        if (!alnum(c) && c != '_' && c != '-' && c != '.') {
            throw ScryerError("INVALID_VERSION");
        }
    }
    return text;
}

std::string location(const Json& value) {
    auto text = string(value, "INVALID_SOURCE_LOCATION");
    if (text.empty() || text.size() > 256) {
        throw ScryerError("INVALID_SOURCE_LOCATION");
    }
    for (unsigned char c : text) {
        if (c < '!' || c > '~') {
            throw ScryerError("INVALID_SOURCE_LOCATION");
        }
    }
    return text;
}

int decimal_component(std::string_view text) {
    int value = 0;
    for (char c : text) {
        if (!digit(c)) {
            throw ScryerError("INVALID_DATE");
        }
        value = value * 10 + (c - '0');
    }
    return value;
}

bool leap(int year) noexcept { return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0); }

std::string date_text(const Json& value) {
    auto text = string(value, "INVALID_DATE");
    if (text.size() != 10 || text[4] != '-' || text[7] != '-') {
        throw ScryerError("INVALID_DATE");
    }
    const int year = decimal_component(std::string_view(text).substr(0, 4));
    const int month = decimal_component(std::string_view(text).substr(5, 2));
    const int day = decimal_component(std::string_view(text).substr(8, 2));
    constexpr int days[] = {0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month] + (month == 2 && leap(year))) {
        throw ScryerError("INVALID_DATE");
    }
    return text;
}

std::optional<std::string> optional_date(const Json& value) {
    return value.is_null() ? std::nullopt : std::optional<std::string>{date_text(value)};
}

std::string utc_instant(const Json& value) {
    auto text = string(value, "INVALID_INSTANT");
    if (text.size() != 20 || text[10] != 'T' || text[13] != ':' || text[16] != ':' || text[19] != 'Z') {
        throw ScryerError("INVALID_INSTANT");
    }
    try {
        date_text(Json(text.substr(0, 10)));
    } catch (const ScryerError&) {
        throw ScryerError("INVALID_INSTANT");
    }
    auto time = std::string_view(text);
    int hour = 0;
    int minute = 0;
    int second = 0;
    try {
        hour = decimal_component(time.substr(11, 2));
        minute = decimal_component(time.substr(14, 2));
        second = decimal_component(time.substr(17, 2));
    } catch (const ScryerError&) {
        throw ScryerError("INVALID_INSTANT");
    }
    if (hour > 23 || minute > 59 || second > 59) {
        throw ScryerError("INVALID_INSTANT");
    }
    return text;
}

std::string currency(const Json& value) {
    if (!value.is_string() || value.get<std::string>() != "USD") {
        throw ScryerError("UNSUPPORTED_CURRENCY");
    }
    return "USD";
}

std::int64_t nonnegative_money(const Json& value) {
    if (!value.is_string()) {
        throw ScryerError("INVALID_MONEY");
    }
    const auto result = parse_minor(value.get<std::string>());
    if (result < 0) {
        throw ScryerError("INVALID_MONEY");
    }
    return result;
}

std::optional<std::int64_t> optional_money(const Json& value) {
    return value.is_null() ? std::nullopt : std::optional<std::int64_t>{nonnegative_money(value)};
}

std::vector<std::string> unique_ids(const Json& value) {
    std::vector<std::string> result;
    std::unordered_set<std::string> seen;
    for (const auto& item : array(value)) {
        auto id = identifier(item);
        if (!seen.insert(id).second) {
            throw ScryerError("DUPLICATE_ID");
        }
        result.push_back(std::move(id));
    }
    return result;
}

SourceRef source_ref(const Json& value, const std::unordered_map<std::string, Artifact>& artifacts) {
    if (!value.is_object()) {
        throw ScryerError("INVALID_SCHEMA");
    }
    if (!value.contains("kind")) {
        throw ScryerError("INVALID_SOURCE");
    }
    auto kind = string(value.at("kind"), "INVALID_SOURCE");
    if (kind == "artifact") {
        fields(value, {"kind", "artifactId", "location"});
        auto artifact_id = identifier(value.at("artifactId"));
        if (!artifacts.contains(artifact_id)) {
            throw ScryerError("MISSING_ARTIFACT");
        }
        return SourceRef{kind, artifact_id, location(value.at("location")), std::nullopt};
    }
    if (kind == "manual") {
        fields(value, {"kind", "entryId"});
        return SourceRef{kind, std::nullopt, std::nullopt, identifier(value.at("entryId"))};
    }
    throw ScryerError("INVALID_SOURCE");
}

template <class Item, class Key>
std::unordered_map<std::string, Item> index_unique(const std::vector<Item>& values, Key key, std::string_view error) {
    std::unordered_map<std::string, Item> result;
    result.reserve(values.size());
    for (const auto& item : values) {
        if (!result.emplace(key(item), item).second) {
            throw ScryerError(error);
        }
    }
    return result;
}

}  // namespace

namespace {

Fact parse_fact(
    const Json& value,
    const std::unordered_map<std::string, Term>& terms,
    const std::unordered_map<std::string, AccountRef>& accounts,
    const std::unordered_map<std::string, Artifact>& artifacts,
    const std::unordered_map<std::string, Proposal>& proposals,
    const std::unordered_map<std::string, AidItem>& aid_items
) {
    fields(value, {"factId", "termId", "accountRefId", "aidItemId", "currency", "role", "recipientKind", "amountMinor", "proposalId", "effectiveDate", "source", "reviewId"});
    Fact fact;
    fact.fact_id = identifier(value.at("factId"));
    fact.role = string(value.at("role"), "UNSUPPORTED_ROLE");
    if (!contains(kRoles, fact.role)) {
        throw ScryerError("UNSUPPORTED_ROLE");
    }
    fact.recipient_kind = optional_recipient(value.at("recipientKind"), "INVALID_RECIPIENT_KIND");
    if (fact.role == "refund_issued") {
        if (!fact.recipient_kind || !contains(kRecipients, *fact.recipient_kind)) {
            throw ScryerError("INVALID_RECIPIENT_KIND");
        }
    } else if (fact.recipient_kind) {
        throw ScryerError("INVALID_RECIPIENT_KIND");
    }
    if (fact.role == "bank_credit_observed") {
        if (!value.at("termId").is_null()) {
            throw ScryerError("INVALID_TERM_BINDING");
        }
        fact.term_id = std::nullopt;
    } else if (fact.role != "aid_offer" && fact.role != "aid_accepted" && fact.role != "aid_pending" &&
               fact.role != "work_study_offer") {
        fact.term_id = identifier(value.at("termId"));
    } else {
        fact.term_id = optional_id(value.at("termId"));
    }
    if (fact.term_id && !terms.contains(*fact.term_id)) {
        throw ScryerError("MISSING_TERM");
    }
    fact.account_ref_id = optional_id(value.at("accountRefId"));
    const AccountRef* account = nullptr;
    if (fact.account_ref_id) {
        const auto iter = accounts.find(*fact.account_ref_id);
        if (iter == accounts.end()) {
            throw ScryerError("MISSING_ACCOUNT");
        }
        account = &iter->second;
    }
    if (fact.role == "bank_credit_observed") {
        if (account == nullptr || account->kind != "bank") {
            throw ScryerError("ACCOUNT_KIND_MISMATCH");
        }
    } else if (fact.role == "school_credit" || fact.role == "school_charge" ||
               fact.role == "refund_issued" || fact.role == "balance_snapshot") {
        if (account == nullptr || account->kind != "school") {
            throw ScryerError("ACCOUNT_KIND_MISMATCH");
        }
        if (!fact.term_id || terms.at(*fact.term_id).school_account_ref_id != *fact.account_ref_id) {
            throw ScryerError("TERM_ACCOUNT_MISMATCH");
        }
    } else if (account != nullptr) {
        if (!fact.term_id || account->kind != "school" ||
            terms.at(*fact.term_id).school_account_ref_id != *fact.account_ref_id) {
            throw ScryerError("TERM_ACCOUNT_MISMATCH");
        }
    }
    fact.aid_item_id = optional_id(value.at("aidItemId"));
    if (fact.aid_item_id) {
        const auto item = aid_items.find(*fact.aid_item_id);
        if (item == aid_items.end()) {
            throw ScryerError("MISSING_AID_ITEM");
        }
        if (fact.role != "aid_offer" && fact.role != "aid_accepted" && fact.role != "aid_pending" &&
            fact.role != "work_study_offer" && fact.role != "school_credit" &&
            fact.role != "aid_gross_disbursement" && fact.role != "aid_fee_withheld") {
            throw ScryerError("ROLE_AID_ITEM_MISMATCH");
        }
        if (item->second.term_id != fact.term_id) {
            throw ScryerError("AID_ITEM_TERM_MISMATCH");
        }
    }
    fact.source = source_ref(value.at("source"), artifacts);
    if (fact.role == "aid_gross_disbursement" || fact.role == "aid_fee_withheld") {
        const auto source = fact.source.artifact_id ? artifacts.find(*fact.source.artifact_id) : artifacts.end();
        if (fact.account_ref_id || !fact.aid_item_id || source == artifacts.end() ||
            source->second.kind != "aid_disbursement_statement" || source->second.account_ref_id) {
            throw ScryerError("INVALID_AID_DISBURSEMENT_SOURCE");
        }
    }
    if (fact.source.artifact_id) {
        const auto& source_account = artifacts.at(*fact.source.artifact_id).account_ref_id;
        if (source_account && source_account != fact.account_ref_id) {
            throw ScryerError("SOURCE_ACCOUNT_MISMATCH");
        }
    }
    fact.proposal_id = optional_id(value.at("proposalId"));
    if (fact.proposal_id) {
        const auto proposal = proposals.find(*fact.proposal_id);
        if (proposal == proposals.end()) {
            throw ScryerError("MISSING_PROPOSAL");
        }
        if (fact.source.kind != "artifact" || fact.source.artifact_id != proposal->second.artifact_id ||
            fact.source.location != proposal->second.source_location) {
            throw ScryerError("SOURCE_PROPOSAL_MISMATCH");
        }
    }
    fact.currency = currency(value.at("currency"));
    fact.amount_minor = nonnegative_money(value.at("amountMinor"));
    fact.effective_date = optional_date(value.at("effectiveDate"));
    fact.review_id = identifier(value.at("reviewId"));
    return fact;
}

Correction parse_correction(const Json& value, const std::unordered_map<std::string, Artifact>& artifacts) {
    fields(value, {"factId", "replacementAmountMinor", "cancelled", "source", "reviewId"});
    if (!value.at("cancelled").is_boolean()) {
        throw ScryerError("INVALID_SCHEMA");
    }
    Correction correction{identifier(value.at("factId")), optional_money(value.at("replacementAmountMinor")),
                          value.at("cancelled").get<bool>(), source_ref(value.at("source"), artifacts),
                          identifier(value.at("reviewId"))};
    if (correction.cancelled == correction.replacement_amount_minor.has_value()) {
        throw ScryerError("INVALID_CORRECTION");
    }
    return correction;
}

Coverage parse_coverage(
    const Json& value, const std::unordered_map<std::string, AccountRef>& accounts,
    const std::unordered_map<std::string, Artifact>& artifacts
) {
    fields(value, {"coverageId", "accountRefId", "recordType", "startDate", "endDateExclusive", "basis", "source", "reviewId"});
    Coverage coverage{identifier(value.at("coverageId")), identifier(value.at("accountRefId")),
                      string(value.at("recordType")), date_text(value.at("startDate")),
                      date_text(value.at("endDateExclusive")), string(value.at("basis"), "INVALID_COVERAGE_BASIS"),
                      source_ref(value.at("source"), artifacts), identifier(value.at("reviewId"))};
    const auto account = accounts.find(coverage.account_ref_id);
    if (account == accounts.end()) {
        throw ScryerError("MISSING_ACCOUNT");
    }
    if (account->second.kind != "bank") {
        throw ScryerError("ACCOUNT_KIND_MISMATCH");
    }
    if (coverage.record_type != "bank_transactions") {
        throw ScryerError("UNSUPPORTED_COVERAGE_TYPE");
    }
    if (coverage.start_date >= coverage.end_date_exclusive) {
        throw ScryerError("INVALID_COVERAGE_INTERVAL");
    }
    if (coverage.basis != "source_asserted" && coverage.basis != "user_asserted") {
        throw ScryerError("INVALID_COVERAGE_BASIS");
    }
    if (coverage.basis == "source_asserted") {
        const auto artifact = coverage.source.artifact_id ? artifacts.find(*coverage.source.artifact_id) : artifacts.end();
        if (artifact == artifacts.end() || artifact->second.kind != "bank_statement") {
            throw ScryerError("INVALID_COVERAGE_SOURCE");
        }
        if (artifact->second.account_ref_id != coverage.account_ref_id) {
            throw ScryerError("SOURCE_ACCOUNT_MISMATCH");
        }
        if (artifact->second.observed_at.substr(0, 10) < coverage.end_date_exclusive) {
            throw ScryerError("INVALID_COVERAGE_CHRONOLOGY");
        }
    } else if (coverage.source.kind != "manual") {
        throw ScryerError("INVALID_COVERAGE_SOURCE");
    }
    return coverage;
}

CoverageRetraction parse_retraction(const Json& value) {
    fields(value, {"coverageId", "reason", "reviewId"});
    CoverageRetraction result{identifier(value.at("coverageId")), string(value.at("reason")),
                              identifier(value.at("reviewId"))};
    if (result.reason != "incorrect_period" && result.reason != "wrong_account" &&
        result.reason != "source_invalid" && result.reason != "other") {
        throw ScryerError("INVALID_RETRACTION_REASON");
    }
    return result;
}

MatchDecision parse_decision(const Json& value, const std::unordered_map<std::string, Artifact>& artifacts) {
    fields(value, {"refundFactId", "bankFactId", "allocatedMinor", "action", "recipientEvidence", "reviewId"});
    MatchDecision decision{identifier(value.at("refundFactId")), identifier(value.at("bankFactId")),
                           nonnegative_money(value.at("allocatedMinor")), string(value.at("action"), "INVALID_MATCH_ACTION"),
                           std::nullopt, identifier(value.at("reviewId"))};
    if (decision.action != "confirm" && decision.action != "reject") {
        throw ScryerError("INVALID_MATCH_ACTION");
    }
    if ((decision.action == "confirm" && decision.allocated_minor == 0) ||
        (decision.action == "reject" && decision.allocated_minor != 0)) {
        throw ScryerError("INVALID_MATCH_ALLOCATION");
    }
    if (!value.at("recipientEvidence").is_null()) {
        decision.recipient_evidence = source_ref(value.at("recipientEvidence"), artifacts);
    }
    if (decision.action == "reject" && decision.recipient_evidence) {
        throw ScryerError("INVALID_RECIPIENT_EVIDENCE");
    }
    return decision;
}

Event parse_event(
    const Json& value,
    const std::unordered_map<std::string, Term>& terms,
    const std::unordered_map<std::string, AccountRef>& accounts,
    const std::unordered_map<std::string, Artifact>& artifacts,
    const std::unordered_map<std::string, Proposal>& proposals,
    const std::unordered_map<std::string, AidItem>& aid_items
) {
    if (!value.is_object() || !value.contains("kind")) {
        throw ScryerError("INVALID_SCHEMA");
    }
    auto kind = string(value.at("kind"), "UNSUPPORTED_EVENT");
    Event event;
    if (kind == "approve_fact") {
        fields(value, {"eventId", "parents", "recordedAt", "kind", "fact"});
        event.fact = parse_fact(value.at("fact"), terms, accounts, artifacts, proposals, aid_items);
    } else if (kind == "correct_fact") {
        fields(value, {"eventId", "parents", "recordedAt", "kind", "correction"});
        event.correction = parse_correction(value.at("correction"), artifacts);
    } else if (kind == "assert_coverage") {
        fields(value, {"eventId", "parents", "recordedAt", "kind", "coverage"});
        event.coverage = parse_coverage(value.at("coverage"), accounts, artifacts);
    } else if (kind == "retract_coverage") {
        fields(value, {"eventId", "parents", "recordedAt", "kind", "retraction"});
        event.retraction = parse_retraction(value.at("retraction"));
    } else if (kind == "decide_match") {
        fields(value, {"eventId", "parents", "recordedAt", "kind", "decision"});
        event.decision = parse_decision(value.at("decision"), artifacts);
    } else {
        throw ScryerError("UNSUPPORTED_EVENT");
    }
    event.event_id = identifier(value.at("eventId"));
    event.parents = unique_ids(value.at("parents"));
    event.recorded_at = utc_instant(value.at("recordedAt"));
    event.kind = std::move(kind);
    return event;
}

}  // namespace

Case parse_case(const Json& document) {
    fields(document, {"schemaVersion", "caseId", "currency", "institutions", "accountRefs", "terms", "aidItems", "artifacts", "proposals", "events"});
    if (document.at("schemaVersion") != "1") {
        throw ScryerError("UNSUPPORTED_VERSION");
    }
    Case case_data;
    case_data.schema_version = "1";
    case_data.case_id = identifier(document.at("caseId"));
    case_data.currency = currency(document.at("currency"));
    for (const auto& item : array(document.at("institutions"))) {
        fields(item, {"institutionId"});
        case_data.institutions.push_back({identifier(item.at("institutionId"))});
    }
    const auto institutions = index_unique(case_data.institutions, [](const auto& item) { return item.institution_id; }, "DUPLICATE_INSTITUTION_ID");
    for (const auto& item : array(document.at("accountRefs"))) {
        fields(item, {"accountRefId", "kind", "institutionId", "holderKind"});
        AccountRef account;
        account.account_ref_id = identifier(item.at("accountRefId"));
        account.kind = string(item.at("kind"), "ACCOUNT_KIND_MISMATCH");
        account.holder_kind = optional_recipient(item.at("holderKind"), "INVALID_HOLDER_KIND");
        if (account.kind == "school") {
            if (account.holder_kind.has_value()) {
                throw ScryerError("INVALID_HOLDER_KIND");
            }
            account.institution_id = identifier(item.at("institutionId"));
            if (!institutions.contains(*account.institution_id)) {
                throw ScryerError("MISSING_INSTITUTION");
            }
        } else if (account.kind == "bank") {
            if (!item.at("institutionId").is_null()) {
                throw ScryerError("ACCOUNT_KIND_MISMATCH");
            }
            if (!account.holder_kind || !contains(kRecipients, *account.holder_kind)) {
                throw ScryerError("INVALID_HOLDER_KIND");
            }
        } else {
            throw ScryerError("ACCOUNT_KIND_MISMATCH");
        }
        case_data.account_refs.push_back(std::move(account));
    }
    const auto accounts = index_unique(case_data.account_refs, [](const auto& item) { return item.account_ref_id; }, "DUPLICATE_ACCOUNT_ID");
    for (const auto& item : array(document.at("terms"))) {
        fields(item, {"termId", "institutionId", "schoolAccountRefId", "startDate", "endDateExclusive"});
        Term term{identifier(item.at("termId")), identifier(item.at("institutionId")),
                  identifier(item.at("schoolAccountRefId")), date_text(item.at("startDate")),
                  date_text(item.at("endDateExclusive"))};
        if (!institutions.contains(term.institution_id)) {
            throw ScryerError("MISSING_INSTITUTION");
        }
        const auto account = accounts.find(term.school_account_ref_id);
        if (account == accounts.end()) {
            throw ScryerError("MISSING_ACCOUNT");
        }
        if (account->second.kind != "school" || account->second.institution_id != term.institution_id) {
            throw ScryerError("TERM_ACCOUNT_MISMATCH");
        }
        if (term.start_date >= term.end_date_exclusive) {
            throw ScryerError("INVALID_TERM_INTERVAL");
        }
        case_data.terms.push_back(std::move(term));
    }
    const auto terms = index_unique(case_data.terms, [](const auto& item) { return item.term_id; }, "DUPLICATE_TERM_ID");
    for (const auto& item : array(document.at("aidItems"))) {
        fields(item, {"aidItemId", "institutionId", "termId", "recipientKind"});
        AidItem aid{identifier(item.at("aidItemId")), identifier(item.at("institutionId")),
                    optional_id(item.at("termId")), string(item.at("recipientKind"), "INVALID_RECIPIENT_KIND")};
        if (!institutions.contains(aid.institution_id)) {
            throw ScryerError("MISSING_INSTITUTION");
        }
        if (!contains(kRecipients, aid.recipient_kind)) {
            throw ScryerError("INVALID_RECIPIENT_KIND");
        }
        if (aid.term_id) {
            const auto term = terms.find(*aid.term_id);
            if (term == terms.end()) {
                throw ScryerError("MISSING_TERM");
            }
            if (term->second.institution_id != aid.institution_id) {
                throw ScryerError("AID_ITEM_INSTITUTION_MISMATCH");
            }
        }
        case_data.aid_items.push_back(std::move(aid));
    }
    const auto aid_items = index_unique(case_data.aid_items, [](const auto& item) { return item.aid_item_id; }, "DUPLICATE_AID_ITEM_ID");
    for (const auto& item : array(document.at("artifacts"))) {
        fields(item, {"artifactId", "sha256", "kind", "observedAt", "accountRefId"});
        Artifact artifact{identifier(item.at("artifactId")), string(item.at("sha256"), "INVALID_ARTIFACT_HASH"),
                          identifier(item.at("kind")), utc_instant(item.at("observedAt")), optional_id(item.at("accountRefId"))};
        if (artifact.sha256.size() != 64 || !std::all_of(artifact.sha256.begin(), artifact.sha256.end(), [](char c) {
            return digit(c) || (c >= 'a' && c <= 'f');
        })) {
            throw ScryerError("INVALID_ARTIFACT_HASH");
        }
        if (artifact.account_ref_id && !accounts.contains(*artifact.account_ref_id)) {
            throw ScryerError("MISSING_ACCOUNT");
        }
        case_data.artifacts.push_back(std::move(artifact));
    }
    const auto artifacts = index_unique(case_data.artifacts, [](const auto& item) { return item.artifact_id; }, "DUPLICATE_ARTIFACT_ID");
    for (const auto& item : array(document.at("proposals"))) {
        fields(item, {"proposalId", "artifactId", "sourceLocation", "rawValue", "parserVersion", "mappingVersion", "proposedAmountMinor"});
        Proposal proposal{identifier(item.at("proposalId")), identifier(item.at("artifactId")),
                          location(item.at("sourceLocation")), string(item.at("rawValue")),
                          version(item.at("parserVersion")), version(item.at("mappingVersion")),
                          optional_money(item.at("proposedAmountMinor"))};
        if (!artifacts.contains(proposal.artifact_id)) {
            throw ScryerError("MISSING_ARTIFACT");
        }
        if (proposal.raw_value.size() > 65536) {
            throw ScryerError("INVALID_SCHEMA");
        }
        case_data.proposals.push_back(std::move(proposal));
    }
    const auto proposals = index_unique(case_data.proposals, [](const auto& item) { return item.proposal_id; }, "DUPLICATE_PROPOSAL_ID");
    std::vector<Event> incoming;
    for (const auto& item : array(document.at("events"))) {
        incoming.push_back(parse_event(item, terms, accounts, artifacts, proposals, aid_items));
    }
    std::unordered_map<std::string, std::size_t> event_indices;
    for (std::size_t i = 0; i < incoming.size(); ++i) {
        if (!event_indices.emplace(incoming[i].event_id, i).second) {
            throw ScryerError("DUPLICATE_EVENT_ID");
        }
    }
    std::unordered_map<std::string, std::size_t> indegree;
    std::unordered_map<std::string, std::vector<std::string>> children;
    for (const auto& event : incoming) {
        indegree.emplace(event.event_id, event.parents.size());
        children.emplace(event.event_id, std::vector<std::string>{});
    }
    for (const auto& event : incoming) {
        for (const auto& parent : event.parents) {
            if (!event_indices.contains(parent)) {
                throw ScryerError("MISSING_PARENT");
            }
            children.at(parent).push_back(event.event_id);
        }
    }
    std::priority_queue<std::string, std::vector<std::string>, std::greater<>> ready;
    for (const auto& [id, count] : indegree) {
        if (count == 0) {
            ready.push(id);
        }
    }
    while (!ready.empty()) {
        const auto id = ready.top();
        ready.pop();
        case_data.events.push_back(std::move(incoming[event_indices.at(id)]));
        for (const auto& child : children.at(id)) {
            if (--indegree.at(child) == 0) {
                ready.push(child);
            }
        }
    }
    if (case_data.events.size() != incoming.size()) {
        throw ScryerError("EVENT_CYCLE");
    }
    std::unordered_map<std::string, const Event*> approval_events;
    std::unordered_map<std::string, const Fact*> facts;
    std::unordered_map<std::string, const Event*> coverage_events;
    std::unordered_set<std::string> approved_proposals;
    std::unordered_set<std::string> reviews;
    for (const auto& event : case_data.events) {
        if (event.fact) {
            const auto& fact = *event.fact;
            if (!approval_events.emplace(fact.fact_id, &event).second) {
                throw ScryerError("DUPLICATE_FACT_ID");
            }
            facts.emplace(fact.fact_id, &fact);
            if (fact.proposal_id && !approved_proposals.insert(*fact.proposal_id).second) {
                throw ScryerError("DUPLICATE_PROPOSAL_APPROVAL");
            }
            if (!reviews.insert(fact.review_id).second) {
                throw ScryerError("DUPLICATE_REVIEW_ID");
            }
        } else if (event.coverage) {
            if (!coverage_events.emplace(event.coverage->coverage_id, &event).second) {
                throw ScryerError("DUPLICATE_COVERAGE_ID");
            }
            if (!reviews.insert(event.coverage->review_id).second) {
                throw ScryerError("DUPLICATE_REVIEW_ID");
            }
        } else {
            const auto& review = event.correction ? event.correction->review_id :
                event.retraction ? event.retraction->review_id : event.decision->review_id;
            if (!reviews.insert(review).second) {
                throw ScryerError("DUPLICATE_REVIEW_ID");
            }
        }
    }
    for (const auto& event : case_data.events) {
        if (event.fact && (event.fact->role == "aid_gross_disbursement" || event.fact->role == "aid_fee_withheld")) {
            const auto& source = *event.fact->source.artifact_id;
            if (artifacts.at(source).observed_at > event.recorded_at) {
                throw ScryerError("INVALID_AID_DISBURSEMENT_CHRONOLOGY");
            }
        }
        if (event.correction) {
            const auto& correction = *event.correction;
            const auto approval = approval_events.find(correction.fact_id);
            if (approval == approval_events.end() ||
                std::find(event.parents.begin(), event.parents.end(), approval->second->event_id) == event.parents.end()) {
                throw ScryerError("INVALID_CORRECTION_CAUSALITY");
            }
            const auto& fact = *facts.at(correction.fact_id);
            if (correction.source.artifact_id) {
                const auto& account = artifacts.at(*correction.source.artifact_id).account_ref_id;
                if (account && account != fact.account_ref_id) {
                    throw ScryerError("SOURCE_ACCOUNT_MISMATCH");
                }
            }
            if (fact.role == "aid_gross_disbursement" || fact.role == "aid_fee_withheld") {
                const auto source = correction.source.artifact_id ?
                    artifacts.find(*correction.source.artifact_id) : artifacts.end();
                if (source == artifacts.end() || source->second.kind != "aid_disbursement_statement" ||
                    source->second.account_ref_id) {
                    throw ScryerError("INVALID_AID_DISBURSEMENT_SOURCE");
                }
                if (source->second.observed_at > event.recorded_at) {
                    throw ScryerError("INVALID_AID_DISBURSEMENT_CHRONOLOGY");
                }
            }
        }
        if (event.retraction) {
            const auto assertion = coverage_events.find(event.retraction->coverage_id);
            if (assertion == coverage_events.end() ||
                std::find(event.parents.begin(), event.parents.end(), assertion->second->event_id) == event.parents.end()) {
                throw ScryerError("INVALID_RETRACTION_CAUSALITY");
            }
        }
        if (event.decision) {
            const auto& decision = *event.decision;
            const auto refund = facts.find(decision.refund_fact_id);
            const auto bank = facts.find(decision.bank_fact_id);
            if (refund == facts.end() || bank == facts.end()) {
                throw ScryerError("MISSING_FACT");
            }
            if (refund->second->role != "refund_issued" || bank->second->role != "bank_credit_observed") {
                throw ScryerError("MATCH_ROLE_MISMATCH");
            }
            const auto& account = accounts.at(*bank->second->account_ref_id);
            const bool recipient_match = refund->second->recipient_kind != "unknown" &&
                account.holder_kind != "unknown" && refund->second->recipient_kind == account.holder_kind;
            if (decision.action == "confirm" && !recipient_match && !decision.recipient_evidence) {
                throw ScryerError("MATCH_RECIPIENT_EVIDENCE_REQUIRED");
            }
            if (decision.recipient_evidence) {
                const auto& evidence = *decision.recipient_evidence;
                const auto artifact = evidence.artifact_id ? artifacts.find(*evidence.artifact_id) : artifacts.end();
                if (artifact == artifacts.end() || artifact->second.kind != "recipient_instruction" ||
                    (artifact->second.account_ref_id && artifact->second.account_ref_id != bank->second->account_ref_id) ||
                    artifact->second.observed_at > event.recorded_at) {
                    throw ScryerError("INVALID_RECIPIENT_EVIDENCE");
                }
            }
            const auto has_parent = [&event](const std::string& id) {
                return std::find(event.parents.begin(), event.parents.end(), id) != event.parents.end();
            };
            if (!has_parent(approval_events.at(decision.refund_fact_id)->event_id) ||
                !has_parent(approval_events.at(decision.bank_fact_id)->event_id)) {
                throw ScryerError("INVALID_MATCH_CAUSALITY");
            }
        }
    }
    std::sort(case_data.institutions.begin(), case_data.institutions.end(), [](const auto& a, const auto& b) { return a.institution_id < b.institution_id; });
    std::sort(case_data.account_refs.begin(), case_data.account_refs.end(), [](const auto& a, const auto& b) { return a.account_ref_id < b.account_ref_id; });
    std::sort(case_data.terms.begin(), case_data.terms.end(), [](const auto& a, const auto& b) { return a.term_id < b.term_id; });
    std::sort(case_data.aid_items.begin(), case_data.aid_items.end(), [](const auto& a, const auto& b) { return a.aid_item_id < b.aid_item_id; });
    std::sort(case_data.artifacts.begin(), case_data.artifacts.end(), [](const auto& a, const auto& b) { return a.artifact_id < b.artifact_id; });
    std::sort(case_data.proposals.begin(), case_data.proposals.end(), [](const auto& a, const auto& b) { return a.proposal_id < b.proposal_id; });
    return case_data;
}

std::string canonical_date(std::string_view date) {
    return date_text(Json(std::string(date)));
}

std::vector<const Event*> snapshot(const Case& case_data, Heads heads) {
    std::unordered_map<std::string, const Event*> events;
    for (const auto& event : case_data.events) {
        events.emplace(event.event_id, &event);
    }
    std::unordered_set<std::string> requested;
    for (const auto& head : heads) {
        if (!requested.insert(head).second) {
            throw ScryerError("INVALID_HEADS");
        }
        if (!events.contains(head)) {
            throw ScryerError("UNKNOWN_HEAD");
        }
    }
    std::vector<std::string> stack(heads.begin(), heads.end());
    std::unordered_set<std::string> reached;
    while (!stack.empty()) {
        const auto id = std::move(stack.back());
        stack.pop_back();
        if (reached.insert(id).second) {
            const auto* event = events.at(id);
            stack.insert(stack.end(), event->parents.begin(), event->parents.end());
        }
    }
    std::vector<const Event*> result;
    for (const auto& event : case_data.events) {
        if (reached.contains(event.event_id)) {
            result.push_back(&event);
        }
    }
    return result;
}

HistoryResult heads_as_known(const Case& case_data, std::string_view cutoff_utc) {
    const auto cutoff = utc_instant(Json(std::string(cutoff_utc)));
    std::unordered_map<std::string, const Event*> by_id;
    for (const auto& event : case_data.events) {
        by_id.emplace(event.event_id, &event);
    }
    std::unordered_set<std::string> eligible;
    bool inversion = false;
    for (const auto& event : case_data.events) {
        if (event.recorded_at <= cutoff) {
            if (std::all_of(event.parents.begin(), event.parents.end(), [&eligible](const auto& parent) {
                return eligible.contains(parent);
            })) {
                eligible.insert(event.event_id);
            }
            if (std::any_of(event.parents.begin(), event.parents.end(), [&by_id, &cutoff](const auto& parent) {
                return by_id.at(parent)->recorded_at > cutoff;
            })) {
                inversion = true;
            }
        }
    }
    std::unordered_set<std::string> non_heads;
    for (const auto& event : case_data.events) {
        if (eligible.contains(event.event_id)) {
            for (const auto& parent : event.parents) {
                if (eligible.contains(parent)) {
                    non_heads.insert(parent);
                }
            }
        }
    }
    HistoryResult result{cutoff, "", {}, {}};
    for (const auto& id : eligible) {
        if (!non_heads.contains(id)) {
            result.heads.push_back(id);
        }
    }
    std::sort(result.heads.begin(), result.heads.end());
    if (inversion) {
        result.reason_codes.push_back("CAUSAL_TIME_INVERSION");
    }
    if (result.heads.size() > 1) {
        result.reason_codes.push_back("DIVERGENT_HEADS");
    }
    std::sort(result.reason_codes.begin(), result.reason_codes.end());
    result.status = !result.reason_codes.empty() ? "AMBIGUOUS" : result.heads.empty() ? "EMPTY" : "UNIQUE";
    return result;
}

const Event* current_correction(const std::vector<const Event*>& corrections) {
    if (corrections.empty()) {
        return nullptr;
    }
    std::unordered_set<std::string> ids;
    ids.reserve(corrections.size());
    for (const auto* event : corrections) {
        ids.insert(event->event_id);
    }
    std::unordered_set<std::string> superseded;
    for (const auto* event : corrections) {
        for (const auto& parent : event->parents) {
            if (ids.contains(parent)) {
                superseded.insert(parent);
            }
        }
    }
    const Event* current = nullptr;
    for (const auto* event : corrections) {
        if (!superseded.contains(event->event_id)) {
            if (current != nullptr) {
                throw ScryerError("UNRESOLVED_CORRECTION_CONFLICT");
            }
            current = event;
        }
    }
    if (current == nullptr) {
        throw ScryerError("UNRESOLVED_CORRECTION_CONFLICT");
    }
    return current;
}

}  // namespace scryer
