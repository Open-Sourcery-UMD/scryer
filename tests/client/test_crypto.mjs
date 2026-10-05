import assert from 'node:assert/strict';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { base64UrlDecode, base64UrlEncode } from '../../client/crypto/codec.ts';
import { createAccountKeys, unlockRecovery, verifyRecoverySecret } from '../../client/crypto/keys.ts';
import { openCase, sealCase } from '../../client/crypto/envelope.ts';

const vector = JSON.parse(readFileSync(new URL('../crypto/vectors.json', import.meta.url), 'utf8'));
const fromHex = (value) => new Uint8Array(Buffer.from(value, 'hex'));
const b64Hex = (value) => base64UrlEncode(fromHex(value));
const flipped = (value) => { const bytes = base64UrlDecode(value); bytes[0] ^= 1; return base64UrlEncode(bytes); };
const codeOf = async (action) => { try { await action(); return null; } catch (error) { return error.code; } };

function vectorWrapper() {
  return {
    schemaVersion: '1', format: 'scryer-recovery-wrap-v1', algorithm: 'AES-256-GCM+HKDF-SHA-256',
    accountId: vector.accountId, salt: b64Hex(vector.recoverySaltHex),
    nonce: b64Hex(vector.recoveryNonceHex), ciphertext: b64Hex(vector.wrappedRootHex),
    tag: b64Hex(vector.wrapTagHex),
  };
}

function vectorPackage() {
  return {
    schemaVersion: '1', format: 'scryer-case-v1', algorithm: 'AES-256-GCM+HKDF-SHA-256',
    accountId: vector.accountId, caseId: vector.caseId, revisionId: vector.revisionId,
    deviceId: vector.deviceId, keyGeneration: vector.keyGeneration, packageId: vector.packageId,
    chunks: [{ index: 0, nonce: b64Hex(vector.caseNonceHex),
      ciphertext: b64Hex(vector.ciphertextHex), tag: b64Hex(vector.caseTagHex) }],
  };
}

test('browser-compatible crypto opens fixed independent Node/OpenSSL recovery and case vectors', async () => {
  const secret = `scryer-recovery-v1:${b64Hex(vector.recoverySecretHex)}`;
  const session = await unlockRecovery(vectorWrapper(), secret, vector.accountId);
  const opened = await openCase(session, vectorPackage(), vector.caseId, vector.revisionId);
  assert.equal(opened, Buffer.from(vector.plaintextHex, 'hex').toString('utf8'));
  assert.equal(await verifyRecoverySecret(session, vectorWrapper(), secret), true);
  assert.equal(await verifyRecoverySecret(session, vectorWrapper(), 'scryer-recovery-v1:' + base64UrlEncode(new Uint8Array(32))), false);
  assert.equal(await codeOf(() => unlockRecovery(vectorWrapper(), secret, 'different-account')), 'WRONG_BINDING');
  session.lock();
  assert.equal(await codeOf(() => openCase(session, vectorPackage(), vector.caseId, vector.revisionId)), 'KEY_LOCKED');
});

test('random creation and second-device unlock preserve plaintext without deterministic ciphertext', async () => {
  const created = await createAccountKeys('acct-local');
  const second = await createAccountKeys('acct-local');
  assert.notEqual(created.recoverySecret, second.recoverySecret);
  assert.notEqual(created.session.deviceId, second.session.deviceId);
  assert.equal(await verifyRecoverySecret(created.session, created.recoveryEnvelope, created.recoverySecret), true);
  const reopened = await unlockRecovery(created.recoveryEnvelope, created.recoverySecret, 'acct-local');
  assert.notEqual(created.session.deviceId, reopened.deviceId);
  const first = await sealCase(created.session, 'case-local', 'rev-one', '{"safe":"synthetic"}');
  const again = await sealCase(created.session, 'case-local', 'rev-one', '{"safe":"synthetic"}');
  assert.notEqual(first.packageId, again.packageId);
  assert.notEqual(first.chunks[0].nonce, again.chunks[0].nonce);
  assert.equal(await openCase(reopened, first, 'case-local', 'rev-one'), '{"safe":"synthetic"}');
  assert.equal(await openCase(reopened, again, 'case-local', 'rev-one'), '{"safe":"synthetic"}');
  created.session.lock();
  assert.equal(await codeOf(() => sealCase(created.session, 'case-local', 'rev-two', '{}')), 'KEY_LOCKED');
});

