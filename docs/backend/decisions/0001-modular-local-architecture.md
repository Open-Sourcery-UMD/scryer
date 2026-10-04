# ADR 0001 — Local modular architecture

Status: accepted for reversible synthetic-only engineering, 2026-10-04. Human review pending.

Decision: keep the existing FastAPI entrypoint, add PostgreSQL as the sole server schema authority, use a locally self-hosted OIDC provider, and put financial computation in one C++20 source built native and WASM. Python independently checks semantics. TypeScript handles local parsing, review, encryption, and persistence.

Alternatives: retaining plaintext Prisma transactions would violate the client-encryption boundary and retain float money. Implementing the domain only in Python or TypeScript would miss the required cross-runtime systems exercise. Multiple microservices and a queue would add operations without a distinct need.

Consequence: the C++/WASM boundary adds build and validation work. The browser must handle secrets and therefore cannot be called safe against malicious delivered JavaScript. Real UMD document compatibility and production hosting remain independent validation gates. No server migration from legacy float rows occurs automatically.

Design review: the architecture keeps raw files and financial values off the API; a local provider avoids custom passwords; the sync server cannot inspect case semantics; journal and transport revisions are separate; unsupported document layouts remain explicit. The highest unresolved implementation risk is cross-device recovery and concurrent encrypted revisions, so cryptography and sync get separate gates before coding.
