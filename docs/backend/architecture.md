# Architecture and boundaries

The source of financial truth is a locally stored, versioned, approved event journal. Sources and parser proposals are evidence, not postings. A pure engine accepts a validated case snapshot and explicit query and returns canonical semantic output. Native CLI and browser WASM must use the same C++ source. Python computes independently for differential testing.

The browser holds plaintext only while unlocked. It encrypts the complete case payload before IndexedDB persistence and before optional sync. Original files remain on the originating device unless explicitly included in an encrypted portable archive. Another device may know a source hash and reviewed excerpt but must report the original file unavailable until correctly reattached.

The local sync service is a modular FastAPI application backed by PostgreSQL. A pinned local OIDC provider supplies authentication; the service verifies tokens and derives account identity from verified claims plus account state. The service stores opaque case IDs, encrypted revisions, key wrappers, idempotency keys, tombstones, and bounded operational metadata. It has no plaintext financial fields, parser, reconciliation endpoint, or document upload endpoint. Row-level security is an additional database boundary, not a substitute for application authorization.

Transport revision, local encrypted-store revision, and domain knowledge snapshot are separate values. A server revision cannot change financial meaning by itself. Two devices with divergent approved journals require a reviewed merge or preserved variants. A stale write never silently overwrites an encrypted head.

The default local service architecture is FastAPI + PostgreSQL + a verified self-hosted OIDC provider, with a small deletion reconciler if cross-service lifecycle work needs it. Existing FastAPI is retained as the HTTP entrypoint. Prisma is not a second schema owner; no legacy plaintext rows are migrated without an explicit exact-value path. See the decisions directory for alternatives and limitations.
