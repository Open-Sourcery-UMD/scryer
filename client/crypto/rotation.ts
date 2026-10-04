import { MAX_CASE_BYTES, MAX_CHUNK_BYTES, CryptoError, base64UrlEncode,
  cryptoApi, randomBytes, utf8Bytes, validId } from './codec.ts';
import { sealCase } from './envelope.ts';
import { AccountSession, createAccountKeys, unlockRecovery,
  verifyRecoverySecret } from './keys.ts';
import { LocalRepository } from '../storage/repository.ts';
import type { RotationEntry, RotationJournal } from '../storage/repository.ts';
import { StorageError } from '../storage/idb.ts';

async function packageDigest(value: unknown): Promise<string> {
  const bytes = utf8Bytes(JSON.stringify(value));
  try {
    const digest = await cryptoApi().subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } finally { bytes.fill(0); }
}

function rotationId(operationId: string): string {
  if (!validId(operationId)) throw new StorageError('INVALID_ROTATION');
  return `rotation:${operationId}`;
}

async function prepareEntries(repo: LocalRepository, session: AccountSession,
  kind: 'generation' | 'recovery'): Promise<RotationEntry[]> {
  const snapshot = await repo.encryptedSnapshot();
  const entries: RotationEntry[] = [];
  for (const current of snapshot.cases) {
    const loaded = await repo.loadCase(current.caseId);
    if (!loaded || loaded.revisionId !== current.revisionId) {
      throw new StorageError('STALE_LOCAL_REVISION');
    }
    const nextGeneration = kind === 'generation' ? current.keyGeneration + 1 : 1;
    if (nextGeneration > 2_147_483_647) throw new StorageError('KEY_USE_LIMIT');
    const plaintext = JSON.stringify({ schemaVersion: '1', case: loaded.case, ledger: loaded.ledger });
    const bytes = utf8Bytes(plaintext);
    const size = bytes.length;
    bytes.fill(0);
    if (size < 1 || size > MAX_CASE_BYTES) throw new StorageError('CASE_TOO_LARGE');
    const uses = Math.ceil(size / MAX_CHUNK_BYTES);
    await repo.reserveEncryptionsForDevice(current.caseId, nextGeneration,
      session.deviceId, uses);
    const nextRevision = `rot_${base64UrlEncode(randomBytes(16))}`;
    const pkg = await sealCase(session, current.caseId, nextRevision,
      plaintext, nextGeneration);
    entries.push({ caseId: current.caseId, priorRevision: current.revisionId,
      priorDigest: current.digest, nextRevision, nextGeneration,
      package: pkg, digest: await packageDigest(pkg) });
  }
  return entries;
}

export async function prepareGenerationRotation(repo: LocalRepository,
  operationId: string): Promise<{ operationId: string; prepared: number }> {
  const id = rotationId(operationId);
  const priorRootProof = await repo.rootProof();
  const priorRecoveryEnvelope = await repo.recoveryEnvelope();
  const entries = await prepareEntries(repo, repo.session, 'generation');
  const journal: RotationJournal = { id, operationId, kind: 'generation',
    status: 'prepared', accountId: repo.session.accountId,
    priorRootProof, priorRecoveryEnvelope, entries };
  await repo.recordPreparedRotation(journal);
  return { operationId, prepared: entries.length };
}

export async function commitGenerationRotation(repo: LocalRepository,
  operationId: string): Promise<{ rotated: number;
    revisions: Array<{ caseId: string; revisionId: string }> }> {
  rotationId(operationId);
  return repo.commitPreparedRotation(operationId, repo.session);
}

export async function rotateGeneration(repo: LocalRepository, operationId: string): Promise<{
  rotated: number; revisions: Array<{ caseId: string; revisionId: string }> }> {
  await prepareGenerationRotation(repo, operationId);
  return commitGenerationRotation(repo, operationId);
}

export async function prepareRecoveryRotation(repo: LocalRepository,
  operationId: string): Promise<{ operationId: string; recoverySecret: string }> {
  const id = rotationId(operationId);
  const priorRootProof = await repo.rootProof();
  const priorRecoveryEnvelope = await repo.recoveryEnvelope();
  const created = await createAccountKeys(repo.session.accountId);
  try {
    if (!await verifyRecoverySecret(created.session, created.recoveryEnvelope,
      created.recoverySecret)) throw new StorageError('RECOVERY_VERIFICATION_REQUIRED');
    const newProofBytes = await created.session.verificationBytes();
    const newRootProof = base64UrlEncode(newProofBytes);
    newProofBytes.fill(0);
    const entries = await prepareEntries(repo, created.session, 'recovery');
    const journal: RotationJournal = { id, operationId, kind: 'recovery',
      status: 'prepared', accountId: repo.session.accountId,
      priorRootProof, priorRecoveryEnvelope, entries,
      newRecoveryEnvelope: created.recoveryEnvelope,
      newRootProof };
    await repo.recordPreparedRotation(journal);
    return { operationId, recoverySecret: created.recoverySecret };
  } finally { created.session.lock(); }
}

export async function commitRecoveryRotation(repo: LocalRepository,
  operationId: string, reenteredSecret: string): Promise<{
    session: AccountSession; recoveryEnvelope: NonNullable<RotationJournal['newRecoveryEnvelope']>;
    rotated: number; revisions: Array<{ caseId: string; revisionId: string }> }> {
  rotationId(operationId);
  const journal = await repo.readRotation(operationId);
  if (journal.kind !== 'recovery' || !journal.newRecoveryEnvelope) {
    throw new StorageError('INVALID_ROTATION');
  }
  let nextSession: AccountSession;
  try {
    nextSession = await unlockRecovery(journal.newRecoveryEnvelope,
      reenteredSecret, repo.session.accountId);
  } catch (error) {
    if (error instanceof CryptoError) throw new StorageError('WRONG_KEY');
    throw error;
  }
  try {
    const result = await repo.commitPreparedRotation(operationId, nextSession);
    repo.lock();
    return { session: nextSession, recoveryEnvelope: journal.newRecoveryEnvelope,
      ...result };
  } catch (error) {
    nextSession.lock();
    throw error;
  }
}

export async function rotateRecoverySecret(repo: LocalRepository,
  operationId: string): Promise<{ operationId: string; recoverySecret: string }> {
  return prepareRecoveryRotation(repo, operationId);
}

export async function abortRotation(repo: LocalRepository, operationId: string): Promise<void> {
  rotationId(operationId);
  return repo.abortRotation(operationId);
}
