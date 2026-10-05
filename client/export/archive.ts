import { CryptoError, base64UrlDecode, base64UrlEncode, exactKeys, randomBytes,
  utf8Bytes, validId } from '../crypto/codec.ts';
import { openCase, sealCase } from '../crypto/envelope.ts';
import type { CasePackageV1 } from '../crypto/envelope.ts';
import { verifyRecoverySecret } from '../crypto/keys.ts';
import type { RecoveryEnvelopeV1 } from '../crypto/keys.ts';
import { sha256Hex } from '../import/hash.ts';
import type { CaseValidator } from '../import/types.ts';
import { AccountSession } from '../crypto/keys.ts';
import type { CaseRecord } from '../storage/repository.ts';
import { LocalRepository } from '../storage/repository.ts';
import { openDatabase, openLegacyV1, transactionResult } from '../storage/idb.ts';

export class ArchiveError extends Error {
  readonly code: string;

  constructor(code: string) { super(code); this.name = 'ArchiveError'; this.code = code; }
}

type EncryptedOriginal = { artifactId: string; sha256: string; package: CasePackageV1 };
type ArchiveV1 = { schemaVersion: '1'; format: 'scryer-encrypted-archive-v1';
  accountId: string; exportId: string; recoveryEnvelope: RecoveryEnvelopeV1;
  cases: CaseRecord[]; originals: EncryptedOriginal[]; authTag: string };

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_ORIGINAL_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

function canonicalWrapper(input: unknown): RecoveryEnvelopeV1 {
  if (!exactKeys(input, ['schemaVersion', 'format', 'algorithm', 'accountId',
    'salt', 'nonce', 'ciphertext', 'tag'])) throw new ArchiveError('INVALID_ARCHIVE');
  const item = input as RecoveryEnvelopeV1;
  return { schemaVersion: item.schemaVersion, format: item.format, algorithm: item.algorithm,
    accountId: item.accountId, salt: item.salt, nonce: item.nonce,
    ciphertext: item.ciphertext, tag: item.tag };
}

function canonicalPackage(input: unknown): CasePackageV1 {
  if (!exactKeys(input, ['schemaVersion', 'format', 'algorithm', 'accountId', 'caseId',
    'revisionId', 'deviceId', 'keyGeneration', 'packageId', 'chunks'])) {
    throw new ArchiveError('INVALID_ARCHIVE');
  }
  const item = input as CasePackageV1;
  if (!Array.isArray(item.chunks) || item.chunks.length < 1 || item.chunks.length > 8) {
    throw new ArchiveError('INVALID_ARCHIVE');
  }
  const chunks = item.chunks.map((chunk) => {
    if (!exactKeys(chunk, ['index', 'nonce', 'ciphertext', 'tag'])) {
      throw new ArchiveError('INVALID_ARCHIVE');
    }
    return { index: chunk.index, nonce: chunk.nonce,
      ciphertext: chunk.ciphertext, tag: chunk.tag };
  });
  return { schemaVersion: item.schemaVersion, format: item.format, algorithm: item.algorithm,
    accountId: item.accountId, caseId: item.caseId, revisionId: item.revisionId,
    deviceId: item.deviceId, keyGeneration: item.keyGeneration,
    packageId: item.packageId, chunks };
}

function canonicalCase(input: unknown): CaseRecord {
  if (!exactKeys(input, ['accountId', 'caseId', 'revisionId', 'keyGeneration',
    'localSequence', 'package', 'digest'])) throw new ArchiveError('INVALID_ARCHIVE');
  const item = input as CaseRecord;
  if (!validId(item.accountId) || !validId(item.caseId) || !validId(item.revisionId) ||
      !Number.isSafeInteger(item.keyGeneration) || item.keyGeneration < 1 ||
      !Number.isSafeInteger(item.localSequence) || item.localSequence < 1 ||
      typeof item.digest !== 'string' || !SHA256.test(item.digest) ||
      item.package?.accountId !== item.accountId ||
      item.package.caseId !== item.caseId ||
      item.package.revisionId !== item.revisionId ||
      item.package.keyGeneration !== item.keyGeneration) {
    throw new ArchiveError('INVALID_ARCHIVE');
  }
  return { accountId: item.accountId, caseId: item.caseId, revisionId: item.revisionId,
    keyGeneration: item.keyGeneration, localSequence: item.localSequence,
    package: canonicalPackage(item.package), digest: item.digest };
}