test('a package uses one device identity for its header and encryption key', async () => {
  const created = await createAccountKeys('acct-device-snapshot');
  const originalId = created.session.deviceId;
  const anotherId = (await createAccountKeys('acct-device-snapshot')).session.deviceId;
  let reads = 0;
  Object.defineProperty(created.session, 'deviceId', { get() {
    reads++;
    return reads === 1 ? originalId : anotherId;
  } });
  const pkg = await sealCase(created.session, 'case-device-snapshot', 'rev-one', '{}');
  assert.equal(pkg.deviceId, originalId);
  assert.equal(await openCase(created.session, pkg, 'case-device-snapshot', 'rev-one'), '{}');
  assert.equal(reads, 1);
});

test('strict envelopes reject changed bindings, versions, encodings, ciphertext and tags', async () => {
  const secret = `scryer-recovery-v1:${b64Hex(vector.recoverySecretHex)}`;
  const session = await unlockRecovery(vectorWrapper(), secret, vector.accountId);
  const original = vectorPackage();
  const changed = (path, value) => {
    const copy = structuredClone(original);
    if (path.startsWith('chunks.')) copy.chunks[0][path.slice(7)] = value;
    else copy[path] = value;
    return copy;
  };
  for (const [input, expected] of [
    [changed('accountId', 'acct-other'), 'WRONG_BINDING'],
    [changed('caseId', 'case-other'), 'WRONG_BINDING'],
    [changed('revisionId', 'rev-other'), 'WRONG_BINDING'],
    [changed('deviceId', b64Hex('101112131415161718191a1b1c1d1e1f')), 'AUTH_FAILED'],
    [changed('keyGeneration', 2), 'AUTH_FAILED'],
    [changed('schemaVersion', '0'), 'UNSUPPORTED_CRYPTO_VERSION'],
    [changed('format', 'scryer-case-v0'), 'UNSUPPORTED_CRYPTO_VERSION'],
    [changed('algorithm', 'AES-128-GCM'), 'UNSUPPORTED_CRYPTO_VERSION'],
    [changed('packageId', b64Hex('202122232425262728292a2b2c2d2e2f')), 'AUTH_FAILED'],
    [changed('chunks.nonce', b64Hex('707172737475767778797a7b')), 'AUTH_FAILED'],
    [changed('chunks.ciphertext', flipped(original.chunks[0].ciphertext)), 'AUTH_FAILED'],
    [changed('chunks.tag', flipped(original.chunks[0].tag)), 'AUTH_FAILED'],
    [changed('chunks.index', 1), 'INVALID_ENVELOPE'],
    [{ ...original, extra: true }, 'INVALID_ENVELOPE'],
    [changed('chunks.tag', original.chunks[0].tag + '='), 'INVALID_ENVELOPE'],
    [{ ...original, chunks: [] }, 'INVALID_ENVELOPE'],
  ]) {
    assert.equal(await codeOf(() => openCase(session, input, vector.caseId, vector.revisionId)), expected);
  }
  const wrapper = vectorWrapper();
  assert.equal(await codeOf(() => unlockRecovery({ ...wrapper, tag: flipped(wrapper.tag) }, secret, vector.accountId)), 'AUTH_FAILED');
  assert.equal(await codeOf(() => unlockRecovery({ ...wrapper, format: 'old' }, secret, vector.accountId)), 'UNSUPPORTED_CRYPTO_VERSION');
  const unrelated = await createAccountKeys(vector.accountId);
  assert.equal(await codeOf(() => openCase(unrelated.session, original, vector.caseId, vector.revisionId)), 'AUTH_FAILED');
});

