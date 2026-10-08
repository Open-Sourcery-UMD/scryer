import { createCipheriv, hkdfSync } from 'node:crypto';

const sequence = (start, length) => Buffer.from(Array.from({ length }, (_, index) => start + index));
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const utf8 = (text) => Buffer.from(text, 'utf8');

const root = sequence(0x00, 32);
const recoverySecret = sequence(0x20, 32);
const recoverySalt = sequence(0x40, 16);
const recoveryNonce = sequence(0x50, 12);
const caseNonce = sequence(0x60, 12);
const deviceId = b64(sequence(0x00, 16));
const packageId = b64(sequence(0x10, 16));
const accountId = 'acct-demo';
const caseId = 'case-demo';
const revisionId = 'rev-demo';
const keyGeneration = 1;

const wrapInfo = JSON.stringify({ schemaVersion: '1', purpose: 'recovery-wrap-v1', accountId });
const wrapKey = Buffer.from(hkdfSync('sha256', recoverySecret, recoverySalt, utf8(wrapInfo), 32));
const wrapHeader = {
  schemaVersion: '1', format: 'scryer-recovery-wrap-v1', algorithm: 'AES-256-GCM+HKDF-SHA-256',
  accountId, salt: b64(recoverySalt), nonce: b64(recoveryNonce),
};
const wrapAad = JSON.stringify(wrapHeader);
const wrapCipher = createCipheriv('aes-256-gcm', wrapKey, recoveryNonce, { authTagLength: 16 });
wrapCipher.setAAD(utf8(wrapAad));
const wrappedRoot = Buffer.concat([wrapCipher.update(root), wrapCipher.final()]);
const wrapTag = wrapCipher.getAuthTag();

const caseInfo = JSON.stringify({
  schemaVersion: '1', purpose: 'case-payload-v1', accountId, caseId, keyGeneration, deviceId,
});
const caseKey = Buffer.from(hkdfSync('sha256', root, utf8('scryer:case-key:v1'), utf8(caseInfo), 32));
const caseAad = JSON.stringify({
  schemaVersion: '1', format: 'scryer-case-v1', algorithm: 'AES-256-GCM+HKDF-SHA-256',
  accountId, caseId, revisionId, deviceId, keyGeneration, packageId,
  chunkIndex: 0, chunkCount: 1, nonce: b64(caseNonce),
});
const plaintext = utf8('Scryer synthetic vector 1');
const caseCipher = createCipheriv('aes-256-gcm', caseKey, caseNonce, { authTagLength: 16 });
caseCipher.setAAD(utf8(caseAad));
const ciphertext = Buffer.concat([caseCipher.update(plaintext), caseCipher.final()]);
const caseTag = caseCipher.getAuthTag();

const vector = {
  schemaVersion: '1',
  source: 'Node.js crypto/OpenSSL fixed synthetic interoperability vector',
  accountId, caseId, revisionId, keyGeneration, deviceId, packageId,
  rootHex: hex(root), recoverySecretHex: hex(recoverySecret), recoverySaltHex: hex(recoverySalt),
  recoveryNonceHex: hex(recoveryNonce), caseNonceHex: hex(caseNonce),
  wrapInfo, wrapKeyHex: hex(wrapKey), wrapAad,
  wrappedRootHex: hex(wrappedRoot), wrapTagHex: hex(wrapTag),
  caseInfo, caseKeyHex: hex(caseKey), caseAad,
  plaintextHex: hex(plaintext), ciphertextHex: hex(ciphertext), caseTagHex: hex(caseTag),
};
process.stdout.write(`${JSON.stringify(vector, null, 2)}\n`);
