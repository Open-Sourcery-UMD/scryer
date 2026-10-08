# M9-5 strict case-boundary regressions

**Task ID, requirements, dependencies, and risk:** M9-5; S-31 and S-44; HIGH. Depends on M9-3's native coverage report, the versioned case schema, and synthetic golden fixtures.

**Design:** Add native parser tests for risky invalid inputs that the coverage report shows are not exercised: version and ID validity, account and term binding, artifact hash and account reference, proposal size, duplicate event/fact IDs, unsupported event/financial role, refund recipient and bank term binding, aid-item binding, cross-account source evidence, and malformed correction semantics. Each mutation starts from a valid synthetic golden case, names the exact expected typed error, and leaves the production engine unchanged. Run the ordinary native parser target, the independent Python model suite, and the reproducible native coverage gate.

**Review:** Focus on inputs that could create misleading money or source provenance, not on line-count inflation. A malformed case must fail before any projection. Do not adjust the 90%/85% threshold or report the gate as passed if it remains below target.

**Done:** All new native parser cases pass, existing reference tests remain green, and the new native coverage result and remaining gap are recorded. This is one partial hardening slice, not full M9 completion.
