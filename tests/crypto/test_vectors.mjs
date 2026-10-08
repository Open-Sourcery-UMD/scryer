import assert from 'node:assert/strict';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const vector = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'));
const bytes = (hex) => Buffer.from(hex, 'hex');
const key = (input, salt, info) => Buffer.from(hkdfSync('sha256', input, salt, Buffer.from(info, 'utf8'), 32));

test('fixed Node/OpenSSL recovery-wrap vector has exact HKDF, AAD, ciphertext and tag', () => {
  assert.equal(vector.wrapInfo, JSON.stringify({
    schemaVersion: '1', purpose: 'recovery-wrap-v1', accountId: vector.accountId,
  }));
  const derived = key(bytes(vector.recoverySecretHex), bytes(vector.recoverySaltHex), vector.wrapInfo);
  assert.equal(derived.toString('hex'), vector.wrapKeyHex);
  assert.equal(vector.wrapAad, JSON.stringify({
    schemaVersion: '1', format: 'scryer-recovery-wrap-v1',
    algorithm: 'AES-256-GCM+HKDF-SHA-256', accountId: vector.accountId,
    salt: bytes(vector.recoverySaltHex).toString('base64url'),
    nonce: bytes(vector.recoveryNonceHex).toString('base64url'),
  }));
  const decipher = createDecipheriv('aes-256-gcm', derived, bytes(vector.recoveryNonceHex), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(vector.wrapAad, 'utf8'));
  decipher.setAuthTag(bytes(vector.wrapTagHex));
  const opened = Buffer.concat([decipher.update(bytes(vector.wrappedRootHex)), decipher.final()]);
  assert.equal(opened.toString('hex'), vector.rootHex);
});

test('fixed Node/OpenSSL case-chunk vector binds account/case/revision/device/position', () => {
  assert.equal(vector.caseInfo, JSON.stringify({
    schemaVersion: '1', purpose: 'case-payload-v1', accountId: vector.accountId,
    caseId: vector.caseId, keyGeneration: vector.keyGeneration, deviceId: vector.deviceId,
  }));
  const derived = key(bytes(vector.rootHex), Buffer.from('scryer:case-key:v1'), vector.caseInfo);
  assert.equal(derived.toString('hex'), vector.caseKeyHex);
  assert.equal(vector.caseAad, JSON.stringify({
    schemaVersion: '1', format: 'scryer-case-v1', algorithm: 'AES-256-GCM+HKDF-SHA-256',
    accountId: vector.accountId, caseId: vector.caseId, revisionId: vector.revisionId,
    deviceId: vector.deviceId, keyGeneration: vector.keyGeneration, packageId: vector.packageId,
    chunkIndex: 0, chunkCount: 1, nonce: bytes(vector.caseNonceHex).toString('base64url'),
  }));
  const decipher = createDecipheriv('aes-256-gcm', derived, bytes(vector.caseNonceHex), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(vector.caseAad, 'utf8'));
  decipher.setAuthTag(bytes(vector.caseTagHex));
  const opened = Buffer.concat([decipher.update(bytes(vector.ciphertextHex)), decipher.final()]);
  assert.equal(opened.toString('hex'), vector.plaintextHex);
});

test('fixed vector rejects changed authenticated header and tag', () => {
  const derived = key(bytes(vector.rootHex), Buffer.from('scryer:case-key:v1'), vector.caseInfo);
  for (const [aad, tag] of [
    [vector.caseAad.replace('rev-demo', 'rev-other'), vector.caseTagHex],
    [vector.caseAad, `00${vector.caseTagHex.slice(2)}`],
  ]) {
    const decipher = createDecipheriv('aes-256-gcm', derived, bytes(vector.caseNonceHex), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(bytes(tag));
    assert.throws(() => Buffer.concat([decipher.update(bytes(vector.ciphertextHex)), decipher.final()]));
  }
});
