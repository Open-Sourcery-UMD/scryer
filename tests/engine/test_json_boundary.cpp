#include "scryer/error.hpp"
#include "scryer/json_boundary.hpp"

#include <stdexcept>
#include <string>
#include <string_view>

namespace {

void require(bool result) {
    if (!result) {
        throw std::runtime_error("JSON boundary test assertion failed");
    }
}

template <class Callable>
void expect_error(std::string_view code, Callable&& callable) {
    try {
        callable();
    } catch (const scryer::ScryerError& error) {
        require(error.code() == code);
        require(std::string_view(error.what()) == code);
        return;
    }
    throw std::runtime_error("expected typed JSON boundary error");
}

}  // namespace

int main() {
    using scryer::canonical_json;
    using scryer::parse_document;
    require(canonical_json(parse_document(R"({"b":"2","a":"1"})")) == R"({"a":"1","b":"2"})");
    expect_error("DUPLICATE_JSON_KEY", [] { (void)parse_document(R"({"a":1,"a":2})"); });
    expect_error("DUPLICATE_JSON_KEY", [] { (void)parse_document(R"({"outer":{"x":1,"x":2}})"); });
    expect_error("DUPLICATE_JSON_KEY", [] { (void)parse_document(R"({"a":1,"\u0061":2})"); });
    expect_error("INVALID_JSON", [] { (void)parse_document(R"({"a":})"); });
    std::string too_deep;
    too_deep.append(65, '[');
    too_deep += '0';
    too_deep.append(65, ']');
    expect_error("JSON_DEPTH_EXCEEDED", [&] { (void)parse_document(too_deep); });
    std::string maximum_depth;
    maximum_depth.append(64, '[');
    maximum_depth += '0';
    maximum_depth.append(64, ']');
    require(parse_document(maximum_depth).is_array());
    require(parse_document(R"({"text":"{{{{[[[["})").at("text") == "{{{{[[[[");
    std::string oversized(20 * 1024 * 1024 + 1, ' ');
    expect_error("INPUT_TOO_LARGE", [&] { (void)parse_document(oversized); });
    const std::string malformed_utf8("\xc3\x28", 2);
    expect_error("INVALID_JSON", [&] { (void)parse_document(std::string{"\""} + malformed_utf8 + "\""); });
    std::string source = R"({"name":"synthetic"})";
    const auto owned = parse_document(source);
    source.clear();
    require(owned.at("name") == "synthetic");
}
