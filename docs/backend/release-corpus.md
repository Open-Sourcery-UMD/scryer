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
| RC-07 | REFERENCE | A distinct source-backed gross disbursement and withheld fee reconcile with the net school posting. The fixed offer/before-fee/after-fee corpus shows the unresolved $10 gap until fee evidence arrives; negative source tests keep fee separate from school charges. Native/browser parity remains open. |
| RC-08 | REFERENCE | Parent-directed refund produces no student-bank candidate despite full coverage; a cross-recipient confirmation requires a reviewed `recipient_instruction` artifact. Targeted negatives and two fixed corpus operations. Account labels and source authenticity remain unverified. |
| RC-09 | REFERENCE | Split fixture allocates 40000 + 50000 cents with zero remaining. |
| RC-10 | REFERENCE | Equal candidates remain ambiguous in `test_matching.py`. |
| RC-11 | REFERENCE | Equal legitimate school charges from different source positions both count. |
| RC-12 | PARTIAL | Headless exact repeat is inert and changed decisions conflict; browser local persistence and atomic durability remain open. |
| RC-13 | PARTIAL | Equal movements at distinct CSV positions survive review, including a second artifact; overlap ambiguity and real statement formats remain open. |
| RC-14 | REFERENCE | Named reversal fixture retains the 90000-cent historical view, then a source-backed grant correction yields 70000 cents; before/after receipts and exact attribution are fixed in the corpus. Import versioning remains M5 work. |
| RC-15 | REFERENCE | A reviewed charge cancellation after the corrected source yields 100000 cents. Exact +10000-cent net change equals −20000 for the grant and +30000 for the cancelled charge; both original and corrected source references survive in checked receipts. |
| RC-16 | REFERENCE | Account coverage gap returns `INSUFFICIENT_COVERAGE`. |
| RC-17 | PARTIAL | Native bank observations do not imply period coverage. The new synthetic generic CSV extractor emits no coverage assertion from transaction extrema; reviewed coverage and real-format evidence remain open. |
| RC-18 | REFERENCE | Matching never authenticates an uploaded bank source; explicit limitation code. |
| RC-19 | REFERENCE | Event permutation and changed review time are distinct history tests. |
| RC-20 | REFERENCE | Unreviewed proposals do not affect projection or matching. |
| RC-21 | REFERENCE | Competing correction fixture remains contradictory and historically ambiguous. |
| RC-22 | REFERENCE | Unrelated refund evidence does not alter school-surplus fact attribution. |
| RC-23 | REFERENCE | Exact-money, overflow, precision, canonical form, and currency rejection tests. |
| RC-24 | PARTIAL | Headless CSV rejects malformed UTF-8/quotes and byte/row/column/field/cell limits; failed review leaves both input objects unchanged. Browser/PDF failure and atomic storage remain open. |
| RC-25 | PARTIAL | Native CLI is built and 33 fixed operations plus 200 seeded cases pass locally; WASM and real-browser parity remain open. |
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
| RC-46 | PARTIAL | Reference and native CLI reproduce an archived `school-surplus-1` receipt at its recorded heads. Native reanalysis emits a separate `native-0.1.0` receipt linked by prior digest; reference compatibility labels are test-only. WASM/browser migration remains open. |
| RC-47 | OPEN | Identity-provider account-disablement integration remains open. |
| RC-48 | OPEN | Full local journey with external product network blocked remains open. |

The reference corpus is a native-port input set, not the complete release corpus. Do not mark the backend candidate complete until all applicable rows have executable evidence at the required layer. Real institutional-layout compatibility also remains a separate external evidence gate.
