#include "scryer/api.hpp"
#include "scryer/case.hpp"
#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <iterator>
#include <random>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

constexpr std::size_t kMaxMutantBytes = 64 * 1024;

std::string read_seed(const std::string& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input) {
        throw std::runtime_error("SEED_UNAVAILABLE");
    }
    std::string bytes(std::istreambuf_iterator<char>{input}, {});
    if (bytes.empty() || bytes.size() > kMaxMutantBytes) {
        throw std::runtime_error("SEED_SIZE_INVALID");
    }
    return bytes;
}

std::string mutate(const std::string& seed, std::mt19937_64& rng, std::uint64_t iteration) {
    if (iteration % 17 == 0) {
        return seed;
    }
    std::string bytes = seed;
    const std::string replacements = "{}[],:\"\\0123456789abcdefghijklmnopqrstuvwxyz";
    const auto edits = 1 + static_cast<unsigned>(rng() % 6);
    for (unsigned edit = 0; edit < edits; ++edit) {
        const auto position = static_cast<std::size_t>(rng() % (bytes.size() + 1));
        const char replacement = replacements[static_cast<std::size_t>(rng() % replacements.size())];
        switch (rng() % 7) {
            case 0:
                if (!bytes.empty()) bytes[position % bytes.size()] = replacement;
                break;
            case 1:
                if (bytes.size() < kMaxMutantBytes) bytes.insert(position, 1, replacement);
                break;
            case 2:
                if (!bytes.empty()) bytes.erase(position % bytes.size(), 1);
                break;
            case 3:
                if (!bytes.empty() && bytes.size() < kMaxMutantBytes) {
                    const auto start = position % bytes.size();
                    const auto length = std::min<std::size_t>(1 + rng() % 32, bytes.size() - start);
                    bytes.insert(position, bytes.substr(start, length));
                }
                break;
            case 4:
                if (bytes.size() > 1) {
                    const auto left = position % bytes.size();
                    const auto right = static_cast<std::size_t>(rng() % bytes.size());
                    std::swap(bytes[left], bytes[right]);
                }
                break;
            case 5:
                bytes.resize(position);
                break;
            case 6:
                if (!bytes.empty()) bytes[position % bytes.size()] =
                    (rng() & 1) == 0 ? '\0' : static_cast<char>(0xff);
                break;
        }
    }
    if (bytes.size() > kMaxMutantBytes) bytes.resize(kMaxMutantBytes);
    return bytes;
}

void exercise(std::string_view target, const std::string& bytes) {
    auto document = scryer::parse_document(bytes);
    if (target == "json") {
        auto canonical = scryer::canonical_json(document);
        if (scryer::parse_document(canonical) != document) {
            throw std::runtime_error("CANONICAL_ROUND_TRIP_CHANGED");
        }
    } else if (target == "case") {
        static_cast<void>(scryer::parse_case(document));
    } else {
        static_cast<void>(scryer::evaluate({std::move(document)}));
    }
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 4 || argc > 6) {
        std::cerr << "usage: mutation-smoke <json|case|request> <seconds> <fixture-dir> [seed] [max-iterations]\n";
        return 2;
    }
    const std::string target = argv[1];
    if (target != "json" && target != "case" && target != "request") {
        std::cerr << "INVALID_TARGET\n";
        return 2;
    }
    try {
        const auto seconds = std::stoull(argv[2]);
        if (seconds < 1 || seconds > 600) throw std::runtime_error("INVALID_DURATION");
        const std::uint64_t seed = argc >= 5 ? std::stoull(argv[4]) : 20261005;
        const std::uint64_t max_iterations = argc == 6 ? std::stoull(argv[5]) : 0;
        const std::string prefix = argv[3];
        const std::vector<std::string> case_seeds = {
            read_seed(prefix + "/golden-case.json"),
            read_seed(prefix + "/matching-case.json"),
            read_seed(prefix + "/ambiguous-case.json"),
        };
        std::vector<std::string> seeds;
        if (target == "json") {
            seeds = {"{}", "[]", "null", "{\"x\":1,\"x\":2}", "[[[0]]]"};
            seeds.insert(seeds.end(), case_seeds.begin(), case_seeds.end());
        } else if (target == "case") {
            seeds = case_seeds;
        } else {
            for (std::size_t index = 0; index < case_seeds.size(); ++index) {
                const auto operation = index == 0 ? "project" : index == 1 ? "validate" : "current";
                scryer::Json request = {
                    {"schemaVersion", "1"}, {"operation", operation},
                    {"case", scryer::parse_document(case_seeds[index])},
                };
                if (index != 1) request["termId"] = "2026-fall";
                if (index == 0) request["heads"] = scryer::Json::array({"event-extra-charge"});
                seeds.push_back(scryer::canonical_json(request));
            }
        }
        std::mt19937_64 rng(seed);
        const auto started = std::chrono::steady_clock::now();
        const auto deadline = started + std::chrono::seconds(seconds);
        std::uint64_t accepted = 0;
        std::uint64_t rejected = 0;
        std::uint64_t iterations = 0;
        while (std::chrono::steady_clock::now() < deadline &&
               (max_iterations == 0 || iterations < max_iterations)) {
            const auto bytes = mutate(seeds[iterations % seeds.size()], rng, iterations);
            try {
                exercise(target, bytes);
                ++accepted;
            } catch (const scryer::ScryerError&) {
                ++rejected;
            } catch (const std::exception& error) {
                std::cerr << "FAIL target=" << target << " seed=" << seed
                          << " iteration=" << iterations << " error=" << error.what() << '\n';
                return 1;
            }
            ++iterations;
        }
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started).count();
        std::cout << "target=" << target << " seed=" << seed << " iterations=" << iterations
                  << " accepted=" << accepted << " rejected=" << rejected
                  << " elapsed_ms=" << elapsed << " sanitizer=address,undefined\n";
        return iterations > 0 && accepted > 0 ? 0 : 1;
    } catch (const std::exception& error) {
        std::cerr << "SETUP_FAILED " << error.what() << '\n';
        return 2;
    }
}
