# Local native mutation smoke

`make -C engine mutation-sanitize` builds the native request, case, and JSON-boundary mutation harness with Apple clang address and undefined-behavior sanitizers. Run from the repository root:

```sh
./engine/build/scryer-mutation-sanitized json 30 tests/reference/fixtures
./engine/build/scryer-mutation-sanitized case 30 tests/reference/fixtures
./engine/build/scryer-mutation-sanitized request 30 tests/reference/fixtures
```

Each target uses only committed synthetic fixtures, a fixed seed (`20261005` by default), bounded inputs, and a monotonic time budget. The harness reports iteration, accepted, rejected, duration, and sanitizer configuration. An unexpected exception prints its target, seed, and iteration and exits nonzero. Reproduce up to that iteration with `./engine/build/scryer-mutation-sanitized <target> 600 tests/reference/fixtures <seed> <iteration-plus-one>`; the byte mutation stream is deterministic for a fixed source tree and seed. Sanitizer crashes also stop the process, though the failing iteration may require narrowing if it is not printed.

The harness treats a typed `ScryerError` on malformed input as a rejection. The JSON target also checks parse/canonicalize/parse round trips for accepted documents. The case target calls the strict case parser. The request target calls the versioned native API. Unmutated valid seeds recur every 17 iterations so an all-rejection run fails.

This is mutation stress, not coverage-guided fuzzing. A local Apple clang 21.0.0 link probe with `-fsanitize=fuzzer,address` failed because `libclang_rt.fuzzer_osx.a` is absent. No runtime was downloaded. The ten-minute milestone budgets, coverage thresholds, and other platform/compiler runs remain open.
