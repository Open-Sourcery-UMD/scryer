import assert from 'node:assert/strict';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { openBrowserHarness } from './harness.mjs';

const vector = JSON.parse(readFileSync(new URL('../crypto/vectors.json', import.meta.url), 'utf8'));
const decode = (value) => Buffer.from(value, 'base64url');
const derive = (ikm, salt, info) => Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info), 32));

function decryptNodeGenerated(bundle) {
  const secret = decode(bundle.recoverySecret.slice('scryer-recovery-v1:'.length));
  const wrapper = bundle.recoveryEnvelope;
  const wrapInfo = JSON.stringify({ schemaVersion: '1', purpose: 'recovery-wrap-v1', accountId: wrapper.accountId });
  const wrapKey = derive(secret, decode(wrapper.salt), wrapInfo);
  const wrapAad = JSON.stringify({ schemaVersion: wrapper.schemaVersion, format: wrapper.format,
    algorithm: wrapper.algorithm, accountId: wrapper.accountId, salt: wrapper.salt, nonce: wrapper.nonce });
  const rootCipher = createDecipheriv('aes-256-gcm', wrapKey, decode(wrapper.nonce), { authTagLength: 16 });
  rootCipher.setAAD(Buffer.from(wrapAad));
  rootCipher.setAuthTag(decode(wrapper.tag));
  const root = Buffer.concat([rootCipher.update(decode(wrapper.ciphertext)), rootCipher.final()]);
  const pkg = bundle.pkg;
  const caseInfo = JSON.stringify({ schemaVersion: '1', purpose: 'case-payload-v1', accountId: pkg.accountId,
    caseId: pkg.caseId, keyGeneration: pkg.keyGeneration, deviceId: pkg.deviceId });
  const caseKey = derive(root, Buffer.from('scryer:case-key:v1'), caseInfo);
  const parts = pkg.chunks.map((chunk) => {
    const aad = JSON.stringify({ schemaVersion: pkg.schemaVersion, format: pkg.format,
      algorithm: pkg.algorithm, accountId: pkg.accountId, caseId: pkg.caseId,
      revisionId: pkg.revisionId, deviceId: pkg.deviceId, keyGeneration: pkg.keyGeneration,
      packageId: pkg.packageId, chunkIndex: chunk.index, chunkCount: pkg.chunks.length, nonce: chunk.nonce });
    const decipher = createDecipheriv('aes-256-gcm', caseKey, decode(chunk.nonce), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(decode(chunk.tag));
    return Buffer.concat([decipher.update(decode(chunk.ciphertext)), decipher.final()]);
  });
  root.fill(0);
  return Buffer.concat(parts).toString('utf8');
}

test('real browser WebCrypto recovery and case format match independent Node crypto', async (t) => {
  const { page, browser } = await openBrowserHarness(t);

  await t.test('Chrome opens the fixed Node/OpenSSL vector and verifies recovery re-entry', async () => {
    const result = await page.evaluate(async (value) => {
      const { base64UrlEncode } = await import('/crypto/codec.js');
      const { unlockRecovery, verifyRecoverySecret } = await import('/crypto/keys.js');
      const { openCase } = await import('/crypto/envelope.js');
      const b64Hex = (hex) => base64UrlEncode(Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16)));
      const secret = `scryer-recovery-v1:${b64Hex(value.recoverySecretHex)}`;
      const wrapper = { schemaVersion: '1', format: 'scryer-recovery-wrap-v1',
        algorithm: 'AES-256-GCM+HKDF-SHA-256', accountId: value.accountId,
        salt: b64Hex(value.recoverySaltHex), nonce: b64Hex(value.recoveryNonceHex),
        ciphertext: b64Hex(value.wrappedRootHex), tag: b64Hex(value.wrapTagHex) };
      const pkg = { schemaVersion: '1', format: 'scryer-case-v1',
        algorithm: 'AES-256-GCM+HKDF-SHA-256', accountId: value.accountId,
        caseId: value.caseId, revisionId: value.revisionId, deviceId: value.deviceId,
        keyGeneration: value.keyGeneration, packageId: value.packageId,
        chunks: [{ index: 0, nonce: b64Hex(value.caseNonceHex),
          ciphertext: b64Hex(value.ciphertextHex), tag: b64Hex(value.caseTagHex) }] };
      const session = await unlockRecovery(wrapper, secret, value.accountId);
      const plaintext = await openCase(session, pkg, value.caseId, value.revisionId);
      const verified = await verifyRecoverySecret(session, wrapper, secret);
      session.lock();
      return { plaintext, verified };
    }, vector);
    assert.deepEqual(result, { plaintext: Buffer.from(vector.plaintextHex, 'hex').toString(), verified: true });
  });

  await t.test('Chrome ciphertext decrypts in Node and a fresh page recovers it', async () => {
    const bundle = await page.evaluate(async () => {
      const { createAccountKeys, verifyRecoverySecret } = await import('/crypto/keys.js');
      const { sealCase } = await import('/crypto/envelope.js');
      const created = await createAccountKeys('acct-browser');
      if (!await verifyRecoverySecret(created.session, created.recoveryEnvelope, created.recoverySecret)) {
        throw new Error('RECOVERY_VERIFICATION_FAILED');
      }
      const plaintext = '{"synthetic":"browser-to-node"}';
      const pkg = await sealCase(created.session, 'case-browser', 'rev-browser', plaintext);
      created.session.lock();
      return { recoverySecret: created.recoverySecret, recoveryEnvelope: created.recoveryEnvelope, pkg, plaintext };
    });
    assert.equal(decryptNodeGenerated(bundle), bundle.plaintext);
    const fresh = await browser.newPage();
    await fresh.goto(page.url());
    const opened = await fresh.evaluate(async ({ recoveryEnvelope, recoverySecret, pkg }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openCase } = await import('/crypto/envelope.js');
      const session = await unlockRecovery(recoveryEnvelope, recoverySecret, 'acct-browser');
      const value = await openCase(session, pkg, 'case-browser', 'rev-browser');
      const differentDevice = session.deviceId !== pkg.deviceId;
      session.lock();
      return { value, differentDevice };
    }, bundle);
    assert.deepEqual(opened, { value: bundle.plaintext, differentDevice: true });
  });

  await t.test('Chrome rejects tampered later chunk without returning a partial result', async () => {
    const result = await page.evaluate(async () => {
      const { createAccountKeys } = await import('/crypto/keys.js');
      const { sealCase, openCase } = await import('/crypto/envelope.js');
      const { base64UrlDecode, base64UrlEncode } = await import('/crypto/codec.js');
      const created = await createAccountKeys('acct-browser-chunks');
      const plaintext = 'x'.repeat(4 * 1024 * 1024 + 1);
      const pkg = await sealCase(created.session, 'case-chunks', 'rev-chunks', plaintext);
      const damaged = structuredClone(pkg);
      const tag = base64UrlDecode(damaged.chunks[1].tag);
      tag[0] ^= 1;
      damaged.chunks[1].tag = base64UrlEncode(tag);
      let code = null;
      try { await openCase(created.session, damaged, 'case-chunks', 'rev-chunks'); }
      catch (error) { code = error.code; }
      created.session.lock();
      return { count: pkg.chunks.length, code };
    });
    assert.deepEqual(result, { count: 2, code: 'AUTH_FAILED' });
  });
});
