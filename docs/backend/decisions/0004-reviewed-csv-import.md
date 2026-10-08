# ADR 0004 — Reviewed bank CSV imports

Status: selected for local synthetic implementation, 2026-10-04. Human review and real-format evidence pending.

Decision: use a browser-compatible, pinned CSV parser after a bounded lexical preflight. The caller supplies exact column names and an explicit amount convention; neither a filename nor guessed headers determine financial meaning. Every logical data row yields a source-positioned proposal or an explicit row warning. No parser output becomes an approved event until a separate all-or-nothing review command succeeds against the native/WASM case validator. Reimport identity uses the SHA-256 of raw bytes plus the selected account reference; two equal-looking rows at different positions remain distinct.

The generic CSV adapter claims only syntactic CSV support, not compatibility with a named bank or a full statement period. First/last transaction dates never create a coverage assertion. A debit is retained as a review observation but cannot be approved as `bank_credit_observed` under the v1 case schema. Unsupported real UMD document layouts take the manual path and remain `BLOCKED_EXTERNAL` until permitted representative evidence exists.

Alternatives: automatic column/sign inference could misstate money; dropping repeated-looking rows would erase legitimate multiplicity; immediate event creation would give unchecked parser output financial effect. A homegrown delimiter split would fail quoted commas and newlines. These were rejected.

Consequence: the adapter needs an explicit mapping step and a small strict scanner to enforce field/row limits before invoking the maintained parser. Its observations are still unauthenticated. M4's unavailable WASM toolchain prevents the official browser validator integration until that gate is unblocked; native CLI validation is used for local headless review tests.
