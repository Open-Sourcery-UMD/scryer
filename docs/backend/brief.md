# Backend contract

Scryer helps a student trace promised aid through school-account postings, refund issuance, and an observed bank deposit. It retains evidence, explains exact changes, and states what the uploaded records cannot establish. The first domain is student financial aid, in USD. The product does not decide eligibility, legal entitlement, or whether a school owes a refund.

The supported flow is local source file → extraction proposal → explicit review → immutable approved history → deterministic projection, findings, and receipts → encrypted local case → optional ciphertext sync. An unreviewed proposal has no financial effect. A source observation, a user approval, and an institution-authenticated fact are different things.

The C++20 core owns production financial semantics and is built for native and WebAssembly. Python is an independent oracle, scenario generator, and receipt checker. Headless TypeScript owns browser adapters, reviewed commands, worker integration, encrypted IndexedDB storage, recovery, and sync. PostgreSQL and a local OIDC provider support an opaque encrypted-case API. The API cannot see or reconcile financial plaintext.

This assignment produces a **local backend candidate**, not a public service or finished user interface. Public signup, deployment, legal/privacy approval, independently reviewed security, validated real UMD document formats, user-value research, and funded operation remain separate gates. All tests and fixtures in this branch use synthetic data.

The source assignment is the user-provided Scryer backend master execution prompt, sections 0–21 and Appendices A–C. `requirements.yaml` tracks every S-01 through S-78 source issue without treating this brief as completion evidence.
