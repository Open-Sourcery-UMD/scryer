#pragma once

#include <cstdint>
#include <string_view>

namespace scryer {

[[nodiscard]] std::int64_t parse_minor(std::string_view text);
[[nodiscard]] std::int64_t parse_us_decimal(std::string_view text);
[[nodiscard]] std::int64_t checked_add(std::int64_t left, std::int64_t right);
[[nodiscard]] std::int64_t checked_negate(std::int64_t value);

}  // namespace scryer
