# M9-4 matching boundary regressions

**Task ID, requirements, dependencies, and risk:** M9-4; S-31 and S-44; HIGH. Depends on M9-3's measured native coverage gap, the verified matching contract, and synthetic matching fixtures.

**Design:** Add native unit cases for meaningful paths presently missing from the instrumented matching suite: missing/wrong account, absent/wrong-role refund, both parameter bounds, a cancelled refund, unknown refund date, manual bank evidence, concurrent conflicting decisions, an explicit superseding decision, and concurrent conflicting corrections. Build those cases by modifying synthetic fixture JSON and pass them through the strict native parser before invoking matching. Check precise status/reason or typed error; do not assert coverage percentages as a substitute for behavior. Compare corresponding existing Python reference cases where available. Run the ordinary native test target and then the measured coverage gate.

**Limits:** This task aims at high-risk matching semantics, not a promise that the overall 90%/85% coverage target will be met. A failing gate stays failing. Do not add unreachable-path tests or weaken the threshold to improve the report.

**Done:** New cases pass the ordinary and instrumented native suite, the combined coverage report records the new result, and any remaining gap is explicit in the ledgers. Overall outcome stays `BACKEND_PARTIAL_LOCAL`.
