#include "scryer/json_boundary.hpp"

#include "scryer/error.hpp"

#include <cstddef>
#include <new>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

namespace scryer {
namespace {

constexpr std::size_t kMaxDocumentBytes = 20 * 1024 * 1024;
constexpr std::size_t kMaxDepth = 64;

void check_size_and_depth(std::string_view document) {
    if (document.size() > kMaxDocumentBytes) {
        throw ScryerError("INPUT_TOO_LARGE");
    }
    std::size_t depth = 0;
    bool quoted = false;
    bool escaped = false;
    for (char byte : document) {
        if (quoted) {
            if (escaped) {
                escaped = false;
            } else if (byte == '\\') {
                escaped = true;
            } else if (byte == '"') {
                quoted = false;
            }
            continue;
        }
        if (byte == '"') {
            quoted = true;
        } else if (byte == '{' || byte == '[') {
            if (++depth > kMaxDepth) {
                throw ScryerError("JSON_DEPTH_EXCEEDED");
            }
        } else if (byte == '}' || byte == ']') {
            if (depth == 0) {
                throw ScryerError("INVALID_JSON");
            }
            --depth;
        }
    }
    if (quoted || depth != 0) {
        throw ScryerError("INVALID_JSON");
    }
}

}  // namespace

Json parse_document(std::string_view document) {
    check_size_and_depth(document);
    bool duplicate = false;
    std::vector<std::unordered_set<std::string>> object_keys;
    const auto callback = [&object_keys, &duplicate](int, Json::parse_event_t event, Json& parsed) {
        if (event == Json::parse_event_t::object_start) {
            object_keys.emplace_back();
        } else if (event == Json::parse_event_t::object_end) {
            if (object_keys.empty()) {
                throw ScryerError("INVALID_JSON");
            }
            object_keys.pop_back();
        } else if (event == Json::parse_event_t::key) {
            if (object_keys.empty()) {
                throw ScryerError("INVALID_JSON");
            }
            if (!object_keys.back().insert(parsed.get<std::string>()).second) {
                duplicate = true;
            }
        }
        return true;
    };
    try {
        Json value = Json::parse(document.begin(), document.end(), callback);
        if (duplicate) {
            throw ScryerError("DUPLICATE_JSON_KEY");
        }
        return value;
    } catch (const Json::exception&) {
        throw ScryerError("INVALID_JSON");
    } catch (const std::bad_alloc&) {
        throw ScryerError("COMPUTATION_LIMIT");
    }
}

std::string canonical_json(const Json& value) {
    try {
        return value.dump(-1, ' ', true, Json::error_handler_t::strict);
    } catch (const Json::exception&) {
        throw ScryerError("NONCANONICAL_JSON");
    } catch (const std::bad_alloc&) {
        throw ScryerError("COMPUTATION_LIMIT");
    }
}

}  // namespace scryer
