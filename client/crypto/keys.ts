import {
  CRYPTO_ALGORITHM, CRYPTO_VERSION, RECOVERY_FORMAT, CryptoError,
  base64UrlDecode, base64UrlEncode, cryptoApi, exactKeys, randomBytes, utf8Bytes, validId,
} from './codec.ts';

export type RecoveryEnvelopeV1 = {
  schemaVersion: '1';
  format: 'scryer-recovery-wrap-v1';
  algorithm: 'AES-256-GCM+HKDF-SHA-256';
  accountId: string;
  salt: string;
  nonce: string;
  ciphertext: string;
  tag: string;
};

const RECOVERY_PREFIX = 'scryer-recovery-v1:';

function wrapInfo(accountId: string): Uint8Array<ArrayBuffer> {
  return utf8Bytes(JSON.stringify({ schemaVersion: CRYPTO_VERSION, purpose: 'recovery-wrap-v1', accountId }));
}

function verificationInfo(accountId: string): Uint8Array<ArrayBuffer> {
  return utf8Bytes(JSON.stringify({ schemaVersion: CRYPTO_VERSION, purpose: 'recovery-verify-v1', accountId }));
}

function caseInfo(accountId: string, caseId: string, keyGeneration: number, deviceId: string): Uint8Array<ArrayBuffer> {
  return utf8Bytes(JSON.stringify({
    schemaVersion: CRYPTO_VERSION, purpose: 'case-payload-v1',
    accountId, caseId, keyGeneration, deviceId,
  }));
}

function archiveInfo(accountId: string): Uint8Array<ArrayBuffer> {
  return utf8Bytes(JSON.stringify({ schemaVersion: CRYPTO_VERSION,
    purpose: 'archive-auth-v1', accountId }));
}

async function importHkdf(bytes: Uint8Array): Promise<CryptoKey> {
  return cryptoApi().subtle.importKey('raw', new Uint8Array(bytes), 'HKDF', false, ['deriveBits', 'deriveKey']);
}

async function deriveAes(root: CryptoKey, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  return cryptoApi().subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info: new Uint8Array(info) },
    root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

function wrapAad(header: Pick<RecoveryEnvelopeV1,
  'schemaVersion' | 'format' | 'algorithm' | 'accountId' | 'salt' | 'nonce'>): Uint8Array<ArrayBuffer> {
  return utf8Bytes(JSON.stringify({
    schemaVersion: header.schemaVersion, format: header.format, algorithm: header.algorithm,
    accountId: header.accountId, salt: header.salt, nonce: header.nonce,
  }));
}

function splitTag(encrypted: ArrayBuffer): { ciphertext: string; tag: string } {
  const bytes = new Uint8Array(encrypted);
  if (bytes.length < 16) throw new CryptoError('CRYPTO_UNAVAILABLE');
  return {
    ciphertext: base64UrlEncode(bytes.subarray(0, bytes.length - 16)),
    tag: base64UrlEncode(bytes.subarray(bytes.length - 16)),
  };
}

function validateWrapper(input: unknown): RecoveryEnvelopeV1 {
  if (!exactKeys(input, [
    'schemaVersion', 'format', 'algorithm', 'accountId', 'salt', 'nonce', 'ciphertext', 'tag',
  ])) throw new CryptoError('INVALID_ENVELOPE');
  const value = input as RecoveryEnvelopeV1;
  if (value.schemaVersion !== CRYPTO_VERSION || value.format !== RECOVERY_FORMAT ||
      value.algorithm !== CRYPTO_ALGORITHM) throw new CryptoError('UNSUPPORTED_CRYPTO_VERSION');
  if (!validId(value.accountId)) throw new CryptoError('INVALID_ENVELOPE');
  base64UrlDecode(value.salt, 16, 16);
  base64UrlDecode(value.nonce, 12, 12);
  base64UrlDecode(value.ciphertext, 32, 32);
  base64UrlDecode(value.tag, 16, 16);
  return value;
}

function recoveryBytes(secret: string): Uint8Array<ArrayBuffer> {
  if (typeof secret !== 'string' || !secret.startsWith(RECOVERY_PREFIX)) {
    throw new CryptoError('INVALID_ENVELOPE');
  }
  return base64UrlDecode(secret.slice(RECOVERY_PREFIX.length), 32, 32);
}

export class AccountSession {
  #root: CryptoKey | null;
  readonly accountId: string;
  readonly deviceId: string;

  constructor(root: CryptoKey, accountId: string, deviceId: string) {
    this.#root = root;
    this.accountId = accountId;
    this.deviceId = deviceId;
  }

