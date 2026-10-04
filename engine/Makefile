CXX ?= clang++
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra -Werror -pedantic

.PHONY: test-money test-json test-case test-projection case-probe projection-probe

test-money:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -fsyntax-only ../tests/engine/test_money.cpp
	$(CXX) $(CXXFLAGS) -Iinclude ../tests/engine/test_money.cpp src/money.cpp -o build/test_money
	./build/test_money

test-json:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor -fsyntax-only ../tests/engine/test_json_boundary.cpp
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor ../tests/engine/test_json_boundary.cpp src/json_boundary.cpp -o build/test_json_boundary
	./build/test_json_boundary

test-case:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor -fsyntax-only ../tests/engine/test_case.cpp
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor ../tests/engine/test_case.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/test_case
	./build/test_case

case-probe:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor ../tests/engine/case_probe.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/case_probe

test-projection:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor -fsyntax-only ../tests/engine/test_projection.cpp
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor ../tests/engine/test_projection.cpp src/projection.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/test_projection
	./build/test_projection

projection-probe:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor ../tests/engine/projection_probe.cpp src/projection.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/projection_probe
