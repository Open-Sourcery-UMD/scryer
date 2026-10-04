# Engine contract v1

The versioned request is UTF-8 JSON with duplicate object keys rejected at the boundary. Unknown fields fail rather than silently affecting meaning. IDs and canonical semantic output strings are bounded printable ASCII; arbitrary source text remains in local evidence storage and does not enter the canonical receipt. JSON money uses canonical integer strings only. `schemaVersion` is `1`.

`CaseInput` owns `caseId`, `termIds`, `artifacts`, `proposals`, and `events`. Every `SourceArtifact` has an opaque `artifactId`, locally computed SHA-256, source class, and `observedAt` UTC. A proposal has provenance but no engine effect. `approve_fact` contains `factId`, term ID, evidence role, nonnegative `amountMinor`, effective source date or null, source reference or a manual marker, and review ID. A correction contains `factId`, nonnegative replacement amount or a cancellation flag, source reference, and review ID. Every event has `eventId`, `parents`, `recordedAt` UTC, and kind. Events are immutable.

For M2 the executable operations are:

- `validate_case(case) -> validated case | typed error`.
- `project_school_surplus(case, heads, term_id) -> projection`.
- `compare_school_surplus(case, before_heads, after_heads, term_id) -> comparison`.
- `make_school_surplus_receipt(case, heads, term_id) -> receipt`.
- `check_school_surplus_receipt(case, receipt) -> checker result`, implemented independently from the production engine.

Later required versioned operations are capability inspection, historical/timeline projection, matching and allocations, coverage, discrepancy queue, source/calculation traversal, batch evaluation, and receipt generation for supported metrics. These remain unimplemented until their detailed schemas and negative tests are frozen. No placeholder success response is allowed.

For a school-surplus query, output includes `schemaVersion`, `engineVersion`, `ruleVersion`, `caseId`, sorted `heads`, `termId`, `status`, `amountMinor` or null, sorted participating `factIds`, and stable limitation codes. A conflicting correction returns `CONTRADICTORY_EVIDENCE` with null amount. If no selected approved facts exist, status is `INSUFFICIENT_COVERAGE` with null amount. A source-based total does not imply the source set is complete.

Canonical semantic serialization uses UTF-8 JSON without whitespace, ASCII keys sorted lexicographically, ASCII string values, arrays in specified order, booleans and null, and no JSON numeric monetary values. Optional absent fields and explicit null are different. Untrusted JSON with duplicate keys is rejected. SHA-256 digests cover the canonical receipt core without the `digest` field or incidental runtime metadata. Native and WASM output must agree byte-for-byte for the canonical semantic subset; randomized ciphertext is compared after decryption, never byte-for-byte.

The first supported receipt has exact top-level fields `schemaVersion`, `engineVersion`, `ruleVersion`, `metric`, `caseId`, `heads`, `termId`, `status`, `amountMinor`, `facts`, `limitations`, and `digest`. `heads` and `facts` are sorted by ID. Each fact step has its ID, role, original/current amount, signed contribution, approval/correction event IDs and review IDs, recorded times, effective source date, original source reference, and current source reference. Artifact references include the local artifact SHA-256 and observation time; manual references carry a distinct entry ID. The receipt explicitly says source authenticity is unverified. Its checker validates the stated query and arithmetic against the supplied approved case but cannot certify document authenticity or completeness.

The native CLI will eventually expose `--help`, `--version`, `validate`, `project`, `compare`, `receipt`, `verify-receipt`, and `demo`, with explicit input/output paths and nonzero typed failures. This contract does not claim those commands already exist.
