# Gross/net aid self-review — 2026-10-04

Review type: author self-review of M2-7b. No independent human or second-agent review occurred.

## Findings and disposition

1. **Fixed:** A gross offer could have been mistaken for money disbursed. The contract now separates `aid_offer` from source-backed `aid_gross_disbursement`; an offer-only snapshot leaves gross disbursement unknown.
2. **Fixed:** A fee correction or late artifact could otherwise alter the reconciliation without contemporaneous source evidence. Gross/fee facts and their corrections require an `aid_disbursement_statement` artifact observed by the review time. Negative tests failed before these validations were added.
3. **Controlled limitation:** Arithmetic describes the selected reviewed records, not a complete loan ledger. A missing fee record is never inferred from a gross/net gap; the gap remains a finding. The source artifact class is locally reviewed and not externally authenticated.

Verification: the focused gross/net suite has 9 passing tests; the full reference suite has 133. The 27-operation fixed corpus includes offer-only, missing-fee, and fee-explained states in the new synthetic fixture. School surplus remains 99000 cents in all three states because gross and fee evidence is not a posted school movement. JSON contracts and whitespace checks passed. Native/WASM and browser import parity remain open.
