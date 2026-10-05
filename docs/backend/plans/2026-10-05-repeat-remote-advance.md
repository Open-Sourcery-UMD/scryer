# M8-6g repeated remote-head advance

**Task ID, requirements, dependencies, and risk:** M8-6g; S-60, S-69, RC-34; CRITICAL. Depends on M8-6f's synthetic two-device joined-case publication, M8-6e's atomic local replacement, and M7's ciphertext CAS API.

**Design and scope:** Extend the disposable Chrome/FastAPI/PostgreSQL journey after its first successful joined publication. From that joined server revision, let two devices approve different new manual bank facts. Publish one branch, review and locally queue a second `resolve_branches` case on the losing device, then publish another event on the winning device before the queued join syncs. The stale joined publish must return a typed conflict. Check that its local encrypted case, exact pending operation, and both branch histories survive unchanged; browser preview must open the newly advanced remote branch. Validate the joined case with the native CLI outside Chrome. No automatic retry against a changed precondition and no monetary choice by event-ID ordering are permitted.

**Verification and limits:** Run the complete two-test synthetic integration file using actual Chrome, loopback FastAPI, and a disposable PostgreSQL database. Record the command and result in the verification ledger. This is synthetic identity and injected browser semantic validation, not production JWT/WASM, human review UI, or a full arbitrary-branch merge. A later explicit review would be needed to reconcile the second conflict.

**Done:** The second CAS conflict leaves the joined local revision and saved request byte-identical, the returned remote revision is authenticated and previewed in Chrome, and the source-text sentinel remains outside observed wire and database plaintext surfaces. Keep the overall outcome `BACKEND_PARTIAL_LOCAL`.
