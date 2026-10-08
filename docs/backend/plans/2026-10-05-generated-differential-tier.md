# M9-1 generated projection differential tier

**Task ID, requirements, dependencies, and risk:** M9-1; S-30; HIGH. Depends on the verified M2 Python reference, M3 native CLI, canonical case schema, and M8-6c join event.

**Design:** Add one deterministic synthetic runner with a selectable count and seed start. For each seed, generate an exact-money case in one of seven families: linear approvals, reordered event enumeration, one correction, one cancellation, two approved branches with a causal join, two competing corrections with a join, and a manual-source approval. Validate the case independently in Python, compute the reference school-surplus projection, send the same case to the native C++ CLI, and compare all public projection fields. Bound each child process and fail on any mismatch or invalid fixture. Include a small smoke run and a full 10,000-case run. Report the exact count, source revision, platform, wall time, skips, and limits.

**Review:** A generated family is only evidence for its shape; it cannot stand in for fuzzing arbitrary JSON, sanitizer coverage, browser WASM parity, or real statement formats. Use fixed seeds so any failure can be minimized. Do not upload cases or binaries. Keep the runner out of the ordinary quick test suite until its runtime is measured.

**Done:** The smoke and 10,000-case local tier exit zero; no mismatch is hidden by a skip; verification and requirements ledgers state the tested families and remaining M9 gates. Overall status remains `BACKEND_PARTIAL_LOCAL`.