function canonicalOriginal(input: unknown): EncryptedOriginal {
  if (!exactKeys(input, ['artifactId', 'sha256', 'package'])) {
    throw new ArchiveError('INVALID_ARCHIVE');
  }
  const item = input as EncryptedOriginal;
  if (!validId(item.artifactId) || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
    throw new ArchiveError('INVALID_ARCHIVE');
  }
  return { artifactId: item.artifactId, sha256: item.sha256,
    package: canonicalPackage(item.package) };
}

function canonicalArchive(input: unknown): ArchiveV1 {
  if (!exactKeys(input, ['schemaVersion', 'format', 'accountId', 'exportId',
    'recoveryEnvelope', 'cases', 'originals', 'authTag'])) throw new ArchiveError('INVALID_ARCHIVE');
  const item = input as ArchiveV1;
  if (item.schemaVersion !== '1' || item.format !== 'scryer-encrypted-archive-v1' ||
      !validId(item.accountId) || typeof item.exportId !== 'string' ||
      !Array.isArray(item.cases) || item.cases.length > 64 ||
      !Array.isArray(item.originals) || item.originals.length > 64) {
    throw new ArchiveError('INVALID_ARCHIVE');
  }
  try {
    base64UrlDecode(item.exportId, 16, 16);
    base64UrlDecode(item.authTag, 32, 32);
  } catch { throw new ArchiveError('INVALID_ARCHIVE'); }
  const cases = item.cases.map(canonicalCase);
  const originals = item.originals.map(canonicalOriginal);
  if (new Set(cases.map((value) => value.caseId)).size !== cases.length ||
      new Set(originals.map((value) => value.artifactId)).size !== originals.length ||
      cases.some((value) => value.accountId !== item.accountId) ||
      originals.some((value) => value.package.accountId !== item.accountId)) {
    throw new ArchiveError('INVALID_ARCHIVE');
  }
  return { schemaVersion: '1', format: 'scryer-encrypted-archive-v1',
    accountId: item.accountId, exportId: item.exportId,
    recoveryEnvelope: canonicalWrapper(item.recoveryEnvelope), cases, originals,
    authTag: item.authTag };
}

function signingBytes(archive: ArchiveV1): Uint8Array<ArrayBuffer> {
  const { authTag: _authTag, ...content } = canonicalArchive(archive);
  return utf8Bytes(JSON.stringify(content));
}

function archiveBytes(archive: ArchiveV1): Uint8Array<ArrayBuffer> {
  const bytes = utf8Bytes(JSON.stringify(canonicalArchive(archive)));
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new ArchiveError('ARCHIVE_TOO_LARGE');
  return bytes;
}

function parseArchive(bytes: unknown): ArchiveV1 {
  if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_ARCHIVE_BYTES) {
    throw new ArchiveError('INVALID_ARCHIVE');
  }
  let source: string;
  let parsed: unknown;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(source);
  } catch { throw new ArchiveError('INVALID_ARCHIVE'); }
  const canonical = canonicalArchive(parsed);
  if (JSON.stringify(canonical) !== source) throw new ArchiveError('INVALID_ARCHIVE');
  return canonical;
}

async function originalCaseId(artifactId: string): Promise<string> {
  return `orig_${(await sha256Hex(utf8Bytes(artifactId))).slice(0, 32)}`;
}

function originalRevisionId(sha256: string): string { return `bytes_${sha256.slice(0, 32)}`; }

