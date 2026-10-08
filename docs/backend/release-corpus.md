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
| RC-12 | PARTIAL | Headless exact repeat is inert and changed decisions conflict; a real browser worker repeats extraction with identical IDs. Browser review validation, local persistence, and atomic durability remain open. |
| RC-13 | PARTIAL | Equal movements at distinct CSV positions survive headless review, including a second artifact, and browser extraction preserves both positions; overlap ambiguity and real statement formats remain open. |
| RC-14 | REFERENCE | Named reversal fixture retains the 90000-cent historical view, then a source-backed grant correction yields 70000 cents; before/after receipts and exact attribution are fixed in the corpus. Import versioning remains M5 work. |
| RC-15 | REFERENCE | A reviewed charge cancellation after the corrected source yields 100000 cents. Exact +10000-cent net change equals −20000 for the grant and +30000 for the cancelled charge; both original and corrected source references survive in checked receipts. |
| RC-16 | REFERENCE | Account coverage gap returns `INSUFFICIENT_COVERAGE`. |
| RC-17 | PARTIAL | Native bank observations do not imply period coverage. Headless and browser CSV extraction emit no coverage assertion from transaction extrema; reviewed coverage and real-format evidence remain open. |
| RC-18 | REFERENCE | Matching never authenticates an uploaded bank source; explicit limitation code. |
| RC-19 | REFERENCE | Event permutation and changed review time are distinct history tests. |
| RC-20 | REFERENCE | Unreviewed proposals do not affect projection or matching. |
| RC-21 | REFERENCE | Competing correction fixture remains contradictory and historically ambiguous. Python and native tests also show that a nonmonetary `resolve_branches` join leaves that contradiction unresolved; a reviewed superseding correction writer remains open. |
| RC-22 | REFERENCE | Unrelated refund evidence does not alter school-surplus fact attribution. |
| RC-23 | REFERENCE | Exact-money, overflow, precision, canonical form, and currency rejection tests. |
| RC-24 | PARTIAL | Headless CSV rejects malformed UTF-8/quotes and byte/row/column/field/cell limits; real-browser worker returns typed malformed/oversized errors and terminates on cancel/timeout. Failed review and manual commands leave inputs unchanged. PDFs route to manual entry. Precise PDF diagnostics and atomic storage remain open. |
| RC-25 | PARTIAL | Native CLI is built and 33 fixed operations plus 200 seeded cases pass locally; WASM and real-browser parity remain open. |
| RC-26 | REFERENCE | Independent checker catches arithmetic, digest, source, proposal, and aid-item tampering. |
| RC-27 | PARTIAL | Browser helper reports `SOURCE_UNAVAILABLE` without local original, `HASH_MISMATCH` for wrong bytes, and `AVAILABLE` after a SHA-256 match; durable device workflow remains open. |
| RC-28 | PARTIAL | WebCrypto and Chrome reject changed bindings, bad tags, wrong keys, chunk loss, later-chunk tamper, and an at-rest package digest mismatch without returning partial plaintext; sync transport and independent review remain open. |
| RC-29 | PARTIAL | A fresh Chrome profile verifies an archive with the 32-byte recovery secret and restores its encrypted case and new outbox; a new-root secret rotation also unlocks two current cases on a second device. Frontend recovery UX and remote sync remain open. |
| RC-30 | PARTIAL | Re-encrypting an equal case/revision generates fresh package IDs and nonces and both versions decrypt; IndexedDB budget exhaustion triggers a journaled generation-2 re-encryption that resumes after reopening. Multi-device coordination remains open. |
| RC-31 | PARTIAL | A synthetic source-text sentinel and approved bank amount survive Chrome recovery and all three decrypted conflict branches; a second journey publishes a joined case containing that source text only inside encrypted data. The sentinel is absent from saved outbox bodies, observed browser-to-API request bodies, current/historical ciphertext HTTP responses, collected loopback API logs, and a read-only scan of text/bytea/JSON columns in disposable `scryer` and `scryer_private` tables after committed and staged writes. The browser uses an injected semantic validator and the API uses a synthetic token verifier; production WASM/JWT integration, deployed logs/backups, and real-data review remain open. |
| RC-32 | PARTIAL | The synthetic verifier API tests deny cross-tenant case and recovery-wrapper reads, and a separate real local Keycloak PKCE test covers two users. The API still lacks maintained JWT verification and a real-token end-to-end tenant test. |
| RC-33 | PARTIAL | Direct non-owner PostgreSQL app-role tests verify forced RLS on tenant tables, signed transaction context, wrong-key denial, cross-tenant write refusal, replay refusal, and pool reuse. Verified-token-to-context integration remains open. |
| RC-34 | PARTIAL | Two Chrome tabs yield one local encrypted case/outbox winner; PostgreSQL concurrent manifest updates from one head yield one CAS winner and preserve the staged loser. A Chrome/API/PostgreSQL journey resolves disjoint manual approvals by replacing the losing outbox operation and publishing one joined server revision. A later remote-head advance makes a second queued join stale; its exact local encrypted case and pending request survive, and browser preview opens the new remote branch. Identity and browser validation remain synthetic. |
| RC-35 | PARTIAL | The browser/API/PostgreSQL journey interrupts after a server commit, reloads the durable outbox, and retries exact saved bytes to the idempotent server receipt. A separate joined-case journey clears its replacement outbox only after a verified server publication receipt. Real-token and WASM-backed production-client validation remain open. |
| RC-36 | PARTIAL | PostgreSQL tests show same-key concurrent manifest retries publish once, while changed body or precondition reuse conflicts. Real-token API integration and operational retention rehearsal remain open. |
| RC-37 | PARTIAL | Two concurrent PostgreSQL chunk stages near the account quota yield one staged result and one `QUOTA_EXCEEDED`; account storage accounting is checked. Public multi-process load and capacity remain unmeasured. |
| RC-38 | PARTIAL | PostgreSQL deletion/update races linearize, old staged or committed retries cannot resurrect a tombstoned case, and a second Chrome device retains its pending branch after the API refuses sync to a deleted case. Backup replay and real-token stale-client denial remain open. |
| RC-39 | PARTIAL | Local account deletion wipes live ciphertext, denies old synthetic tokens, and a lease-based worker retries provider failures and reconciles a crash after provider success; a disposable local Keycloak test verifies real provider user deletion. Scheduler/backlog monitoring, backup deletion replay, and real-token API denial remain open. |
| RC-40 | PARTIAL | Chrome exports a canonical HMAC-authenticated archive, verifies optional encrypted originals, rejects wrong secrets/tamper, previews without mutation, and restores one or two cases atomically; frontend save/restore UX and production WASM validator remain open. |
| RC-41 | PARTIAL | A populated v1 IndexedDB refuses automatic upgrade; Chrome requires an exact current encrypted backup, rolls an interrupted v2 upgrade back to v1, and verifies data after retry. Broader browser/version matrix remains open. |
| RC-42 | OPEN | Fresh-stack backup/restore and deletion replay test remains open. |
| RC-43 | REFERENCE | Candidate cap returns `COMPUTATION_LIMIT`. |
| RC-44 | PARTIAL | Real Chrome tests cover file-read cancellation, in-flight worker termination, timeout, blocked worker creation, and no approved-event output. Storage cancellation/recovery remains open. |
| RC-45 | REFERENCE | Divergent heads and cutoff time inversions do not produce a global time winner. |
| RC-46 | PARTIAL | Reference and native CLI reproduce an archived `school-surplus-1` receipt at its recorded heads. Native reanalysis emits a separate `native-0.1.0` receipt linked by prior digest; reference compatibility labels are test-only. WASM/browser migration remains open. |
| RC-47 | OPEN | Identity-provider account-disablement integration remains open. |
| RC-48 | OPEN | Full local journey with external product network blocked remains open. |

The reference corpus is a native-port input set, not the complete release corpus. Do not mark the backend candidate complete until all applicable rows have executable evidence at the required layer. Real institutional-layout compatibility also remains a separate external evidence gate.
