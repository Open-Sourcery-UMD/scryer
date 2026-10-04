CXX ?= clang++
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra -Werror -pedantic

.PHONY: test-money test-json

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