test('multi-chunk decryption is complete or fails without partial plaintext', async () => {
  const created = await createAccountKeys('acct-chunks');
  const plaintext = 'x'.repeat(4 * 1024 * 1024 + 1);
  const sealed = await sealCase(created.session, 'case-chunks', 'rev-chunks', plaintext);
  assert.equal(sealed.chunks.length, 2);
  assert.equal(await openCase(created.session, sealed, 'case-chunks', 'rev-chunks'), plaintext);
  const missing = structuredClone(sealed);
  missing.chunks.pop();
  assert.equal(await codeOf(() => openCase(created.session, missing, 'case-chunks', 'rev-chunks')), 'AUTH_FAILED');
  const changedSecond = structuredClone(sealed);
  changedSecond.chunks[1].tag = flipped(changedSecond.chunks[1].tag);
  assert.equal(await codeOf(() => openCase(created.session, changedSecond, 'case-chunks', 'rev-chunks')), 'AUTH_FAILED');
  const reordered = structuredClone(sealed);
  reordered.chunks.reverse();
  assert.equal(await codeOf(() => openCase(created.session, reordered, 'case-chunks', 'rev-chunks')), 'INVALID_ENVELOPE');
  const duplicated = structuredClone(sealed);
  duplicated.chunks[1] = structuredClone(duplicated.chunks[0]);
  assert.equal(await codeOf(() => openCase(created.session, duplicated, 'case-chunks', 'rev-chunks')), 'INVALID_ENVELOPE');
  const mixed = structuredClone(sealed);
  const different = await sealCase(created.session, 'case-chunks', 'rev-chunks', plaintext);
  mixed.chunks[1] = different.chunks[1];
  assert.equal(await codeOf(() => openCase(created.session, mixed, 'case-chunks', 'rev-chunks')), 'AUTH_FAILED');
});

test('plaintext bounds and malformed Unicode fail before producing a package', async () => {
  const created = await createAccountKeys('acct-limits');
  assert.equal(await codeOf(() => sealCase(created.session, 'case-limits', 'rev-empty', '')), 'CASE_TOO_LARGE');
  assert.equal(await codeOf(() => sealCase(created.session, 'case-limits', 'rev-large', 'x'.repeat(32 * 1024 * 1024 + 1))), 'CASE_TOO_LARGE');
  assert.equal(await codeOf(() => sealCase(created.session, 'case-limits', 'rev-unicode', '\ud800')), 'INVALID_ENVELOPE');
});

test('a WebCrypto case package can be independently decrypted by Node crypto', async () => {
  const secret = `scryer-recovery-v1:${b64Hex(vector.recoverySecretHex)}`;
  const session = await unlockRecovery(vectorWrapper(), secret, vector.accountId);
  const plaintext = '{"interoperable":true}';
  const sealed = await sealCase(session, vector.caseId, 'rev-generated', plaintext);
  const info = JSON.stringify({ schemaVersion: '1', purpose: 'case-payload-v1', accountId: sealed.accountId,
    caseId: sealed.caseId, keyGeneration: sealed.keyGeneration, deviceId: sealed.deviceId });
  const derived = Buffer.from(hkdfSync('sha256', Buffer.from(vector.rootHex, 'hex'),
    Buffer.from('scryer:case-key:v1'), Buffer.from(info), 32));
  const chunk = sealed.chunks[0];
  const aad = JSON.stringify({ schemaVersion: '1', format: sealed.format, algorithm: sealed.algorithm,
    accountId: sealed.accountId, caseId: sealed.caseId, revisionId: sealed.revisionId,
    deviceId: sealed.deviceId, keyGeneration: sealed.keyGeneration, packageId: sealed.packageId,
    chunkIndex: 0, chunkCount: 1, nonce: chunk.nonce });
  const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(base64UrlDecode(chunk.nonce)), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(base64UrlDecode(chunk.tag)));
  const opened = Buffer.concat([decipher.update(Buffer.from(base64UrlDecode(chunk.ciphertext))), decipher.final()]);
  assert.equal(opened.toString(), plaintext);
});
