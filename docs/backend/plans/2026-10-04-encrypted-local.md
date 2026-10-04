# Encrypted Local Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user-provided backend brief authorizes local inline execution and commits; no subagents or remote operations are authorized.

**Goal:** Store validated approved cases and import ledgers encrypted in the browser, with durable local revisions, recoverable keys, exact sync retries, and portable verified recovery.

**Architecture:** WebCrypto creates a random account root and a separate high-entropy recovery secret. A strict, versioned AES-GCM chunk package protects the complete case and ledger; authenticated headers bind account, case, revision, generation, device, package, and chunk position. IndexedDB commits the package and prepared ciphertext outbox together under local revision CAS, while a nonextractable in-memory session controls access.

**Tech Stack:** TypeScript 5.9.3, browser WebCrypto and IndexedDB, local Chrome/Playwright Core 1.63.0, independent Node `crypto` interoperability checks. No runtime network calls and no new cipher/KDF implementation.

**Spec:** `docs/backend/security/local-storage-design.md`, `docs/backend/security/crypto-design.md`, and attached backend brief sections 10 and 17.

## Global Constraints

- Entire approved case plus ledger is one logical revision. Raw original files are excluded by default.
- Plaintext JSON payload ≤32 MiB, chunk plaintext ≤4 MiB, 1–8 chunks; over-limit input returns `CASE_TOO_LARGE` before encrypting.
- AES-256-GCM with 12-byte random nonce and 16-byte tag; HKDF-SHA-256 with specified purpose/identity context. Exact header field order and strict unpadded base64url are part of the format.
- Every encryption operation gets a fresh random package ID and nonce. The durable per-device/per-case/per-generation reservation count must stay below `2^20`.
- No plaintext key, recovery secret, approved case, ledger, or raw file is written to IndexedDB or outbox.
- A local commit acknowledges only after IndexedDB `transaction.oncomplete`. A sync retry reuses stored ciphertext bytes and operation ID exactly.
- Wrong key, account/case/revision binding, tampering, missing chunks, unsupported version, quota denial, interrupted transaction, or stale revision fail typed without a partial plaintext or partial approved commit.
- Browser-side WASM validation remains `BLOCKED_TOOLING`; tests may inject the verified native case validator in headless interop, but do not claim that a browser review is production-validated until M4 is available.
- Each task uses red-green tests, focused self-review, applicable full suites, and one meaningful local commit. M6 status stays `IN_PROGRESS` until every required browser/recovery gate passes.

## Review Focus

1. A case encrypted twice at the same revision must use different package IDs/nonces while both decrypt correctly (Task 2).
2. A valid ciphertext with changed account, case, revision, device, generation, chunk count, or chunk order must not produce partial plaintext (Task 2).
3. Two tabs committing from the same local revision must leave exactly one new case/outbox pair; the loser receives a stale-revision error (Task 3).
4. A browser crash or transaction abort between prepared encryption and commit must leave the prior approved revision and outbox intact (Task 3).
5. A wrong recovery secret or tampered backup must not replace the current local case, even after an archive preview starts (Task 4).

## File map

| File | Responsibility |
| --- | --- |
| `docs/backend/contracts/crypto-v1.md`, `security/local-storage-design.md` | Exact envelope, key, and storage contracts plus security limits. |
| `client/crypto/codec.ts` | Strict base64url, bounded UTF-8, ordered AAD, exact shape/ID validation. |
| `client/crypto/keys.ts` | Random root/recovery secret, HKDF hierarchy, wrap/unlock/verify, in-memory lock. |
| `client/crypto/envelope.ts` | Bounded AES-GCM case chunk sealing/opening with authenticated headers. |
| `client/storage/idb.ts` | Versioned IndexedDB connection, transaction completion, upgrade/abort handling. |
| `client/storage/repository.ts` | Case+ledger encrypted revision CAS, nonce-budget reservation, outbox atomicity. |
| `client/export/archive.ts` | Encrypted export, nonmutating preview, atomic restore. |
| `tests/client/test_crypto.mjs`, `tests/browser/test_crypto.mjs`, `test_storage.mjs` | Independent Node interop and real-browser negative/crash/recovery tests. |

## Task 1 — Freeze executable crypto/storage contract

**Requirements:** S-48, S-57, S-58, S-60, S-61; depends on M1 and reviewed M5 command contract. **Risk:** critical, format mistakes are hard to migrate.

