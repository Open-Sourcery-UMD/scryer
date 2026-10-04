# Reference slice self-review — 2026-10-04

Review type: author self-review of baseline `453c208` through local commit `42584fc`. No independent human or second-agent review was performed. The reviewed plan was `plans/2026-10-04-reference-foundation.md`.

## Findings

1. **Important, fixed:** corrected-fact receipts carried only the current source reference. The original amount could not be traced from the receipt to its original source. Added `originalSourceRef` and checker validation; `test_changed_original_source_reference_fails_with_valid_digest` failed before the fix and passed afterward.
2. **Important, fixed:** direct dictionary input to the checker could recurse until `RecursionError` on a deeply nested receipt. Replaced recursive shape inspection with a bounded iterative walk; `test_deeply_nested_direct_receipt_is_typed_invalid` failed before the fix and passed afterward.
3. **Important, open for the next M2 task:** the current case schema has term IDs but no explicit institution or account-reference identities. Matching deposits across accounts safely requires those identities. No matching support is claimed until this contract is extended and tested. Cost if wrong: an unrelated deposit could become a false match.

The whole reference suite ran after the fixes: 46 tests, exit 0. A separate 200-seed synthetic receipt/checker run exited 0. The tests do not establish matching, bank coverage, actual UMD format compatibility, C++ parity, browser behavior, security certification, or the full backend release gate.
