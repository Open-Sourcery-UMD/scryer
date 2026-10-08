# Recipient matching self-review — 2026-10-04

Review type: author self-review of M2-7a. No independent human or second-agent review occurred.

## Findings and disposition

1. **Fixed:** A fully allocated refund could appear as `MATCHED_BY_REVIEW` when querying a different bank account, with no allocations on that account. An account-specific regression test failed before the fix. The result now says `MATCHED_ON_OTHER_ACCOUNT_BY_REVIEW` and lists no selected-account allocation.
2. **Controlled limitation:** `recipientKind` and `holderKind` are broad reviewed categories, not externally verified person identities or bank ownership. Matching categories yield only suggestions; review is needed to confirm. A cross-recipient confirmation additionally requires an instruction artifact linked to the selected account or no account and observed by the review time. The artifact class and chronology are validated, while its real-world authenticity remains outside this reference model.
3. **Remaining gate:** The browser review workflow must display this uncertainty and source basis clearly. Native and WASM engines must reproduce the same outcomes before any release claim.

Verification: 124 standard-library reference tests passed, including the new negative and exception cases. The fixed corpus has 24 operations across eight synthetic fixtures. An independent checker accepted 200 generated synthetic school-surplus receipts. JSON contracts and `git diff --check` passed. None of this establishes live banking or school-source authenticity.
