import {
  CASE_FORMAT, CRYPTO_ALGORITHM, CRYPTO_VERSION, MAX_CASE_BYTES, MAX_CHUNKS,
  MAX_CHUNK_BYTES, MAX_PACKAGE_BYTES, CryptoError, base64UrlDecode, base64UrlEncode,
  cryptoApi, exactKeys, randomBytes, utf8Bytes, utf8Text, validId,
} from './codec.ts';
import { AccountSession } from './keys.ts';

export type CaseChunkV1 = { index: number; nonce: string; ciphertext: string; tag: string };
export type CasePackageV1 = {
  schemaVersion: '1';
  format: 'scryer-case-v1';
  algorithm: 'AES-256-GCM+HKDF-SHA-256';
  accountId: string;
  caseId: string;
  revisionId: string;
  deviceId: string;
  keyGeneration: number;
  packageId: string;
  chunks: CaseChunkV1[];
};

type Header = Omit<CasePackageV1, 'chunks'>;

function validGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function caseAad(header: Header, chunkIndex: number, chunkCount: number, nonce: string): Uint8Array<ArrayBuffer> {
  return utf8Bytes(JSON.stringify({
    schemaVersion: header.schemaVersion, format: header.format, algorithm: header.algorithm,
    accountId: header.accountId, caseId: header.caseId, revisionId: header.revisionId,
    deviceId: header.deviceId, keyGeneration: header.keyGeneration, packageId: header.packageId,
    chunkIndex, chunkCount, nonce,
  }));
}

function validatePackage(input: unknown): CasePackageV1 {
  if (!exactKeys(input, [
    'schemaVersion', 'format', 'algorithm', 'accountId', 'caseId', 'revisionId',
    'deviceId', 'keyGeneration', 'packageId', 'chunks',
  ])) throw new CryptoError('INVALID_ENVELOPE');
  const value = input as CasePackageV1;
  if (value.schemaVersion !== CRYPTO_VERSION || value.format !== CASE_FORMAT ||
      value.algorithm !== CRYPTO_ALGORITHM) throw new CryptoError('UNSUPPORTED_CRYPTO_VERSION');
  if (!validId(value.accountId) || !validId(value.caseId) || !validId(value.revisionId) ||
      !validGeneration(value.keyGeneration) || !Array.isArray(value.chunks) ||
      value.chunks.length < 1 || value.chunks.length > MAX_CHUNKS) {
    throw new CryptoError('INVALID_ENVELOPE');
  }
  base64UrlDecode(value.deviceId, 16, 16);
  base64UrlDecode(value.packageId, 16, 16);
  let total = 0;
  for (let index = 0; index < value.chunks.length; index++) {
    const chunk = value.chunks[index];
    if (!exactKeys(chunk, ['index', 'nonce', 'ciphertext', 'tag']) || chunk?.index !== index) {
      throw new CryptoError('INVALID_ENVELOPE');
    }
    base64UrlDecode(chunk.nonce, 12, 12);
    const ciphertext = base64UrlDecode(chunk.ciphertext, undefined, MAX_CHUNK_BYTES);
    base64UrlDecode(chunk.tag, 16, 16);
    if (ciphertext.length < 1 || ciphertext.length > MAX_CHUNK_BYTES) {
      throw new CryptoError('INVALID_ENVELOPE');
    }
    total += ciphertext.length;
    if (total > MAX_CASE_BYTES) throw new CryptoError('CASE_TOO_LARGE');
  }
  return value;
}

