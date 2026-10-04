# Release scenario evidence map

This map follows the 48 named RC scenarios in the local backend brief. `REFERENCE` means the current Python oracle has a synthetic fixture or targeted test; it does not mean native, WASM, browser, security, or service parity passed. `PARTIAL` identifies a concrete missing semantic or integration. `OPEN` means no qualifying implementation evidence yet. The fixed native-port inputs are `tests/reference/corpus/manifest.json`; its literal expected values are not generated during test execution.

| ID | Current state | Local evidence or remaining gate |
| --- | --- | --- |
| RC-01 | REFERENCE | Golden fixture and corpus: 650000 − 500000 = 150000 cents. |
| RC-02 | REFERENCE | Golden comparison: two −30000 cent contributions and −60000 delta. |
| RC-03 | REFERENCE | Offer-only/nonposted role tests; lifecycle does not create a posting. |
| RC-04 | REFERENCE | Canceled pending and later pending/posting tests; no pending addition. |
| RC-05 | REFERENCE | Annual fixture returns `UNSUPPORTED_INPUT` and no term split. |
| RC-06 | REFERENCE | Work-study offer remains separate from posted school credit. |
| RC-07 | OPEN | Gross loan versus net disbursement needs explicit linked fee/recipient semantics and a hand-calculated fixture. |
| RC-08 | REFERENCE | Parent-directed refund produces no student-bank candidate despite full coverage; a cross-recipient confirmation requires a reviewed `recipient_instruction` artifact. Targeted negatives and two fixed corpus operations. Account labels and source authenticity remain unverified. |
| RC-09 | REFERENCE | Split fixture allocates 40000 + 50000 cents with zero remaining. |
| RC-10 | REFERENCE | Equal candidates remain ambiguous in `test_matching.py`. |
| RC-11 | REFERENCE | Equal legitimate school charges from different source positions both count. |
| RC-12 | OPEN | Reviewed import-command idempotency belongs to browser local persistence. |
| RC-13 | OPEN | Overlapping statement deduplication requires source-import workflow. |
| RC-14 | PARTIAL | Historical corrected amount is retained; corrected-source import/version workflow remains open. |
| RC-15 | PARTIAL | Fact cancellation and match reversal are tested separately; full reversal sequences need a named fixture. |
| RC-16 | REFERENCE | Account coverage gap returns `INSUFFICIENT_COVERAGE`. |
| RC-17 | PARTIAL | Bank observations do not imply period coverage; real CSV adapter behavior remains open. |
| RC-18 | REFERENCE | Matching never authenticates an uploaded bank source; explicit limitation code. |
| RC-19 | REFERENCE | Event permutation and changed review time are distinct history tests. |
| RC-20 | REFERENCE | Unreviewed proposals do not affect projection or matching. |
| RC-21 | REFERENCE | Competing correction fixture remains contradictory and historically ambiguous. |
| RC-22 | REFERENCE | Unrelated refund evidence does not alter school-surplus fact attribution. |
| RC-23 | REFERENCE | Exact-money, overflow, precision, canonical form, and currency rejection tests. |
| RC-24 | OPEN | Browser/PDF/CSV import failure and atomicity gates remain open. |
| RC-25 | OPEN | Native and WASM engines are not built; no parity claim. |
| RC-26 | REFERENCE | Independent checker catches arithmetic, digest, source, proposal, and aid-item tampering. |
| RC-27 | OPEN | Device source-unavailable and hash reattachment workflow remains open. |
| RC-28 | OPEN | Cryptographic envelope implementation and negative tests remain open. |
| RC-29 | OPEN | Second-device recovery implementation remains open. |
| RC-30 | OPEN | Re-encryption equality/freshness test remains open. |
| RC-31 | OPEN | Official-client/server plaintext sentinel test remains open. |
| RC-32 | OPEN | Real identity and cross-tenant API tests remain open. |
| RC-33 | OPEN | PostgreSQL RLS/application-role tests remain open. |
| RC-34 | OPEN | Concurrent compare-and-swap revision test remains open. |
| RC-35 | OPEN | Lost-response idempotent retry test remains open. |
| RC-36 | OPEN | Idempotency-key conflict/concurrency tests remain open. |
| RC-37 | OPEN | Concurrent quota/storage tests remain open. |
| RC-38 | OPEN | Deletion/tombstone stale-client test remains open. |
| RC-39 | OPEN | Interrupted cross-service deletion recovery test remains open. |
| RC-40 | OPEN | Encrypted export/restore test remains open. |
| RC-41 | OPEN | Persistent schema migration and failed-upgrade recovery tests remain open. |
| RC-42 | OPEN | Fresh-stack backup/restore and deletion replay test remains open. |
| RC-43 | REFERENCE | Candidate cap returns `COMPUTATION_LIMIT`. |
| RC-44 | OPEN | Browser worker/storage cancellation and recovery tests remain open. |
| RC-45 | REFERENCE | Divergent heads and cutoff time inversions do not produce a global time winner. |
| RC-46 | OPEN | Historical receipt versions exist; original-version reproduction versus reanalysis needs an operation and test. |
| RC-47 | OPEN | Identity-provider account-disablement integration remains open. |
| RC-48 | OPEN | Full local journey with external product network blocked remains open. |

The reference corpus is a native-port input set, not the complete release corpus. Do not mark the backend candidate complete until all applicable rows have executable evidence at the required layer. Real institutional-layout compatibility also remains a separate external evidence gate.
