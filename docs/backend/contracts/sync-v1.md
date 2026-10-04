# Ciphertext sync protocol v1

Status: the exact chunk/manifest parser and assembler are implemented and locally tested. A synthetic Chrome outbox was accepted by the independent Python parser and reproduced the same encrypted package digest. Routes, authentication, PostgreSQL publication, and the official transport client remain M7 work. This is a contract, not a claim that a service is running.

## Identity and transport

The browser uses OIDC authorization code with PKCE and sends an access token in `Authorization: Bearer`. The service validates issuer, audience, algorithm, signature, expiry, not-before, and current account state before any tenant operation. It derives an opaque `accountId` from verified identity and service account state. Every `accountId` in a ciphertext body must match that derived identity. Other body fields never select a tenant. This service does not accept source documents, bank credentials, names, dates, amounts, or decrypted cases.

`/v1` is the only API version. Mutating requests require `Content-Type: application/json` and a bounded `Idempotency-Key` with the browser's saved exact request bytes. Requests carrying case data use `Cache-Control: no-store` responses. The planned API is:

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /health/live` | none | `200` liveness |
| `GET /health/ready` | none | `200` only when database and auth configuration are ready; otherwise `503` |
| `GET /v1/account` | bearer token | opaque account ID, status, capabilities, quota usage |
| `GET /v1/cases?limit=50&cursor=…` | bearer token; limit 1–200 | opaque case IDs, heads, opaque continuation cursor |
| `GET /v1/cases/{caseId}` | bearer token | current encrypted package and revision metadata, or a generic tenant-scoped `404` |
| `GET /v1/cases/{caseId}/revisions/{revisionId}` | bearer token | authorized retained encrypted package |
| `POST /v1/cases/{caseId}/chunks` | exact `ChunkRequest` and idempotency key | `202` staged chunk receipt |
| `POST /v1/cases/{caseId}/revisions` | exact `ManifestRequest`, idempotency key, and create/update precondition | `201` created or `200` updated; revision and ETag |
| `DELETE /v1/cases/{caseId}` | idempotency key and exact `If-Match` head | `200` opaque tombstone receipt |
| `GET/PUT /v1/account/recovery-envelope` | bearer token; strict encrypted wrapper only | current encrypted wrapper/version or update receipt |
| `GET/POST/DELETE /v1/account/devices` | bearer token; bounded opaque device metadata | list, register, or revoke receipt |
| `DELETE /v1/account` | bearer token and explicit lifecycle precondition | `202` deletion reconciliation receipt; new access denied immediately |

No route is considered implemented until its generated OpenAPI contract and integration tests pass. Pagination cursors will bind account, sort key, and expiry under a server secret; malformed or cross-account cursors fail closed. The service does not semantically merge cases. Historical revisions remain authorized and quota-accounted until explicit documented compaction.

## Exact prepared chunk and manifest bytes

`client/storage/repository.ts` durably stores the complete chunk and manifest body strings before transmission. They are UTF-8 encoded verbatim on every retry. The server rejects duplicate JSON members, unknown members, reordered members, noncanonical whitespace/escaping/base64url, unsupported versions/algorithms, invalid ID bounds, and any body whose `accountId` differs from the authenticated account. The server's parser compares exact received bytes to canonical JSON reserialization. The on-wire key order is:

```text
ChunkRequest: schemaVersion, kind, accountId, caseId, revisionId, packageId,
              index, chunkCount, nonce, ciphertext, tag
ManifestRequest: schemaVersion, kind, format, algorithm, accountId, caseId,
                 revisionId, deviceId, keyGeneration, packageId, chunkCount,
                 chunkDigests, packageDigest
```

`schemaVersion` is `"1"`; kinds are `"chunk"` and `"manifest"`. The manifest format and algorithm are exactly `"scryer-case-v1"` and `"AES-256-GCM+HKDF-SHA-256"`. Account/case/revision IDs are 1–64 bounded opaque ASCII identifiers per `crypto-v1.md`; 16-byte `packageId` and `deviceId` use canonical unpadded base64url and may begin with `-` or `_`. There are 1–8 chunks, indexed `0..count-1`; nonces are 12 bytes, tags 16 bytes, and nonempty ciphertext chunks at most 4 MiB decoded. `chunkDigests[i]` is lowercase hex SHA-256 of the exact ith chunk body. `packageDigest` is lowercase hex SHA-256 of the browser's ordered serialized `CasePackageV1` constructed from the matching chunks. This digest checks transport assembly; it does not authenticate financial contents or prove that an account holder reviewed them.

The manifest may publish only when every chunk is present, belongs to the same account/case/revision/package, has the declared count/index, matches its exact body digest, and assembles to the declared package digest. Chunks may arrive in any order. A failed manifest leaves the old head intact. A staged chunk is not a visible case revision. Staging expiry and quota accounting must be enforced in the database implementation.

The server accepts at most 8 MiB decoded encrypted envelope bytes (ciphertext plus nonce/tag bytes), 8 MiB per chunk HTTP body, 16 KiB manifest body, and 12 MiB for any HTTP request. The browser's local store can hold a 32 MiB plaintext case, so a case larger than the sync ceiling remains available locally and receives an explicit `413` sync result; a quota failure never erases its local edit.

## Concurrency, retries, and errors

Create uses exactly `If-None-Match: *`. Update and delete use a strong quoted revision such as `If-Match: "rev-demo"`; weak ETags, wildcards for updates, missing headers, and malformed values are rejected. The manifest is the atomic commit boundary. The idempotency identity is the verified account plus key; its digest includes method, path, exact body, and precondition. A replay with the same digest returns the original receipt only while the account/case lifecycle still allows it. Reuse with changed bytes or precondition is `409`. Concurrent manifests on the same head serialize; a stale expected head is `412` and does not overwrite the other branch. A missing required precondition is `428`.

The planned response error shape is `{ "error": { "code": "STABLE_CODE", "requestId": "opaque-id" } }`, without financial data or raw user input. Invalid/expired token is `401`; cross-tenant reads and unauthorized nested resources use indistinguishable `404`; malformed wire is `400`; stale precondition is `412`; idempotency conflict is `409`; size/quota rejection is `413`; rate limiting is `429` with bounded `Retry-After`; database unavailability is `503`. Transport faults alone may be retried with backoff and jitter. The client preserves the prepared outbox and local approved state on every non-successful sync attempt.

Server revision, local encrypted-store revision, and domain knowledge head are separate. Successful transport does not approve a financial fact. On two-device divergence, the client must preserve both ciphertext variants and obtain reviewed semantic resolution; no server last-writer-wins path exists.