async function verifySecret(repo: LocalRepository, archive: ArchiveV1, secret: string): Promise<void> {
  if (archive.accountId !== repo.session.accountId) throw new ArchiveError('WRONG_BINDING');
  let verified: boolean;
  try { verified = await verifyRecoverySecret(repo.session, archive.recoveryEnvelope, secret); }
  catch (error) {
    if (error instanceof CryptoError && error.code === 'WRONG_BINDING') {
      throw new ArchiveError('WRONG_BINDING');
    }
    throw new ArchiveError('WRONG_KEY');
  }
  if (!verified) throw new ArchiveError('WRONG_KEY');
}

async function verifyArchiveTag(repo: LocalRepository, archive: ArchiveV1): Promise<void> {
  const message = signingBytes(archive);
  const tag = base64UrlDecode(archive.authTag, 32, 32);
  try {
    if (!await repo.session.verifyArchive(message, tag)) throw new ArchiveError('CORRUPT_ARCHIVE');
  } finally { message.fill(0); tag.fill(0); }
}

async function verifyOriginals(repo: LocalRepository, archive: ArchiveV1,
  artifacts: Map<string, string>, includeBytes: boolean): Promise<Array<{
    artifactId: string; sha256: string; bytes?: Uint8Array<ArrayBuffer>;
  }>> {
  const results = [];
  let total = 0;
  for (const item of archive.originals) {
    if (artifacts.get(item.artifactId) !== item.sha256 ||
        item.package.caseId !== await originalCaseId(item.artifactId) ||
        item.package.revisionId !== originalRevisionId(item.sha256)) {
      throw new ArchiveError('CORRUPT_ARCHIVE');
    }
    let decoded: Uint8Array<ArrayBuffer>;
    try {
      const plaintext = await openCase(repo.session, item.package,
        item.package.caseId, item.package.revisionId);
      decoded = base64UrlDecode(plaintext, undefined, MAX_TOTAL_ORIGINAL_BYTES);
    } catch { throw new ArchiveError('CORRUPT_ARCHIVE'); }
    total += decoded.length;
    if (total > MAX_TOTAL_ORIGINAL_BYTES || await sha256Hex(decoded) !== item.sha256) {
      decoded.fill(0);
      throw new ArchiveError('CORRUPT_ARCHIVE');
    }
    if (includeBytes) results.push({ artifactId: item.artifactId, sha256: item.sha256, bytes: decoded });
    else { decoded.fill(0); results.push({ artifactId: item.artifactId, sha256: item.sha256 }); }
  }
  return results;
}

