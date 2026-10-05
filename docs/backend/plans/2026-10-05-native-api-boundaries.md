# M9-6 native request-boundary regressions

**Task ID, requirements, dependencies, and risk:** M9-6; S-31 and S-44; HIGH. Depends on the versioned native CLI contract and M9-5 coverage result.

**Design:** Extend CLI integration tests with synthetic requests for bounded optional matching integers, malformed request shapes, unsupported operations, oversized timeline/batch/discrepancy queues, and absent trace targets. Exercise an actual discrepancy queue with an aid item and a match target, then compare stable output fields. Every refusal must have an empty stdout and the expected typed code. Keep the production API unchanged and use the existing synthetic fixtures.

**Verification:** Run the complete four-plus CLI integration tests against the optimized native binary, then rerun the local instrumented source coverage gate. Retain a failing result if the 90%/85% threshold remains unmet. This is API contract hardening, not a claim of public-service safety or browser WASM parity.

**Done:** The CLI suite passes the new boundary cases, the coverage report records the exact change, and the remaining source/branch gaps are updated in the machine-readable ledgers.
