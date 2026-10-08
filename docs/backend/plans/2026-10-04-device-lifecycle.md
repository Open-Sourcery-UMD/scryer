# Opaque device registry and publication boundary

## Scope and security meaning

The existing `devices` table becomes an account-scoped registry for the random
16-byte device ID already authenticated inside each encrypted package. A
verified account token can register, list, and retire IDs. A manifest can
publish only while its ID is registered and active. Account deletion removes
the registry. The account row lock serializes registration, retirement,
publication, and deletion.

An ID is not a credential. A holder of an account bearer token can register a
different ID, so retirement does **not** revoke a provider session, invalidate
access tokens, stop ciphertext reads, or guarantee that an old device cannot
write under a new ID. UI and documentation must call this *device ID
retirement*, never account access revocation. Provider session revocation and
short token lifetime remain separate release requirements.

## v1 wire contract

- `POST /v1/account/devices`: canonical UTF-8 JSON bytes with keys in exact
  order `schemaVersion`, `deviceId`, values `"1"` and canonical unpadded
  base64url of exactly 16 bytes. Maximum body 256 bytes. Requires the saved
  `Idempotency-Key` `device:<deviceId>`; returns `200` with exact fields `kind:"device"`,
  `deviceId`, `status:"active"`. Existing active IDs succeed. Retired IDs
  never reactivate.
- `GET /v1/account/devices`: no query or request body; returns an ordered,
  bounded list of exact fields `deviceId`, `status`, `createdAt`, `retiredAt`,
  plus `activeLimit:16` and `totalLimit:256`. Timestamps are UTC ISO 8601.
- `DELETE /v1/account/devices/{device_id}`: canonical ID in path, empty body,
  saved `Idempotency-Key` `device-retire:<deviceId>`; returns `200` with `kind:"device"`, `deviceId`,
  `status:"retired"`. Retiring the same known ID again succeeds. A missing
  ID is a tenant-scoped `404`.
- All mutations use the account-wide idempotency namespace and digest exact
  method/path/body. Key reuse for a changed operation is `409`. The table
  caps active IDs at 16 and lifetime IDs at 256. Reaching either cap returns
  `409 DEVICE_LIMIT_REACHED`; a supportable archive/rekey workflow is future
  work. Deterministic keys prevent repeated registration or retirement of
  one ID from creating unbounded receipts. Global request rate and receipt
  quotas for other writes remain separate public-service work.
- A new manifest for an unregistered or retired ID returns
  `409 DEVICE_NOT_ACTIVE`; a previously committed manifest's exact retry
  also fails after retirement, while its committed revision stays available.
  Staged chunks can remain until normal expiry because chunk bodies have no
  device ID and do not publish a revision.

## Client and verification

The headless transport takes the device ID from each exact saved manifest,
validates it, and registers it before sending any saved chunks. Registration
uses deterministic body bytes and key `device:<deviceId>`, so lost responses
retry identically and a reload can repeat safely. It validates the server's
bounded receipt before proceeding. Failure preserves the outbox.

Recovery unlock starts with a new random ID. The local repository binds an
installation's first ID to its account record and reuses it after later
unlocks of the same database. An unlocked session is bound to one database;
opening another requires a fresh recovery unlock to prevent two independent
use counters for one case key. Both the normal opener and direct repository
constructor bind the session to the database name. A missing account record,
including one caused by browser database eviction, receives a new random ID
in the account transaction even if an unlocked session had previously used
that name. Existing v2 account records without an ID also receive a new ID;
corrupt stored IDs fail closed. Generation rotation keeps the ID. Recovery rotation creates a
new root and ID together, allowing a fresh nonce-use budget, then persists
that new ID atomically with the new root proof and binds the returned session
to that database before exposing it. This opaque ID is local
metadata, not a device secret or authentication factor.

The final reviewed-case write and archive-restore transactions read the account
root proof and current installation ID before publishing any case/outbox rows.
An old tab that remains unlocked after another tab commits root rotation fails
with `STALE_ACCOUNT_ROOT`, including when it tries to create a new case or
restore an old-root archive. A package uses one captured device ID for its
header and derived key; a reviewed commit checks it matches the device whose
use budget was reserved.

Tests first cover canonical parsing; account isolation; repeat/key conflict;
limits; retirement and no resurrection; new and replayed manifest denial;
server OpenAPI; saved-byte client retries; and an actual browser/API/PostgreSQL
journey. Run PG15 and PG16 suites, client tests/build, and local Chrome
integration before committing. Real JWT-to-API and provider session revocation
remain blocked or open under the existing status gates.