export async function sealCase(
  session: AccountSession, caseId: string, revisionId: string, plaintext: string,
  keyGeneration = 1,
): Promise<CasePackageV1> {
  if (session.locked) throw new CryptoError('KEY_LOCKED');
  if (!validId(caseId) || !validId(revisionId) || !validGeneration(keyGeneration) ||
      typeof plaintext !== 'string') throw new CryptoError('INVALID_ENVELOPE');
  if (plaintext.length > MAX_CASE_BYTES) throw new CryptoError('CASE_TOO_LARGE');
  const bytes = utf8Bytes(plaintext);
  if (bytes.length === 0 || bytes.length > MAX_CASE_BYTES) {
    bytes.fill(0);
    throw new CryptoError('CASE_TOO_LARGE');
  }
  try {
    const chunkCount = Math.ceil(bytes.length / MAX_CHUNK_BYTES);
    if (chunkCount > MAX_CHUNKS) throw new CryptoError('CASE_TOO_LARGE');
    const header: Header = {
      schemaVersion: CRYPTO_VERSION, format: CASE_FORMAT, algorithm: CRYPTO_ALGORITHM,
      accountId: session.accountId, caseId, revisionId, deviceId: session.deviceId,
      keyGeneration, packageId: base64UrlEncode(randomBytes(16)),
    };
    const key = await session.deriveCaseKey(caseId, keyGeneration, session.deviceId);
    const chunks: CaseChunkV1[] = [];
    for (let index = 0; index < chunkCount; index++) {
      const start = index * MAX_CHUNK_BYTES;
      const plainChunk = new Uint8Array(bytes.subarray(start, start + MAX_CHUNK_BYTES));
      const nonceBytes = randomBytes(12);
      const nonce = base64UrlEncode(nonceBytes);
      let encrypted: Uint8Array<ArrayBuffer>;
      try {
        encrypted = new Uint8Array(await cryptoApi().subtle.encrypt({
          name: 'AES-GCM', iv: nonceBytes, additionalData: caseAad(header, index, chunkCount, nonce),
          tagLength: 128,
        }, key, plainChunk));
      } catch {
        throw new CryptoError('CRYPTO_UNAVAILABLE');
      } finally {
        plainChunk.fill(0);
      }
      chunks.push({
        index, nonce,
        ciphertext: base64UrlEncode(encrypted.subarray(0, encrypted.length - 16)),
        tag: base64UrlEncode(encrypted.subarray(encrypted.length - 16)),
      });
      encrypted.fill(0);
    }
    return { ...header, chunks };
  } finally {
    bytes.fill(0);
  }
}

export async function openCase(
  session: AccountSession, input: unknown, expectedCaseId: string, expectedRevisionId: string,
): Promise<string> {
  if (session.locked) throw new CryptoError('KEY_LOCKED');
  if (!validId(expectedCaseId) || !validId(expectedRevisionId)) throw new CryptoError('INVALID_ENVELOPE');
  let copied: unknown;
  try { copied = structuredClone(input); } catch { throw new CryptoError('INVALID_ENVELOPE'); }
  const value = validatePackage(copied);
  if (value.accountId !== session.accountId || value.caseId !== expectedCaseId ||
      value.revisionId !== expectedRevisionId) throw new CryptoError('WRONG_BINDING');
  if (JSON.stringify(value).length > MAX_PACKAGE_BYTES) throw new CryptoError('CASE_TOO_LARGE');
  const key = await session.deriveCaseKey(value.caseId, value.keyGeneration, value.deviceId);
  const header: Header = {
    schemaVersion: value.schemaVersion, format: value.format, algorithm: value.algorithm,
    accountId: value.accountId, caseId: value.caseId, revisionId: value.revisionId,
    deviceId: value.deviceId, keyGeneration: value.keyGeneration, packageId: value.packageId,
  };
  const parts: Uint8Array<ArrayBuffer>[] = [];
  try {
    let total = 0;
    for (const chunk of value.chunks) {
      const ciphertext = base64UrlDecode(chunk.ciphertext, undefined, MAX_CHUNK_BYTES);
      const tag = base64UrlDecode(chunk.tag, 16, 16);
      const combined = new Uint8Array(ciphertext.length + tag.length);
      combined.set(ciphertext);
      combined.set(tag, ciphertext.length);
      let decrypted: ArrayBuffer;
      try {
        decrypted = await cryptoApi().subtle.decrypt({
          name: 'AES-GCM', iv: base64UrlDecode(chunk.nonce, 12, 12),
          additionalData: caseAad(header, chunk.index, value.chunks.length, chunk.nonce),
          tagLength: 128,
        }, key, combined);
      } catch {
        throw new CryptoError('AUTH_FAILED');
      }
      const bytes = new Uint8Array(decrypted);
      parts.push(bytes);
      total += bytes.length;
      if (total > MAX_CASE_BYTES) throw new CryptoError('CASE_TOO_LARGE');
    }
    const complete = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      complete.set(part, offset);
      offset += part.length;
    }
    try { return utf8Text(complete); } finally { complete.fill(0); }
  } finally {
    for (const part of parts) part.fill(0);
  }
}
