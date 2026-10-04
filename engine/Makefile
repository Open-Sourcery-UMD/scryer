CXX ?= clang++
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra -Werror -pedantic

.PHONY: test-money

test-money:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -fsyntax-only ../tests/engine/test_money.cpp
	$(CXX) $(CXXFLAGS) -Iinclude ../tests/engine/test_money.cpp src/money.cpp -o build/test_money
	./build/test_money
