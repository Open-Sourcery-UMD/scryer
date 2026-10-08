#include "scryer/case.hpp"
#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"
#include "scryer/receipt.hpp"

#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

void require(bool ok) {
    if (!ok) {
        throw std::runtime_error("receipt test assertion failed");
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
    throw std::runtime_error("expected typed receipt error");
}

scryer::Json fixture(std::string_view name) {
    std::ifstream file("../tests/reference/fixtures/" + std::string(name) + ".json", std::ios::binary);
    require(file.good());
    return scryer::parse_document(std::string(std::istreambuf_iterator<char>(file), {}));
}

void redigest(scryer::Json& receipt) {
    auto core = receipt;
    core.erase("digest");
    receipt["digest"] = scryer::sha256_hex(scryer::canonical_json(core));
}

}  // namespace

int main() {
    require(scryer::sha256_hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    require(scryer::sha256_hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const auto golden = scryer::parse_case(fixture("golden-case"));
    const std::vector<std::string> after{"event-extra-charge"};
    const auto receipt = scryer::make_receipt(golden, after, "2026-fall", "reference-0.1.0");
    require(receipt.at("amountMinor") == "90000");
    require(receipt.at("digest") == "f866d458450015bcfbf1456b886888360c532b5c1bb0c91679017b298d7add86");
    require(receipt.at("facts").size() == 4);
    require(scryer::reproduce_receipt(golden, receipt) == receipt);
    const auto second_reference = scryer::make_receipt(golden, after, "2026-fall", "reference-0.2.0");
    require(scryer::reproduce_receipt(golden, second_reference) == second_reference);
    const auto manual = scryer::parse_case(fixture("manual-case"));
    const std::vector<std::string> before{"event-base-charge"};
    const auto manual_receipt = scryer::make_receipt(manual, before, "2026-fall", "reference-0.1.0");
    require(manual_receipt.at("digest") == "3f7da45c53b39da741fd92eff6a11d3711a75fa67f582891f565bd6b495a9294");
    require(scryer::reproduce_receipt(manual, manual_receipt) == manual_receipt);

    auto linked_raw = fixture("golden-case");
    linked_raw["proposals"][0]["sourceLocation"] = "row:1";
    linked_raw["proposals"][0]["proposedAmountMinor"] = "510000";
    linked_raw["events"][2]["fact"]["proposalId"] = "proposal-unreviewed";
    const auto linked = scryer::parse_case(linked_raw);
    const auto linked_receipt = scryer::make_receipt(linked, after, "2026-fall");
    bool found_proposal = false;
    for (const auto& step : linked_receipt.at("facts")) {
        if (step.at("factId") == "base-charge") {
            require(step.at("proposalId") == "proposal-unreviewed");
            require(step.at("proposedAmountMinor") == "510000");
            require(step.at("originalAmountMinor") == "500000");
            require(step.at("currentAmountMinor") == "500000");
            require(step.at("parserVersion") == "synthetic.1");
            require(step.at("mappingVersion") == "school-map.1");
            found_proposal = true;
        }
    }
    require(found_proposal);
    require(scryer::reproduce_receipt(linked, linked_receipt) == linked_receipt);
    linked_raw["proposals"][0]["proposedAmountMinor"] = nullptr;
    const auto unknown_proposal = scryer::parse_case(linked_raw);
    const auto unknown_receipt = scryer::make_receipt(unknown_proposal, after, "2026-fall");
    for (const auto& step : unknown_receipt.at("facts")) {
        if (step.at("factId") == "base-charge") {
            require(step.at("proposedAmountMinor").is_null());
        }
    }
    require(scryer::reproduce_receipt(unknown_proposal, unknown_receipt) == unknown_receipt);
    expect_error("UNSUPPORTED_ENGINE_VERSION", [&] {
        (void)scryer::make_receipt(golden, after, "2026-fall", "future-9");
    });
    expect_error("INVALID_HISTORICAL_RECEIPT", [&] {
        (void)scryer::reproduce_receipt(golden, nullptr);
    });

    auto changed = receipt;
    changed["facts"][0]["contributionMinor"] = "-500001";
    redigest(changed);
    expect_error("INVALID_HISTORICAL_RECEIPT", [&] { (void)scryer::reproduce_receipt(golden, changed); });
    changed = receipt;
    changed["facts"][0]["sourceRef"]["artifactId"] = "wrong-source";
    redigest(changed);
    expect_error("INVALID_HISTORICAL_RECEIPT", [&] { (void)scryer::reproduce_receipt(golden, changed); });
    changed = receipt;
    changed["engineVersion"] = "future-9";
    expect_error("UNSUPPORTED_ENGINE_VERSION", [&] { (void)scryer::reproduce_receipt(golden, changed); });
    changed = receipt;
    changed["ruleVersion"] = "other-rule";
    expect_error("UNSUPPORTED_RULE", [&] { (void)scryer::reproduce_receipt(golden, changed); });
    changed = receipt;
    changed["digest"] = "0";
    expect_error("INVALID_HISTORICAL_RECEIPT", [&] { (void)scryer::reproduce_receipt(golden, changed); });
    changed = receipt;
    changed.erase("heads");
    expect_error("INVALID_HISTORICAL_RECEIPT", [&] { (void)scryer::reproduce_receipt(golden, changed); });
    changed = receipt;
    changed["heads"] = scryer::Json::array({"event-unknown"});
    expect_error("INVALID_HISTORICAL_RECEIPT", [&] { (void)scryer::reproduce_receipt(golden, changed); });
    changed = receipt;
    changed.erase("ruleVersion");
    expect_error("UNSUPPORTED_RULE", [&] { (void)scryer::reproduce_receipt(golden, changed); });
    changed = receipt;
    changed["engineVersion"] = 9;
    expect_error("UNSUPPORTED_ENGINE_VERSION", [&] { (void)scryer::reproduce_receipt(golden, changed); });

    const auto reversal = scryer::parse_case(fixture("reversal-case"));
    const auto archived = scryer::make_receipt(reversal, after, "2026-fall", "reference-0.1.0");
    require(scryer::reproduce_receipt(reversal, archived) == archived);
    const std::vector<std::string> later{"event-charge-cancel"};
    const auto reanalysis = scryer::reanalyze_receipt(reversal, archived, later);
    require(reanalysis.prior_digest == archived.at("digest").get<std::string>());
    require(reanalysis.receipt.at("amountMinor") == "100000");
    require(reanalysis.receipt.at("engineVersion") == "native-0.1.0");
    require(reanalysis.receipt.at("digest") != archived.at("digest"));
    require(scryer::reproduce_receipt(reversal, reanalysis.receipt) == reanalysis.receipt);
    const std::vector<std::string> empty;
    expect_error("UNSUPPORTED_RECEIPT_STATUS", [&] { (void)scryer::make_receipt(golden, empty, "2026-fall"); });
}
