# Recovery-envelope API slice

Status: selected local design for the next M7 slice. The user has explicitly authorized local implementation without repeated plan-approval pauses. This is a scoped transport/storage contract, not completion of cross-device recovery or rotation.

## Boundary and decision

The browser already creates and verifies `RecoveryEnvelopeV1`. The server stores only its exact encrypted JSON bytes and a SHA-256 digest; it never receives the recovery secret or root key and cannot prove that a wrapper decrypts. The authenticated account ID must match the wrapper's account ID. The existing `scryer.recovery_wrappers` table has a per-account integer generation and enough space for a bounded wrapper, so no migration is needed.

`GET /v1/account/recovery-envelope` returns the exact stored JSON bytes with `ETag: "<generation>"` or a tenant-scoped `404`. `PUT` accepts the exact canonical wrapper JSON plus a saved `Idempotency-Key`. Initial creation requires `If-None-Match: *`. On success it returns `{kind:"recovery",generation:1,wrapperDigest,etag}` and the same strong ETag. A missing precondition is `428`, a stale generation is `412`, and key reuse with different bytes or precondition is `409`. A replay of an old receipt after a newer wrapper is installed fails stale rather than presenting the old wrapper as current. A syntactically valid `If-Match: "<generation>"` currently returns `RECOVERY_ROTATION_UNSUPPORTED` (`409`) when it matches the live generation; replacement cannot safely switch a wrapper without coordinating every encrypted head and stale device. The table generation remains bounded to 32-bit signed positive values for that future protocol.

The parser requires the exact eight `RecoveryEnvelopeV1` fields in canonical order, fixed version/format/algorithm, valid opaque account ID, canonical unpadded base64url, and decoded lengths of 16-byte salt, 12-byte nonce, 32-byte ciphertext, and 16-byte tag. The HTTP body cap is 4096 bytes. The service verifies structure and account binding, not the AES-GCM tag; the browser must verify recovery-secret re-entry before upload.

## Verification sequence

1. Write parser tests for a fixed synthetic wrapper and duplicate/order/base64/version/binding/size failures; observe failure before implementation.
2. Write PostgreSQL store tests for create/retry, stale and unsupported replacement, changed-key reuse, cross-tenant isolation, corruption refusal, and a changed wrapper after a cached receipt; observe failure before implementation.
3. Add the two HTTP routes and generated OpenAPI contract assertions; test exact bytes, tenant binding, disabled account, body/precondition bounds, and no-store headers.
4. Run the full sync suite on private PostgreSQL 15 and cached PostgreSQL 16; run the existing synthetic Chrome/FastAPI/PostgreSQL journey to detect regression. Record the exact results and commit a coherent slice.

## Remaining integration gate

The existing local root/secret rotation replaces cases and the local wrapper atomically, while independent server calls cannot atomically switch all devices. A standalone server replacement would allow old-device writes under an old root and strand newer cases. M8 must define and test an account-wide encrypted transition or an explicit reviewed recovery flow before enabling replacement or claiming synchronized rotation. Real JWT verification and provider-to-API integration remain blocked separately. No user-facing recovery claim follows from this storage endpoint alone.