- [x] Write exact field/encoding/AAD definitions and bounds in `contracts/crypto-v1.md`, including missing/unsupported versions and no partial plaintext semantics.
- [x] Add independent synthetic Node HKDF/AES-GCM vector generator/checker inputs; run the vector test before browser crypto exists.
- [x] Self-review key hierarchy, cross-device derivation, nonce budget, archive and sync size compatibility; record unresolved M4/M7 gates and commit M6-1.

## Task 2 — WebCrypto keys, recovery, and chunk envelopes

**Requirements:** S-57, S-58; depends on Task 1. **Interfaces:** `createAccountKeys`, `unlockRecovery`, `verifyRecoverySecret`, `AccountSession.lock`, `sealCase`, `openCase`. **Risk:** critical, plaintext confidentiality/integrity.

- [ ] Write failing Node/browser tests for random root/recovery generation, second-device unlock, wrong key, re-entry verification, lock, strict encoding, ciphertext randomization, independent Node decryption, every AAD binding, chunk loss/duplicate/reorder/mixing, tamper, downgrade, and limits.
- [ ] Run tests expecting missing crypto modules.
- [ ] Implement strict codecs and WebCrypto calls using platform primitives only; buffer all decrypted chunks until every tag validates.
- [ ] Run independent interoperability, typecheck, real-browser negative suite, native/reference regression; commit M6-2.

## Task 3 — IndexedDB atomic local repository and outbox

**Requirements:** S-48, S-57, S-59, S-60; depends on Task 2. **Interfaces:** `openLocalRepository`, `commitReviewed`, `loadCase`, `prepareSync`, `ackSync`, `reserveEncryptions`, `lock`. **Risk:** critical, approved-history loss or duplicate sync.

- [ ] Write failing real-browser tests for empty/open/locked states, encrypted at-rest inspection, revision CAS with two tabs, transaction abort/reload, storage denied/quota simulation, counter exhaustion, durable outbox retry-byte identity, and no plaintext sentinel in stored records.
- [ ] Run tests expecting missing repository.
- [ ] Implement upgrade v1 and transaction-complete acknowledgment, separate budget reservation, atomic package/outbox write, typed local errors, and locally remembered revision/digest anchors.
- [ ] Run browser tests plus headless/native/reference suites; inspect every write path for plaintext and commit M6-3.

## Task 4 — Encrypted archive, preview, restore, and migration

**Requirements:** S-58, S-61, S-62; depends on Task 3. **Interfaces:** `exportEncrypted`, `previewRestore`, `restoreEncrypted`, versioned migration. **Risk:** high, irreversible user-data replacement.

- [ ] Write failing browser tests for portable archive round trip, fresh-device recovery, wrong secret, header/ciphertext tamper, conflict preview without mutation, default originals omission, explicit bounded encrypted originals inclusion, interrupted restore, and pre-upgrade export/rollback.
- [ ] Run tests expecting missing archive commands.
- [ ] Implement exact archive validation, full decrypt/semantic-validation preview, separate expected-revision restore transaction, and reversible schema migration.
- [ ] Run full browser and independent interop suites, review backup semantics, and commit M6-4.

## Task 5 — Generation rotation and complete recovery gate

**Requirements:** S-57, S-58, S-60, S-61; depends on Tasks 2–4. **Interfaces:** `rotateGeneration`, `rotateRecoverySecret`, second-device import/unlock. **Risk:** critical, loss of access under interruption.

- [ ] Write failing browser tests for counter-limit-triggered rotation, interrupted re-encryption, old backup compatibility, new-secret verification, two-device independent key derivation, stale generation conflict, and lock/key-loss behavior.
- [ ] Run tests expecting missing rotation.
- [ ] Implement journaled generation/recovery wrapper transition and resume/rollback state; never retire old material before verification and a complete local transaction.
- [ ] Run clean offline install, typecheck, browser, independent Node crypto, native/reference suites, privacy scan, and task ledger; commit M6-5 only if the gates pass.

## Gate to M7

M6 is `VERIFIED_LOCAL` only after actual browser tamper, crash, CAS, recovery, restore, and rotation tests pass and an independent crypto implementation checks the specified bytes. M4 browser WASM validation and M7 multi-chunk sync atomicity remain separately open; they cannot be relabeled as M6 evidence. If either blocks full completion, leave M6 `IN_PROGRESS` with exact passing slices and continue dependency-ready work.