export async function exportEncrypted(repo: LocalRepository, options: {
  recoverySecret: string; originals?: Array<{ artifactId: string; bytes: Uint8Array }>;
}): Promise<Uint8Array<ArrayBuffer>> {
  if (!options || typeof options.recoverySecret !== 'string') throw new ArchiveError('WRONG_KEY');
  if (options.originals !== undefined && (!Array.isArray(options.originals) ||
      options.originals.length > 64)) throw new ArchiveError('INVALID_ORIGINAL');
  const snapshot = await repo.encryptedSnapshot();
  const archive: ArchiveV1 = { schemaVersion: '1', format: 'scryer-encrypted-archive-v1',
    accountId: repo.session.accountId, exportId: base64UrlEncode(randomBytes(16)),
    recoveryEnvelope: snapshot.recoveryEnvelope, cases: snapshot.cases, originals: [],
    authTag: base64UrlEncode(new Uint8Array(32)) };
  await verifySecret(repo, archive, options.recoverySecret);
  const available = new Map<string, string>();
  for (const item of snapshot.cases) {
    const plaintext = await openCase(repo.session, item.package, item.caseId, item.revisionId);
    const stored = JSON.parse(plaintext) as { case: { artifacts: Array<{ artifactId: string; sha256: string }> } };
    for (const artifact of stored.case.artifacts) {
      if (available.has(artifact.artifactId) && available.get(artifact.artifactId) !== artifact.sha256) {
        throw new ArchiveError('INVALID_ORIGINAL');
      }
      available.set(artifact.artifactId, artifact.sha256);
    }
  }
  let total = 0;
  for (const source of options.originals ?? []) {
    if (!source || !validId(source.artifactId) || !(source.bytes instanceof Uint8Array) ||
        archive.originals.some((item) => item.artifactId === source.artifactId)) {
      throw new ArchiveError('INVALID_ORIGINAL');
    }
    total += source.bytes.length;
    if (source.bytes.length < 1 || total > MAX_TOTAL_ORIGINAL_BYTES) {
      throw new ArchiveError('ORIGINAL_TOO_LARGE');
    }
    const copied = new Uint8Array(source.bytes);
    try {
      const sha256 = await sha256Hex(copied);
      if (available.get(source.artifactId) !== sha256) throw new ArchiveError('ORIGINAL_HASH_MISMATCH');
      const caseId = await originalCaseId(source.artifactId);
      const revisionId = originalRevisionId(sha256);
      const encoded = base64UrlEncode(copied);
      const count = Math.ceil(utf8Bytes(encoded).length / (4 * 1024 * 1024));
      await repo.reserveEncryptions(caseId, 1, count);
      const pkg = await sealCase(repo.session, caseId, revisionId, encoded);
      archive.originals.push({ artifactId: source.artifactId, sha256, package: pkg });
    } finally { copied.fill(0); }
  }
  const message = signingBytes(archive);
  try { archive.authTag = base64UrlEncode(await repo.session.signArchive(message)); }
  finally { message.fill(0); }
  return archiveBytes(archive);
}

export async function previewRestore(repo: LocalRepository, bytes: Uint8Array,
  secret: string): Promise<{ accountId: string; cases: Array<{
    caseId: string; archivedRevision: string; currentRevision: string | null;
    sameCiphertext: boolean }>; originals: Array<{ artifactId: string; sha256: string }> }> {
  const archive = parseArchive(bytes);
  await verifySecret(repo, archive, secret);
  await verifyArchiveTag(repo, archive);
  const inspected = await repo.inspectArchivedCases(archive.cases);
  const artifacts = new Map<string, string>();
  for (const item of inspected) {
    for (const artifact of item.artifacts) {
      if (artifacts.has(artifact.artifactId) && artifacts.get(artifact.artifactId) !== artifact.sha256) {
        throw new ArchiveError('CORRUPT_ARCHIVE');
      }
      artifacts.set(artifact.artifactId, artifact.sha256);
    }
  }
  const originals = await verifyOriginals(repo, archive, artifacts, false);
  return { accountId: archive.accountId, cases: inspected.map(({ caseId, archivedRevision,
    currentRevision, sameCiphertext }) => ({ caseId, archivedRevision,
    currentRevision, sameCiphertext })), originals };
}

export async function restoreEncrypted(repo: LocalRepository, bytes: Uint8Array,
  secret: string, expectedLocalRevisions: Record<string, string | null>): Promise<{
    restored: number; unchanged: number;
  }> {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_ARCHIVE_BYTES) {
    throw new ArchiveError('INVALID_ARCHIVE');
  }
  const stable = new Uint8Array(bytes);
  await previewRestore(repo, stable, secret);
  const archive = parseArchive(stable);
  if (archive.cases.length === 0) throw new ArchiveError('INVALID_ARCHIVE');
  return repo.replaceEncryptedCases(archive.cases, expectedLocalRevisions);
}

export async function extractArchiveOriginals(repo: LocalRepository, bytes: Uint8Array,
  secret: string): Promise<Array<{ artifactId: string; sha256: string; bytes: Uint8Array<ArrayBuffer> }>> {
  const archive = parseArchive(bytes);
  await verifySecret(repo, archive, secret);
  await verifyArchiveTag(repo, archive);
  const inspected = await repo.inspectArchivedCases(archive.cases);
  const artifacts = new Map<string, string>();
  for (const item of inspected) {
    for (const artifact of item.artifacts) {
      if (artifacts.has(artifact.artifactId) && artifacts.get(artifact.artifactId) !== artifact.sha256) {
        throw new ArchiveError('CORRUPT_ARCHIVE');
      }
      artifacts.set(artifact.artifactId, artifact.sha256);
    }
  }
  return await verifyOriginals(repo, archive, artifacts, true) as Array<{
    artifactId: string; sha256: string; bytes: Uint8Array<ArrayBuffer>;
  }>;
}

