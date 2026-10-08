# Historical receipt self-review — 2026-10-04

Review type: author self-review of M2-7c. No independent human or second-agent review occurred.

## Findings and disposition

1. **Verified in a named fixture:** An additional source correction and later cancellation do not erase the earlier approved head. The old 90000-cent receipt remains independently checkable. The corrected intermediate result is 70000 cents and the final result is 100000 cents; the +10000-cent change is exactly −20000 for the grant plus +30000 for the cancelled charge.
2. **Controlled limitation:** Both reference producer labels use the same `school-surplus-1` monetary rule. A `reference-0.2.0` reanalysis receipt is generated only by an explicit call with explicit new heads. The version field and SHA-256 digest are not a digital signature or proof of which binary produced externally supplied data.
3. **Remaining gate:** Native and WASM engines need their own versioned implementation and differential checks. Local storage and sync must preserve archived receipt bytes and the original source artifacts through migration and restore.

Verification: 137 reference tests passed. The fixed corpus has 33 operations across ten synthetic fixtures, including before/after receipt digests and reanalysis linkage. A 200-seed synthetic receipt run passed independent checking and exact historical reproduction. JSON parsing and whitespace checks passed.
