# ADR 0003 — Local identity and opaque sync

Status: selected architecture, protocol details still require M7 implementation review.

Use a locally self-hosted OIDC provider (Keycloak is the default candidate until a pinned version and loopback setup are verified). The browser uses authorization code with PKCE. The FastAPI service accepts only access tokens from configured issuer/audience/algorithm and trusted JWKS endpoint. Account state is checked after cryptographic verification. Logout and provider revocation have documented access-token lifetime limits; a disabled/deleted service account always denies new access.

`/v1` sync routes accept opaque encrypted envelopes only. Creation requires `If-None-Match: *`; update/delete require an exact `If-Match` head revision; missing precondition is `428`, stale precondition `412`, reused idempotency key with different bytes `409`, over-limit body `413`, bad token `401`, and documented throttling `429`. Cross-tenant paths must not reveal whether an object exists. An idempotency replay is checked against current account/case lifecycle before returning cached success. Persist the exact prepared client request before transmission.

Server limits are an 8 MiB decoded encrypted envelope, 12 MiB HTTP body, 256 MiB aggregate retained ciphertext per account, and list pages of 50 by default/200 maximum. Exact OpenAPI fields and pagination cursors are a required M7 design gate; no API route is accepted before a contract test. PostgreSQL migration/admin and application roles are separate; all tenant tables get forced RLS. A direct app-role query without a trusted account context must deny. The exact trusted transaction-context mechanism must resist caller-controlled `SET` spoofing and is a release-blocking M7 decision, not an assumed protection from ordinary custom GUCs.

Alternative rejected: bespoke password database and JWT issuer. Alternative rejected: plaintext server financial schema. Alternative deferred: a distributed queue or per-service database split; this local product has no measured need for them.
