#include "scryer/money.hpp"

#include "scryer/error.hpp"

#include <cstddef>
#include <cstdint>
#include <limits>
#include <string_view>

namespace scryer {
namespace {

constexpr auto kMax = std::numeric_limits<std::int64_t>::max();
constexpr auto kMin = std::numeric_limits<std::int64_t>::min();
constexpr auto kNegativeLimit = static_cast<std::uint64_t>(kMax) + 1;

bool is_digit(char value) noexcept { return value >= '0' && value <= '9'; }

std::int64_t signed_value(std::uint64_t magnitude, bool negative) {
    const auto limit = negative ? kNegativeLimit : static_cast<std::uint64_t>(kMax);
    if (magnitude > limit) {
        throw ScryerError("MONEY_OVERFLOW");
    }
    if (negative && magnitude == kNegativeLimit) {
        return kMin;
    }
    const auto positive = static_cast<std::int64_t>(magnitude);
    return negative ? -positive : positive;
}

std::uint64_t append_digit(std::uint64_t value, char digit, std::uint64_t limit) {
    const auto next = static_cast<std::uint64_t>(digit - '0');
    if (value > (limit - next) / 10) {
        throw ScryerError("MONEY_OVERFLOW");
    }
    return value * 10 + next;
}

}  // namespace

std::int64_t parse_minor(std::string_view text) {
    if (text.empty()) {
        throw ScryerError("INVALID_MONEY");
    }
    const bool negative = text.front() == '-';
    const auto digits = text.substr(negative ? 1 : 0);
    if (digits.empty() || (digits.front() == '0' && (negative || digits.size() > 1))) {
        throw ScryerError("INVALID_MONEY");
    }
    for (char digit : digits) {
        if (!is_digit(digit)) {
            throw ScryerError("INVALID_MONEY");
        }
    }
    if (text.size() > 20) {
        throw ScryerError("MONEY_OVERFLOW");
    }
    const auto limit = negative ? kNegativeLimit : static_cast<std::uint64_t>(kMax);
    std::uint64_t value = 0;
    for (char digit : digits) {
        value = append_digit(value, digit, limit);
    }
    return signed_value(value, negative);
}

std::int64_t parse_us_decimal(std::string_view text) {
    if (text.empty() || text.size() > 64) {
        throw ScryerError("INVALID_MONEY");
    }
    bool negative = false;
    if (text.front() == '(' && text.back() == ')') {
        negative = true;
        text = text.substr(1, text.size() - 2);
    } else if (text.front() == '-') {
        negative = true;
        text.remove_prefix(1);
        if (!text.empty() && text.front() == '$') {
            throw ScryerError("INVALID_MONEY");
        }
    }
    if (!text.empty() && text.front() == '$') {
        text.remove_prefix(1);
    }
    if (text.empty()) {
        throw ScryerError("INVALID_MONEY");
    }
    const auto dot = text.find('.');
    const auto whole = text.substr(0, dot);
    const auto fraction = dot == std::string_view::npos ? std::string_view{} : text.substr(dot + 1);
    if (whole.empty() || (dot != std::string_view::npos && fraction.empty())) {
        throw ScryerError("INVALID_MONEY");
    }
    for (char digit : fraction) {
        if (!is_digit(digit)) {
            throw ScryerError("INVALID_MONEY");
        }
    }
    if (fraction.size() > 2) {
        throw ScryerError("UNSUPPORTED_PRECISION");
    }

    const bool grouped = whole.find(',') != std::string_view::npos;
    std::size_t group_start = 0;
    std::size_t group_number = 0;
    for (;;) {
        const auto comma = whole.find(',', group_start);
        const auto group = whole.substr(group_start, comma == std::string_view::npos ? comma : comma - group_start);
        if (
            group.empty() ||
            (group_number == 0 && (group.front() == '0' && (group.size() > 1 || grouped))) ||
            (group_number == 0 && grouped && group.size() > 3) ||
            (group_number > 0 && group.size() != 3)
        ) {
            throw ScryerError("INVALID_MONEY");
        }
        for (char digit : group) {
            if (!is_digit(digit)) {
                throw ScryerError("INVALID_MONEY");
            }
        }
        if (comma == std::string_view::npos) {
            break;
        }
        group_start = comma + 1;
        ++group_number;
    }

    const auto limit = negative ? kNegativeLimit : static_cast<std::uint64_t>(kMax);
    std::uint64_t units = 0;
    for (char digit : whole) {
        if (digit != ',') {
            units = append_digit(units, digit, limit / 100);
        }
    }
    std::uint64_t cents = units * 100;
    if (!fraction.empty()) {
        cents += static_cast<std::uint64_t>(fraction.front() - '0') * 10;
        if (fraction.size() == 2) {
            cents += static_cast<std::uint64_t>(fraction[1] - '0');
        }
    }
    return signed_value(cents, negative);
}

std::int64_t checked_add(std::int64_t left, std::int64_t right) {
    if ((right > 0 && left > kMax - right) || (right < 0 && left < kMin - right)) {
        throw ScryerError("MONEY_OVERFLOW");
    }
    return left + right;
}

std::int64_t checked_negate(std::int64_t value) {
    if (value == kMin) {
        throw ScryerError("MONEY_OVERFLOW");
    }
    return -value;
}

}  // namespace scryer
