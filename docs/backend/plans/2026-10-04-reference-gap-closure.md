# Remaining Financial Reference Semantics Before Native Port

**Goal:** Resolve the open financial reference scenarios identified in `docs/backend/release-corpus.md` before freezing the C++ case contract. This is a bounded Python/domain task, not a claim that browser imports or hosted sync are implemented.

**Dependencies:** M2-6d fixed corpus. M3 native engine waits for these contract changes so it does not port incomplete recipient and gross/net semantics.

## Task 1 — M2-7a: Recipient-aware refund matching (RC-08)

**Requirements:** S-18, S-20, S-21, S-24. **Risk:** HIGH.

**Interface decision to verify before coding:** An issued refund records an explicit intended recipient kind (`student`, `parent`, `third_party`, `unknown`) from reviewed evidence. A local bank account reference records a separately reviewed holder kind. `suggest_refund_deposits` must not offer or confirm a student-account match for a parent/third-party refund without an explicit reviewed exception event that names the source basis. Unknown recipient/holder identity yields an incomplete result, not a silent match. Account labels are user-reviewed metadata, not bank authentication.

- [ ] Write failing cross-recipient, unknown-recipient, and permitted-evidence tests using synthetic fixtures.
- [ ] Amend versioned case schema and reference parser, then constrain candidate/decision evaluation.
- [ ] Keep refund-to-bank amount/date matching conservative and auditably reversible.
- [ ] Run full reference suite and 200 seeded checks; commit only verified behavior.

## Task 2 — M2-7b: Gross, net, and fee evidence (RC-07)

**Requirements:** S-18, S-19, S-22, S-24. **Risk:** HIGH.

**Interface decision to verify before coding:** A gross loan offer is a snapshot, a source-backed withheld fee is neither a school charge nor a bank debit, and a net posted school credit is a movement. The aid-item lifecycle reports each amount separately and an explicit unresolved difference when approved evidence does not explain it. It never fabricates an extra payment or divides an annual award.

- [ ] Add a hand-calculated gross/fee/net fixture and a missing-fee negative case.
- [ ] Add only the needed source-backed role/fields and checked exact-cent computation.
- [ ] Verify school surplus includes only net posted school credits, not gross offer or fee twice.
- [ ] Run full suite and corpus, then commit a coherent passing change.

## Task 3 — M2-7c: Reversal and historical rule-version evidence (RC-14, RC-15, RC-46)

**Requirements:** S-16, S-19, S-22, S-23, S-24. **Risk:** HIGH.

- [ ] Add named reversal/cancellation/corrected-source fixtures with before/after receipts and exact attribution.
- [ ] Freeze a rule-version registry or typed unsupported-version behavior that preserves old receipt verification separately from explicit reanalysis.
- [ ] Test old results remain reproducible under their recorded rules; never silently rewrite a historical receipt.
- [ ] Run fixed corpus, 200 seeded smoke, and independent checker negatives before committing.

## Gate to M3

Update the case schema, native-port corpus, and RC evidence map after these tasks. Keep RC-12/13 import idempotency/overlap under M5 and RC-25/native parity under M3/M4. If an interface cannot be made evidence-safe, retain a typed unsupported result and an explicit open gate; do not claim a complete financial reference.
