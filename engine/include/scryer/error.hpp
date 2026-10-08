#pragma once

#include <stdexcept>
#include <string>
#include <string_view>

namespace scryer {

class ScryerError final : public std::runtime_error {
public:
    explicit ScryerError(std::string_view code) : std::runtime_error(std::string(code)), code_(code) {}

    [[nodiscard]] std::string_view code() const noexcept { return code_; }

private:
    std::string code_;
};

}  // namespace scryer