  get locked(): boolean { return this.#root === null; }

  lock(): void { this.#root = null; }

  private root(): CryptoKey {
    if (this.#root === null) throw new CryptoError('KEY_LOCKED');
    return this.#root;
  }

  async deriveCaseKey(caseId: string, keyGeneration: number, deviceId: string): Promise<CryptoKey> {
    const root = this.root();
    if (!validId(caseId) || !Number.isSafeInteger(keyGeneration) || keyGeneration < 1 ||
        keyGeneration > 2_147_483_647) throw new CryptoError('INVALID_ENVELOPE');
    base64UrlDecode(deviceId, 16, 16);
    return deriveAes(root, utf8Bytes('scryer:case-key:v1'),
      caseInfo(this.accountId, caseId, keyGeneration, deviceId));
  }

  async verificationBytes(): Promise<Uint8Array<ArrayBuffer>> {
    const bits = await cryptoApi().subtle.deriveBits({
      name: 'HKDF', hash: 'SHA-256', salt: utf8Bytes('scryer:recovery-verify:v1'),
      info: verificationInfo(this.accountId),
    }, this.root(), 256);
    return new Uint8Array(bits);
  }

  private async archiveKey(): Promise<CryptoKey> {
    return cryptoApi().subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
      salt: utf8Bytes('scryer:archive-auth:v1'), info: archiveInfo(this.accountId) },
    this.root(), { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
  }

  async signArchive(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const signature = await cryptoApi().subtle.sign('HMAC', await this.archiveKey(), new Uint8Array(bytes));
    return new Uint8Array(signature);
  }

  async verifyArchive(bytes: Uint8Array, signature: Uint8Array): Promise<boolean> {
    return cryptoApi().subtle.verify('HMAC', await this.archiveKey(),
      new Uint8Array(signature), new Uint8Array(bytes));
  }
}

async function wrapRoot(rootBytes: Uint8Array, secretBytes: Uint8Array, accountId: string): Promise<RecoveryEnvelopeV1> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const header = {
    schemaVersion: CRYPTO_VERSION, format: RECOVERY_FORMAT, algorithm: CRYPTO_ALGORITHM,
    accountId, salt: base64UrlEncode(salt), nonce: base64UrlEncode(nonce),
  } as const;
  const secretKey = await importHkdf(secretBytes);
  const wrappingKey = await deriveAes(secretKey, salt, wrapInfo(accountId));
  const encrypted = await cryptoApi().subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: wrapAad(header), tagLength: 128 },
    wrappingKey, new Uint8Array(rootBytes),
  );
  return { ...header, ...splitTag(encrypted) };
}

export async function createAccountKeys(accountId: string): Promise<{
  session: AccountSession; recoverySecret: string; recoveryEnvelope: RecoveryEnvelopeV1;
}> {
  if (!validId(accountId)) throw new CryptoError('INVALID_ENVELOPE');
  const rootBytes = randomBytes(32);
  const secretBytes = randomBytes(32);
  try {
    const root = await importHkdf(rootBytes);
    const recoveryEnvelope = await wrapRoot(rootBytes, secretBytes, accountId);
    const recoverySecret = `${RECOVERY_PREFIX}${base64UrlEncode(secretBytes)}`;
    const deviceId = base64UrlEncode(randomBytes(16));
    return { session: new AccountSession(root, accountId, deviceId), recoverySecret, recoveryEnvelope };
  } finally {
    rootBytes.fill(0);
    secretBytes.fill(0);
  }
}

export async function unlockRecovery(input: unknown, secret: string, expectedAccountId: string): Promise<AccountSession> {
  const wrapper = validateWrapper(input);
  if (!validId(expectedAccountId)) throw new CryptoError('INVALID_ENVELOPE');
  if (wrapper.accountId !== expectedAccountId) throw new CryptoError('WRONG_BINDING');
  const secretBytes = recoveryBytes(secret);
  let rootBytes: Uint8Array<ArrayBuffer> | null = null;
  try {
    const secretKey = await importHkdf(secretBytes);
    const wrappingKey = await deriveAes(secretKey, base64UrlDecode(wrapper.salt, 16, 16), wrapInfo(wrapper.accountId));
    const ciphertext = base64UrlDecode(wrapper.ciphertext, 32, 32);
    const tag = base64UrlDecode(wrapper.tag, 16, 16);
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext);
    combined.set(tag, ciphertext.length);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await cryptoApi().subtle.decrypt({
        name: 'AES-GCM', iv: base64UrlDecode(wrapper.nonce, 12, 12),
        additionalData: wrapAad(wrapper), tagLength: 128,
      }, wrappingKey, combined);
    } catch {
      throw new CryptoError('AUTH_FAILED');
    }
    rootBytes = new Uint8Array(plaintext);
    if (rootBytes.length !== 32) throw new CryptoError('INVALID_ENVELOPE');
    const root = await importHkdf(rootBytes);
    return new AccountSession(root, wrapper.accountId, base64UrlEncode(randomBytes(16)));
  } finally {
    secretBytes.fill(0);
    rootBytes?.fill(0);
  }
}

export async function verifyRecoverySecret(session: AccountSession, wrapper: unknown, reentered: string): Promise<boolean> {
  if (session.locked) throw new CryptoError('KEY_LOCKED');
  let recovered: AccountSession;
  try {
    recovered = await unlockRecovery(wrapper, reentered, session.accountId);
  } catch (error) {
    if (error instanceof CryptoError && error.code === 'AUTH_FAILED') return false;
    throw error;
  }
  try {
    const currentProof = await session.verificationBytes();
    const recoveredProof = await recovered.verificationBytes();
    let difference = 0;
    for (let index = 0; index < currentProof.length; index++) {
      difference |= (currentProof[index] ?? 0) ^ (recoveredProof[index] ?? 0);
    }
    currentProof.fill(0);
    recoveredProof.fill(0);
    return difference === 0;
  } finally {
    recovered.lock();
  }
}
