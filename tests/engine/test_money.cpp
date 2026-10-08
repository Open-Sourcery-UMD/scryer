#include "scryer/error.hpp"
#include "scryer/money.hpp"

#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>

namespace {

void require(bool value) {
    if (!value) {
        throw std::runtime_error("money test assertion failed");
    }
}

template <class Callable>
void expect_error(std::string_view code, Callable&& call) {
    try {
        call();
    } catch (const scryer::ScryerError& error) {
        require(error.code() == code);
        require(std::string_view(error.what()) == code);
        return;
    }
    throw std::runtime_error("expected typed money error");
}

}  // namespace

int main() {
    using scryer::checked_add;
    using scryer::checked_negate;
    using scryer::parse_minor;
    using scryer::parse_us_decimal;
    require(parse_minor("0") == 0);
    require(parse_minor("650000") == 650000);
    require(parse_minor("-30000") == -30000);
    require(parse_minor("9223372036854775807") == std::numeric_limits<std::int64_t>::max());
    require(parse_minor("-9223372036854775808") == std::numeric_limits<std::int64_t>::min());
    for (std::string_view value : {"-0", "01", "+1", "1.0", "1e2", "", " 1", "1 ", "--1"}) {
        expect_error("INVALID_MONEY", [=] { (void)parse_minor(value); });
    }
    for (std::string_view value : {"9223372036854775808", "-9223372036854775809"}) {
        expect_error("MONEY_OVERFLOW", [=] { (void)parse_minor(value); });
    }
    require(parse_us_decimal("6500.00") == 650000);
    require(parse_us_decimal("(300.00)") == -30000);
    require(parse_us_decimal("1,234.56") == 123456);
    require(parse_us_decimal("$1,234.56") == 123456);
    require(parse_us_decimal("0") == 0);
    require(parse_us_decimal("1.2") == 120);
    require(parse_us_decimal("-0.01") == -1);
    require(parse_us_decimal("(92,233,720,368,547,758.08)") == std::numeric_limits<std::int64_t>::min());
    expect_error("UNSUPPORTED_PRECISION", [] { (void)parse_us_decimal("1.234"); });
    for (std::string_view value : {"12,34.56", "1,23,456", "(1.00)-", "-$1.00", "1.2.3", "1 234.56", ""}) {
        expect_error("INVALID_MONEY", [=] { (void)parse_us_decimal(value); });
    }
    for (std::string_view value : {"92,233,720,368,547,758.08", "(92,233,720,368,547,758.09)"}) {
        expect_error("MONEY_OVERFLOW", [=] { (void)parse_us_decimal(value); });
    }
    require(checked_add(std::numeric_limits<std::int64_t>::max() - 1, 1) == std::numeric_limits<std::int64_t>::max());
    require(checked_add(std::numeric_limits<std::int64_t>::min() + 1, -1) == std::numeric_limits<std::int64_t>::min());
    expect_error("MONEY_OVERFLOW", [] { (void)checked_add(std::numeric_limits<std::int64_t>::max(), 1); });
    expect_error("MONEY_OVERFLOW", [] { (void)checked_negate(std::numeric_limits<std::int64_t>::min()); });
    require(checked_negate(-30000) == 30000);
    const std::string temporary = "prefix650000suffix";
    require(parse_minor(std::string_view(temporary).substr(6, 6)) == 650000);
}
