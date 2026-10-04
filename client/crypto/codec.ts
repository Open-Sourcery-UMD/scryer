export class CryptoError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CryptoError';
    this.code = code;
  }
}

export const CRYPTO_VERSION = '1';
export const CRYPTO_ALGORITHM = 'AES-256-GCM+HKDF-SHA-256';
export const CASE_FORMAT = 'scryer-case-v1';
export const RECOVERY_FORMAT = 'scryer-recovery-wrap-v1';
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_CASE_BYTES = 32 * 1024 * 1024;
export const MAX_CHUNKS = 8;
export const MAX_PACKAGE_BYTES = 48 * 1024 * 1024;

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function validId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

export function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new CryptoError('CRYPTO_UNAVAILABLE');
  }
  return globalThis.crypto;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536) {
    throw new CryptoError('INVALID_ENVELOPE');
  }
  const bytes = new Uint8Array(length);
  cryptoApi().getRandomValues(bytes);
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new CryptoError('INVALID_ENVELOPE');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlDecode(value: unknown, exactLength?: number, maxLength = MAX_CHUNK_BYTES): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length % 4 === 1 ||
      value.length > Math.ceil(maxLength * 4 / 3) + 2) {
    throw new CryptoError('INVALID_ENVELOPE');
  }
  let binary: string;
  try {
    binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  } catch {
    throw new CryptoError('INVALID_ENVELOPE');
  }
  if (binary.length > maxLength || (exactLength !== undefined && binary.length !== exactLength)) {
    throw new CryptoError('INVALID_ENVELOPE');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (base64UrlEncode(bytes) !== value) throw new CryptoError('INVALID_ENVELOPE');
  return bytes;
}

export function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string') throw new CryptoError('INVALID_ENVELOPE');
  const bytes = new TextEncoder().encode(value);
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== value) {
    throw new CryptoError('INVALID_ENVELOPE');
  }
  return bytes;
}

export function utf8Text(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CryptoError('INVALID_ENVELOPE');
  }
}