export async function migrateLocalDatabase(options: {
  dbName: string; session: AccountSession; validateCase: CaseValidator;
  backup: Uint8Array; recoverySecret: string;
}): Promise<{ from: 1; to: 2; backupDigest: string }> {
  if (!options || !(options.session instanceof AccountSession) ||
      typeof options.validateCase !== 'function') throw new ArchiveError('INVALID_MIGRATION');
  if (!(options.backup instanceof Uint8Array) || options.backup.length > MAX_ARCHIVE_BYTES) {
    throw new ArchiveError('INVALID_ARCHIVE');
  }
  const backup = new Uint8Array(options.backup);
  const archive = parseArchive(backup);
  const legacyDb = await openLegacyV1(options.dbName);
  let legacy: LocalRepository;
  try { legacy = new LocalRepository(legacyDb, options.session, options.validateCase); }
  catch (error) { legacyDb.close(); throw error; }
  const expectedOutbox = new Map<string, string>();
  try {
    await previewRestore(legacy, backup, options.recoverySecret);
    const current = await legacy.encryptedSnapshot();
    const identity = (item: CaseRecord) =>
      `${item.accountId}\u0000${item.caseId}\u0000${item.revisionId}\u0000${item.digest}`;
    if (JSON.stringify(current.cases.map(identity).sort()) !==
        JSON.stringify(archive.cases.map(identity).sort())) {
      throw new ArchiveError('STALE_MIGRATION_BACKUP');
    }
    for (const item of archive.cases) {
      expectedOutbox.set(item.caseId, JSON.stringify(await legacy.prepareSync(item.caseId)));
    }
  } finally { legacy.close(); }
  const backupDigest = await sha256Hex(backup);
  const proof = { expectedCases: archive.cases.map((item) => ({ accountId: item.accountId,
    caseId: item.caseId, revisionId: item.revisionId, digest: item.digest })),
    expectedAccounts: [{ accountId: archive.accountId,
      recoveryEnvelopeJson: JSON.stringify(archive.recoveryEnvelope) }], backupDigest };
  const db = await openDatabase(options.dbName, proof);
  let upgraded: LocalRepository;
  try { upgraded = new LocalRepository(db, options.session, options.validateCase); }
  catch (error) { db.close(); throw error; }
  try {
    const marker = await transactionResult<{ id: string; version: number;
      migratedFrom: number; backupDigest: string | null } | undefined>(
      db, ['migrations'], 'readonly', (tx, finish) => {
        const request = tx.objectStore('migrations').get('schema');
        request.onsuccess = () => finish(request.result as { id: string; version: number;
          migratedFrom: number; backupDigest: string | null } | undefined);
      });
    const current = await upgraded.encryptedSnapshot();
    const identity = (item: CaseRecord) =>
      `${item.accountId}\u0000${item.caseId}\u0000${item.revisionId}\u0000${item.digest}`;
    if (marker?.version !== 2 || marker.migratedFrom !== 1 ||
        marker.backupDigest !== backupDigest ||
        JSON.stringify(current.cases.map(identity).sort()) !==
        JSON.stringify(archive.cases.map(identity).sort())) {
      throw new ArchiveError('MIGRATION_VERIFY_FAILED');
    }
    for (const [caseId, expected] of expectedOutbox) {
      if (JSON.stringify(await upgraded.prepareSync(caseId)) !== expected) {
        throw new ArchiveError('MIGRATION_VERIFY_FAILED');
      }
    }
    return { from: 1, to: 2, backupDigest };
  } finally { upgraded.close(); }
}
