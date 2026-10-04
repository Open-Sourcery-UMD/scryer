# Scryer client encryption format v1

Status: local implementation contract. It specifies bytes and failure behavior; it does not claim an independent security audit. See `../security/local-storage-design.md` for lifecycle and limits.

## Fixed algorithms and limits

Only `schemaVersion:"1"`, `algorithm:"AES-256-GCM+HKDF-SHA-256"`, `CasePackageV1.format:"scryer-case-v1"`, and `RecoveryEnvelopeV1.format:"scryer-recovery-wrap-v1"` are accepted. No envelope chooses an algorithm dynamically. IDs (`accountId`, `caseId`, `revisionId`) match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. `keyGeneration` is an integer in `[1,2147483647]`. `deviceId` and `packageId` are canonical unpadded base64url encodings of exactly 16 bytes. A recovery secret is the literal prefix `scryer-recovery-v1:` followed by canonical unpadded base64url of exactly 32 bytes.

Canonical base64url has only `A-Z a-z 0-9 - _`, no `=`, whitespace, alternate alphabet, or surplus bits; decode then re-encode must reproduce the input. The salt is 16 bytes, AES-GCM nonce 12 bytes, tag 16 bytes, and account root/recovery secret 32 bytes. A package carries 1–8 ordered chunks with indices `0..count-1`. Each nonempty plaintext chunk is at most 4,194,304 bytes, so its ciphertext string is at most 5,592,406 base64url characters; the separate tag has exactly 22 characters. Combined UTF-8 plaintext is at most 33,554,432 bytes, and a canonical serialized package is at most 50,331,648 bytes (48 MiB). A package with empty plaintext is invalid. A caller reserves one encryption use per chunk before sealing. The per-derived-key ceiling is 1,048,576 uses; attempt to reserve beyond it fails `KEY_USE_LIMIT`.

## Serialization and associated data

All header strings are validated bounded ASCII before encryption/decryption. Ordered JSON means `JSON.stringify` of an object constructed in the exact key order printed below, without whitespace, followed by `TextEncoder` UTF-8 bytes. There are no optional or null fields in these headers. Other implementations must produce the same bytes. Decryption rejects unknown and extra JSON fields before calling WebCrypto. Any untrusted serialized envelope/archive must be UTF-8 decoded fatally, parsed, validated, reserialized in the defined member order, and compared byte-for-byte with the original. This canonical-input rule rejects duplicate JSON keys and alternate textual forms without relying on a reviver that loses duplicates.

The case-key HKDF input keying material is the 32-byte random account root. Salt is UTF-8 `scryer:case-key:v1`. Info is ordered JSON:

```json
{"schemaVersion":"1","purpose":"case-payload-v1","accountId":"acct-demo","caseId":"case-demo","keyGeneration":1,"deviceId":"AAECAwQFBgcICQoLDA0ODw"}
```

The example values change with the account/case/generation/device. Derive 32 bytes with HKDF-SHA-256 and import them as an AES-GCM key. The receiving device uses the sender `deviceId` from the authenticated package header to derive the same key.

The case package has exact top-level keys in this order (parsers may accept another member order but serialization writes this order):

```json
{"schemaVersion":"1","format":"scryer-case-v1","algorithm":"AES-256-GCM+HKDF-SHA-256","accountId":"acct-demo","caseId":"case-demo","revisionId":"rev-demo","deviceId":"AAECAwQFBgcICQoLDA0ODw","keyGeneration":1,"packageId":"EBESExQVFhcYGRobHB0eHw","chunks":[]}
```

The example's empty `chunks` array illustrates top-level field order only and is not a valid package. Each actual chunk has exact keys `index`, `nonce`, `ciphertext`, `tag` in that order. Its AAD is ordered JSON with exact fields and order `schemaVersion`, `format`, `algorithm`, `accountId`, `caseId`, `revisionId`, `deviceId`, `keyGeneration`, `packageId`, `chunkIndex`, `chunkCount`, `nonce`. `chunkIndex` and `chunkCount` are JSON integers. `nonce` is the canonical base64url string of the 12-byte random AES-GCM nonce. Encrypt one plaintext chunk with 128-bit GCM tag. WebCrypto returns ciphertext followed by tag; split the final 16 bytes into `tag`, and base64url-encode both separately. The package ID is newly random for every seal operation, even when case/revision/plaintext repeat. Different chunks of one package use independent random nonces. A deliberate key/nonce reuse is forbidden.

The recovery wrapping key uses the 32-byte decoded high-entropy recovery secret as HKDF input, the envelope's fresh 16-byte `salt`, and ordered JSON info with exact fields `schemaVersion`, `purpose`, `accountId` and purpose `recovery-wrap-v1`. Derive 32 bytes and import as AES-GCM. The recovery envelope has exact keys in this order:

```json
{"schemaVersion":"1","format":"scryer-recovery-wrap-v1","algorithm":"AES-256-GCM+HKDF-SHA-256","accountId":"acct-demo","salt":"QEFCQ0RFRkdISUpLTE1OTw","nonce":"UFFSU1RVVldYWVpb","ciphertext":"<base64url 32-byte root ciphertext>","tag":"<base64url 16-byte tag>"}
```

Its AAD is ordered JSON of the first six fields through `nonce`. Encrypt exactly the 32 root bytes. Recovery verification derives 32 bytes from the live root and the unwrapped root using HKDF-SHA-256 salt UTF-8 `scryer:recovery-verify:v1` and ordered JSON info `{schemaVersion:"1",purpose:"recovery-verify-v1",accountId}`; compare every byte without an early exit. JavaScript execution does not guarantee constant-time behavior. This proves the re-entered secret opens the current root, without persisting a plaintext proof.

## Open, reject, and rollback rules

Before decryption, validate object shape, exact key set, fixed version/algorithm, ID bounds, canonical encodings and decoded lengths, generation, 1–8 contiguous chunk indices, per-chunk encoded size, and total possible decoded size. Check the expected account/case/revision binding before returning data. Authentication covers every package-level header field and each chunk's index/count/nonce. A missing, duplicate, reordered, truncated, or mixed chunk fails. Decrypt all chunks into private temporary buffers; do not expose any chunk until every tag passes and the complete UTF-8 payload decodes. The storage layer then parses exact `StoredCaseV1` and validates the case/ledger before revealing it.

Stable errors are `CRYPTO_UNAVAILABLE`, `INVALID_ENVELOPE`, `UNSUPPORTED_CRYPTO_VERSION`, `WRONG_BINDING`, `AUTH_FAILED`, `CASE_TOO_LARGE`, `KEY_LOCKED`, and `KEY_USE_LIMIT`. Format/version failure precedes key derivation; wrong explicit expected binding precedes decryption; a valid-shaped but tampered authenticated header or ciphertext fails `AUTH_FAILED`. Errors never contain plaintext values, key bytes, or recovery material. Encryption does not prove source authenticity or server freshness. An existing device may compare its locally remembered revision anchor; a fresh device without an independent anchor cannot detect coordinated rollback of both server data and revision metadata.

`tests/crypto/vectors.json` freezes a synthetic Node/OpenSSL interoperability vector. Chrome opens the vector and Node `crypto` independently decrypts a Chrome-generated package in the M6-2 tests. These checks establish byte compatibility, not an independent security proof.

Portable archives additionally use an account-root-derived HMAC-SHA-256 key to authenticate the complete archive member list and metadata. Its exact derivation, canonical bytes, and restore rules are frozen in `archive-v1.md`; a real Chrome archive tag is independently recalculated with Node/OpenSSL in `tests/browser/test_archive.mjs`.
