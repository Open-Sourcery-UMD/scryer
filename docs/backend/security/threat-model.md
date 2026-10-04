# Local backend threat model — design baseline

Assets: original financial files, reviewed facts and history, account data keys, recovery secret, locally remembered revision anchors, opaque sync ciphertext, identity links, backups, and availability of a user's current approved case.

Untrusted inputs include files, CSV/PDF contents, filenames, imported archives, JSON requests, browser storage contents, remote ciphertext, concurrent device writes, and identity tokens until verified. A different authenticated tenant is adversarial. The sync host and identity provider are trusted for access control and availability, but are not trusted with case plaintext. A compromised browser delivery path or unlocked device can read plaintext; client-side encryption does not prevent that.

Boundaries and controls:

1. File → local proposal: enforce byte/row/field/decompression limits, safe parsers, no external fetches or code execution, and explicit human review before approval.
2. Proposal → approved journal: immutable event IDs, exact cents, atomic commit, idempotent review operation, and conflict detection.
3. Journal → C++/WASM: strict versioned validation, bounded computation, checked arithmetic, explicit error translation at ABI boundaries.
4. Plaintext → encrypted browser store: platform cryptographic randomness and AEAD, authenticated metadata, no plaintext outbox, explicit unlock/lock, tamper and recovery tests.
5. Client → sync: ciphertext-only approved routes, strict token validation, tenant derived from verified identity and account status, CAS/idempotency, quotas, RLS, and no sensitive logs.
6. Backup/restore: integrity and version checks, isolated restore rehearsal, deletion replay, and disclosed physical-erasure limits.

Known limits: ciphertext length, timing, account identity and traffic volume remain visible. A malicious server can withhold data and may roll back both ciphertext and server revision state; an existing device can compare a local anchor, but a new device without an independent anchor cannot prove freshness. Login password reset cannot decrypt data. Losing every unlocked device and the recovery secret loses access. No claim of independent human security review is made.

Before any local Codex Security scan, verify local execution mode, data boundary, cost, credentials, target, and scratch path. The available cloud workflow is prohibited for this assignment. Static/threat-model review does not certify the software safe.
