#pragma once

#include "scryer/json_boundary.hpp"

namespace scryer {

struct Request { Json document; };
struct Response { Json document; };

[[nodiscard]] Response evaluate(const Request& request);

}  // namespace scryer
