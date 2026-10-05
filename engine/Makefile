CXX ?= clang++
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra -Werror -pedantic

.PHONY: test-money test-json test-case test-projection test-receipt test-coverage test-matching test-lifecycle case-probe projection-probe receipt-probe evidence-probe cli cli-sanitize cli-coverage unit-coverage mutation-sanitize

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

test-receipt:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor -fsyntax-only ../tests/engine/test_receipt.cpp
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor ../tests/engine/test_receipt.cpp src/receipt.cpp src/projection.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/test_receipt
	./build/test_receipt

receipt-probe:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor ../tests/engine/receipt_probe.cpp src/receipt.cpp src/projection.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/receipt_probe

test-coverage:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor -fsyntax-only ../tests/engine/test_coverage.cpp
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor ../tests/engine/test_coverage.cpp src/coverage.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/test_coverage
	./build/test_coverage

test-matching:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor -fsyntax-only ../tests/engine/test_matching.cpp
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor ../tests/engine/test_matching.cpp src/matching.cpp src/coverage.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/test_matching
	./build/test_matching

test-lifecycle:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor -fsyntax-only ../tests/engine/test_lifecycle.cpp
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor ../tests/engine/test_lifecycle.cpp src/lifecycle.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/test_lifecycle
	./build/test_lifecycle

evidence-probe:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor ../tests/engine/evidence_probe.cpp src/coverage.cpp src/matching.cpp src/lifecycle.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/evidence_probe

cli:
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -Iinclude -Ivendor src/cli.cpp src/api.cpp src/receipt.cpp src/projection.cpp src/coverage.cpp src/matching.cpp src/lifecycle.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/scryer-native

cli-sanitize:
	@mkdir -p build
	$(CXX) -std=c++20 -O1 -g -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined -fno-omit-frame-pointer -Iinclude -Ivendor src/cli.cpp src/api.cpp src/receipt.cpp src/projection.cpp src/coverage.cpp src/matching.cpp src/lifecycle.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/scryer-native-sanitized

cli-coverage:
	@mkdir -p build
	$(CXX) -std=c++20 -O1 -g -Wall -Wextra -Werror -pedantic -fprofile-instr-generate -fcoverage-mapping -Iinclude -Ivendor src/cli.cpp src/api.cpp src/receipt.cpp src/projection.cpp src/coverage.cpp src/matching.cpp src/lifecycle.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/scryer-native-coverage

unit-coverage:
	@mkdir -p build/coverage
	$(CXX) -std=c++20 -O1 -g -Wall -Wextra -Werror -pedantic -fprofile-instr-generate -fcoverage-mapping -Iinclude -Ivendor ../tests/engine/test_money.cpp src/money.cpp -o build/coverage/test_money
	$(CXX) -std=c++20 -O1 -g -Wall -Wextra -Werror -pedantic -fprofile-instr-generate -fcoverage-mapping -Iinclude -Ivendor ../tests/engine/test_json_boundary.cpp src/json_boundary.cpp -o build/coverage/test_json_boundary
	$(CXX) -std=c++20 -O1 -g -Wall -Wextra -Werror -pedantic -fprofile-instr-generate -fcoverage-mapping -Iinclude -Ivendor ../tests/engine/test_case.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/coverage/test_case
	$(CXX) -std=c++20 -O1 -g -Wall -Wextra -Werror -pedantic -fprofile-instr-generate -fcoverage-mapping -Iinclude -Ivendor ../tests/engine/test_projection.cpp src/projection.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/coverage/test_projection
	$(CXX) -std=c++20 -O1 -g -Wall -Wextra -Werror -pedantic -fprofile-instr-generate -fcoverage-mapping -Iinclude -Ivendor ../tests/engine/test_receipt.cpp src/receipt.cpp src/projection.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/coverage/test_receipt
	$(CXX) -std=c++20 -O1 -g -Wall -Wextra -Werror -pedantic -fprofile-instr-generate -fcoverage-mapping -Iinclude -Ivendor ../tests/engine/test_coverage.cpp src/coverage.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/coverage/test_coverage
	$(CXX) -std=c++20 -O1 -g -Wall -Wextra -Werror -pedantic -fprofile-instr-generate -fcoverage-mapping -Iinclude -Ivendor ../tests/engine/test_matching.cpp src/matching.cpp src/coverage.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/coverage/test_matching
	$(CXX) -std=c++20 -O1 -g -Wall -Wextra -Werror -pedantic -fprofile-instr-generate -fcoverage-mapping -Iinclude -Ivendor ../tests/engine/test_lifecycle.cpp src/lifecycle.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/coverage/test_lifecycle
	@for target in test_money test_json_boundary test_case test_projection test_receipt test_coverage test_matching test_lifecycle; do ./build/coverage/$$target || exit $$?; done

mutation-sanitize:
	@mkdir -p build
	$(CXX) -std=c++20 -O1 -g -Wall -Wextra -Werror -pedantic -fsanitize=address,undefined -fno-omit-frame-pointer -Iinclude -Ivendor ../tests/engine/mutation_smoke.cpp src/api.cpp src/receipt.cpp src/projection.cpp src/coverage.cpp src/matching.cpp src/lifecycle.cpp src/case.cpp src/json_boundary.cpp src/money.cpp -o build/scryer-mutation-sanitized
