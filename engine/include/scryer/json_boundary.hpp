#pragma once

#include "json.hpp"

#include <string>
#include <string_view>

namespace scryer {

using Json = nlohmann::json;

[[nodiscard]] Json parse_document(std::string_view document);
[[nodiscard]] std::string canonical_json(const Json& value);

}  // namespace scryer
