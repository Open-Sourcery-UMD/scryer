#pragma once

#include "scryer/json_boundary.hpp"

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace scryer {

struct SourceRef {
    std::string kind;
    std::optional<std::string> artifact_id;
    std::optional<std::string> location;
    std::optional<std::string> entry_id;
};

struct Institution { std::string institution_id; };
struct AccountRef {
    std::string account_ref_id;
    std::string kind;
    std::optional<std::string> institution_id;
    std::optional<std::string> holder_kind;
};
struct Term {
    std::string term_id;
    std::string institution_id;
    std::string school_account_ref_id;
    std::string start_date;
    std::string end_date_exclusive;
};
struct AidItem {
    std::string aid_item_id;
    std::string institution_id;
    std::optional<std::string> term_id;
    std::string recipient_kind;
};
struct Artifact {
    std::string artifact_id;
    std::string sha256;
    std::string kind;
    std::string observed_at;
    std::optional<std::string> account_ref_id;
};
struct Proposal {
    std::string proposal_id;
    std::string artifact_id;
    std::string source_location;
    std::string raw_value;
    std::string parser_version;
    std::string mapping_version;
    std::optional<std::int64_t> proposed_amount_minor;
};
struct Fact {
    std::string fact_id;
    std::optional<std::string> term_id;
    std::optional<std::string> account_ref_id;
    std::optional<std::string> aid_item_id;
    std::string currency;
    std::string role;
    std::optional<std::string> recipient_kind;
    std::int64_t amount_minor;
    std::optional<std::string> proposal_id;
    std::optional<std::string> effective_date;
    SourceRef source;
    std::string review_id;
};
struct Correction {
    std::string fact_id;
    std::optional<std::int64_t> replacement_amount_minor;
    bool cancelled;
    SourceRef source;
    std::string review_id;
};
struct Coverage {
    std::string coverage_id;
    std::string account_ref_id;
    std::string record_type;
    std::string start_date;
    std::string end_date_exclusive;
    std::string basis;
    SourceRef source;
    std::string review_id;
};
struct CoverageRetraction {
    std::string coverage_id;
    std::string reason;
    std::string review_id;
};
struct MatchDecision {
    std::string refund_fact_id;
    std::string bank_fact_id;
    std::int64_t allocated_minor;
    std::string action;
    std::optional<SourceRef> recipient_evidence;
    std::string review_id;
};
struct BranchResolution { std::string review_id; };
struct Event {
    std::string event_id;
    std::vector<std::string> parents;
    std::string recorded_at;
    std::string kind;
    std::optional<Fact> fact;
    std::optional<Correction> correction;
    std::optional<Coverage> coverage;
    std::optional<CoverageRetraction> retraction;
    std::optional<MatchDecision> decision;
    std::optional<BranchResolution> resolution;
};
struct Case {
    std::string schema_version;
    std::string case_id;
    std::string currency;
    std::vector<Institution> institutions;
    std::vector<AccountRef> account_refs;
    std::vector<Term> terms;
    std::vector<AidItem> aid_items;
    std::vector<Artifact> artifacts;
    std::vector<Proposal> proposals;
    std::vector<Event> events;
};
struct HistoryResult {
    std::string cutoff_utc;
    std::string status;
    std::vector<std::string> heads;
    std::vector<std::string> reason_codes;
};

using Heads = std::span<const std::string>;

[[nodiscard]] Case parse_case(const Json& document);
[[nodiscard]] std::string canonical_date(std::string_view date);
// Returned event pointers borrow case_data.events; keep the parsed Case alive and
// do not mutate or reorder its events while using a snapshot.
[[nodiscard]] std::vector<const Event*> snapshot(const Case& case_data, Heads heads);
[[nodiscard]] HistoryResult heads_as_known(const Case& case_data, std::string_view cutoff_utc);
[[nodiscard]] const Event* current_correction(const std::vector<const Event*>& corrections);

}  // namespace scryer
