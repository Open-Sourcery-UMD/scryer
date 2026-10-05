# M9-3 native CLI coverage measurement

**Task ID, requirements, dependencies, and risk:** M9-3; S-31 and the M9 coverage gate; MEDIUM. Depends on the native CLI integration suite and installed Apple LLVM 21 `llvm-profdata`/`llvm-cov` tools. Python branch coverage tooling is absent locally and remains separate.

**Design:** Build the same native CLI sources with LLVM coverage instrumentation into ignored `engine/build`. Run the existing CLI integration suite against that binary with raw profiles in ignored `.backend-artifacts`, merge them locally, and report source-only line and branch percentages using `llvm-cov report`. Exclude vendored headers, test harnesses, and CLI entrypoint when measuring the engine source set; retain the full raw report for audit. Record source revision, exact commands, executed tests, profile count, and percentages. Do not call this a full project coverage result.

**Gate:** If measured source coverage is below the brief's line/branch targets, mark the target incomplete and plan tests for uncovered meaningful paths. Do not lower the threshold or count generated/vendor code to improve the number. A future `verify-full` must fail when mandatory coverage is below target or tooling is missing.

**Done:** The local instrumented CLI suite passes, the merged profile is reproducible, and the measured coverage and limitations are recorded honestly. This task alone does not satisfy Python/client coverage or overall M9 completion.
