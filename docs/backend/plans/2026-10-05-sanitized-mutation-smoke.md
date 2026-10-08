# M9-2 bounded sanitizer mutation smoke

**Task ID, requirements, dependencies, and risk:** M9-2; S-31; HIGH. Depends on the native C++ parser/API, synthetic case fixtures, and local Apple clang sanitizer runtime. Local Apple clang has no `libclang_rt.fuzzer_osx.a`; a direct `-fsanitize=fuzzer,address` link probe failed. Do not claim coverage-guided libFuzzer testing.

**Design:** Build an in-process deterministic byte-mutation harness under address and undefined-behavior sanitizers, with separate JSON-boundary, case-parser, and versioned-request targets. Feed bounded mutations of synthetic seed documents, including valid cases and malformed structures. Invalid input may yield typed `ScryerError`; crashes, sanitizer findings, unexpected exceptions, invalid canonical JSON round trips, and timeout/zero-iteration outcomes fail. Record the fixed random seed and iteration count so a failing input can be replayed. Cap each mutated input, and use a per-target 30-second smoke budget. Keep the compiler and runtime local, without network access or uploaded corpus.

**Limits:** This is deterministic mutation stress, not coverage-guided fuzzing. It does not satisfy the ten-minute milestone budget, arbitrary real-source testing, coverage thresholds, or independent security review. The missing libFuzzer runtime remains a tooling limitation.

**Done:** The three sanitizer targets compile and each completes a 30-second local smoke with nonzero iterations, zero unexpected failures, and no sanitizer report. Document exact commands, counts, platform, and remaining gates while retaining `BACKEND_PARTIAL_LOCAL`.
