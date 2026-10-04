#include "scryer/case.hpp"
#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"
#include "scryer/receipt.hpp"

#include <iostream>
#include <string>
#include <vector>

namespace {

scryer::Json evaluate(const scryer::Json& request) {
    const auto case_data = scryer::parse_case(request.at("case"));
    const auto operation = request.at("operation").get<std::string>();
    if (operation == "make") {
        const auto heads = request.at("heads").get<std::vector<std::string>>();
        return scryer::make_receipt(
            case_data, heads, request.at("termId").get<std::string>(),
            request.at("engineVersion").get<std::string>()
        );
    }
    if (operation == "reproduce") {
        return scryer::reproduce_receipt(case_data, request.at("archived"));
    }
    if (operation == "reanalyze") {
        const auto heads = request.at("heads").get<std::vector<std::string>>();
        const auto result = scryer::reanalyze_receipt(case_data, request.at("archived"), heads);
        return {{"priorDigest", result.prior_digest}, {"receipt", result.receipt}};
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
