import { MAX_CASE_BYTES, MAX_CHUNK_BYTES, MAX_CHUNKS, CryptoError,
  base64UrlDecode, base64UrlEncode, exactKeys, randomBytes, utf8Bytes, validId } from '../crypto/codec.ts';
import { openCase, sealCase } from '../crypto/envelope.ts';
import type { CasePackageV1 } from '../crypto/envelope.ts';
import { AccountSession, verifyRecoverySecret } from '../crypto/keys.ts';
import type { RecoveryEnvelopeV1 } from '../crypto/keys.ts';
import { validCaseShape } from '../import/case-shape.ts';
import type { CaseV1, CaseValidator, ImportLedger } from '../import/types.ts';
import { openDatabase, StorageError, storageFault, transactionResult } from './idb.ts';

export type StoredCaseV1 = { schemaVersion: '1'; case: CaseV1; ledger: ImportLedger };
export type LoadedCase = { case: CaseV1; ledger: ImportLedger; revisionId: string; keyGeneration: number };
export type SyncStep = { idempotencyKey: string; kind: 'chunk' | 'manifest'; body: string };
export type PreparedSync = { operationId: string; caseId: string; revisionId: string;
  expectedServerRevision: string | null; localSequence: number; steps: SyncStep[] };
export type ReviewedCommit = { case: CaseV1; ledger: ImportLedger; revisionId: string;
  operationId: string; expectedLocalRevision: string | null; serverRevision: string | null;
  keyGeneration?: number };

type AccountRecord = { accountId: string; recoveryEnvelope: RecoveryEnvelopeV1;
  rootProof: string; deviceId?: string };
export type CaseRecord = { accountId: string; caseId: string; revisionId: string;
  keyGeneration: number; localSequence: number; package: CasePackageV1; digest: string };
type AnchorRecord = { accountId: string; caseId: string; revisionId: string; digest: string };
type BudgetRecord = { accountId: string; caseId: string; keyGeneration: number; deviceId: string; used: number };
type OutboxRecord = PreparedSync & { accountId: string };
export type RotationEntry = { caseId: string; priorRevision: string; priorDigest: string;
  nextRevision: string; nextGeneration: number; package: CasePackageV1; digest: string };
export type RotationJournal = { id: string; operationId: string;
  kind: 'generation' | 'recovery'; status: 'prepared' | 'committed';
  accountId: string; priorRootProof: string; entries: RotationEntry[];
  priorRecoveryEnvelope?: RecoveryEnvelopeV1;
  newRecoveryEnvelope?: RecoveryEnvelopeV1; newRootProof?: string; newDeviceId?: string;
  result?: { rotated: number; revisions: Array<{ caseId: string; revisionId: string }> } };

const MAX_KEY_USES = 1_048_576;
const MAX_SYNC_STEP_BYTES = 8 * 1024 * 1024;
const HEX_256 = /^[0-9a-f]{64}$/;

async function digestText(value: string): Promise<string> {
  const bytes = utf8Bytes(value);
  try {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } finally { bytes.fill(0); }
}

function validLedger(caseData: CaseV1, ledger: ImportLedger): void {
  if (!exactKeys(ledger, ['schemaVersion', 'reviews']) || ledger.schemaVersion !== '1' ||
      !Array.isArray(ledger.reviews)) throw new StorageError('INVALID_REVIEWED_CASE');
  const artifacts = new Map(caseData.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const proposals = new Map(caseData.proposals.map((proposal) => [proposal.proposalId, proposal]));
  const commands = new Set<string>();
  const reviewedArtifacts = new Set<string>();
  for (const review of ledger.reviews) {
    if (!exactKeys(review, ['artifactId', 'sha256', 'accountRefId', 'commandId',
      'recordedAt', 'baseHead', 'decisions', 'decisionDigest']) ||
        !validId(review.artifactId) || !validId(review.commandId) ||
        !HEX_256.test(review.sha256) || !HEX_256.test(review.decisionDigest) ||
        !Array.isArray(review.decisions) || commands.has(review.commandId) ||
        reviewedArtifacts.has(review.artifactId) ||
        artifacts.get(review.artifactId)?.sha256 !== review.sha256) {
      throw new StorageError('INVALID_REVIEWED_CASE');
    }
    commands.add(review.commandId);
    reviewedArtifacts.add(review.artifactId);
    for (const decision of review.decisions) {
      if (!decision || !validId(decision.proposalId) ||
          proposals.get(decision.proposalId)?.artifactId !== review.artifactId) {
        throw new StorageError('INVALID_REVIEWED_CASE');
      }
    }
  }
}

async function validateStored(value: unknown, expectedCaseId: string, validateCase: CaseValidator): Promise<StoredCaseV1> {
  if (!exactKeys(value, ['schemaVersion', 'case', 'ledger'])) throw new StorageError('INVALID_REVIEWED_CASE');
  const stored = value as StoredCaseV1;
  if (stored.schemaVersion !== '1' || !stored.case || stored.case.caseId !== expectedCaseId) {
    throw new StorageError('INVALID_REVIEWED_CASE');
  }
  try {
    validCaseShape(stored.case);
    validLedger(stored.case, stored.ledger);
    await validateCase(structuredClone(stored.case));
  } catch {
    throw new StorageError('INVALID_REVIEWED_CASE');
  }
  return stored;
}

function parseStored(value: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new StorageError('CORRUPT_RECORD'); }
}

function checkedStringify(value: unknown): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new StorageError('INVALID_REVIEWED_CASE'); }
  if (typeof serialized !== 'string') throw new StorageError('INVALID_REVIEWED_CASE');
  return serialized;
}

function validateCommit(input: ReviewedCommit): number | undefined {
  const keys = ['case', 'ledger', 'revisionId', 'operationId', 'expectedLocalRevision', 'serverRevision'];
  if (!exactKeys(input, keys) && !exactKeys(input, [...keys, 'keyGeneration'])) {
    throw new StorageError('INVALID_COMMIT');
  }
  if (!validId(input.revisionId) || !validId(input.operationId) ||
      (input.expectedLocalRevision !== null && !validId(input.expectedLocalRevision)) ||
      (input.serverRevision !== null && !validId(input.serverRevision)) ||
      input.revisionId === input.expectedLocalRevision) throw new StorageError('INVALID_COMMIT');
  const generation = input.keyGeneration;
  if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 1 ||
      generation > 2_147_483_647)) {
    throw new StorageError('INVALID_COMMIT');
  }
  return generation;
}

async function prepareSteps(pkg: CasePackageV1, operationId: string, packageDigest: string): Promise<SyncStep[]> {
  const chunkDigests: string[] = [];
  const steps: SyncStep[] = [];
  for (const chunk of pkg.chunks) {
    const body = checkedStringify({ schemaVersion: '1', kind: 'chunk', accountId: pkg.accountId,
      caseId: pkg.caseId, revisionId: pkg.revisionId, packageId: pkg.packageId,
      index: chunk.index, chunkCount: pkg.chunks.length, nonce: chunk.nonce,
      ciphertext: chunk.ciphertext, tag: chunk.tag });
    if (body.length > MAX_SYNC_STEP_BYTES) throw new StorageError('SYNC_STEP_TOO_LARGE');
    chunkDigests.push(await digestText(body));
    steps.push({ idempotencyKey: `${operationId}:chunk:${chunk.index}`, kind: 'chunk', body });
  }
  const manifest = checkedStringify({ schemaVersion: '1', kind: 'manifest',
    format: pkg.format, algorithm: pkg.algorithm, accountId: pkg.accountId,
    caseId: pkg.caseId, revisionId: pkg.revisionId, deviceId: pkg.deviceId,
    keyGeneration: pkg.keyGeneration, packageId: pkg.packageId,
    chunkCount: pkg.chunks.length, chunkDigests, packageDigest });
  if (manifest.length > MAX_SYNC_STEP_BYTES) throw new StorageError('SYNC_STEP_TOO_LARGE');
  steps.push({ idempotencyKey: `${operationId}:manifest`, kind: 'manifest', body: manifest });
  return steps;
}

export class LocalRepository {
  #db: IDBDatabase | null;
  readonly session: AccountSession;
  readonly #validateCase: CaseValidator;

  constructor(db: IDBDatabase, session: AccountSession, validateCase: CaseValidator) {
    session.bindLocalStorage(db.name);
    this.#db = db;
    this.session = session;
    this.#validateCase = validateCase;
  }

  private db(): IDBDatabase {
    if (this.session.locked) throw new CryptoError('KEY_LOCKED');
    if (!this.#db) throw new StorageError('STORAGE_CLOSED');
    return this.#db;
  }

  close(): void { this.#db?.close(); this.#db = null; }
  lock(): void { this.session.lock(); this.close(); }

  async recoveryEnvelope(): Promise<RecoveryEnvelopeV1> {
    const db = this.db();
    return transactionResult(db, ['accounts'], 'readonly', (tx, finish, fail) => {
      const request = tx.objectStore('accounts').get(this.session.accountId);
      request.onsuccess = () => {
        const record = request.result as AccountRecord | undefined;
        if (!record) fail(new StorageError('CORRUPT_RECORD'));
        else finish(structuredClone(record.recoveryEnvelope));
      };
    });
  }

  async encryptedSnapshot(): Promise<{ recoveryEnvelope: RecoveryEnvelopeV1; cases: CaseRecord[] }> {
    const db = this.db();
    const accountId = this.session.accountId;
    const snapshot = await transactionResult<{
      account: AccountRecord | undefined; cases: CaseRecord[]; anchors: AnchorRecord[];
    }>(db, ['accounts', 'cases', 'anchors'], 'readonly', (tx, finish) => {
      let account: AccountRecord | undefined;
      let cases: CaseRecord[] = [];
      const accountRequest = tx.objectStore('accounts').get(accountId);
      const caseRequest = tx.objectStore('cases').getAll();
      const anchorRequest = tx.objectStore('anchors').getAll();
      accountRequest.onsuccess = () => { account = accountRequest.result as AccountRecord | undefined; };
      caseRequest.onsuccess = () => { cases = caseRequest.result as CaseRecord[]; };
      anchorRequest.onsuccess = () => finish({ account, cases,
        anchors: anchorRequest.result as AnchorRecord[] });
    });
    if (!snapshot.account || snapshot.account.accountId !== accountId) throw new StorageError('CORRUPT_RECORD');
    const cases = snapshot.cases.filter((item) => item.accountId === accountId);
    const anchors = snapshot.anchors.filter((item) => item.accountId === accountId);
    if (cases.length > 64 || cases.length !== anchors.length) throw new StorageError('CORRUPT_RECORD');
    const anchorByCase = new Map(anchors.map((anchor) => [anchor.caseId, anchor]));
    for (const item of cases) {
      const anchor = anchorByCase.get(item.caseId);
      if (!validId(item.caseId) || !validId(item.revisionId) ||
          item.package?.accountId !== accountId || item.package?.caseId !== item.caseId ||
          item.package?.revisionId !== item.revisionId ||
          item.package?.keyGeneration !== item.keyGeneration ||
          !Number.isSafeInteger(item.localSequence) || item.localSequence < 1 ||
          !Number.isSafeInteger(item.keyGeneration) || item.keyGeneration < 1 ||
          !anchor || anchor.revisionId !== item.revisionId || anchor.digest !== item.digest ||
          !HEX_256.test(item.digest) || await digestText(checkedStringify(item.package)) !== item.digest) {
        throw new StorageError('CORRUPT_RECORD');
      }
      try {
        const plaintext = await openCase(this.session, item.package, item.caseId, item.revisionId);
        await validateStored(parseStored(plaintext), item.caseId, this.#validateCase);
      } catch { throw new StorageError('CORRUPT_RECORD'); }
    }
    return { recoveryEnvelope: structuredClone(snapshot.account.recoveryEnvelope), cases };
  }

  async currentRevision(caseId: string): Promise<string | null> {
    const loaded = await this.loadCase(caseId);
    return loaded?.revisionId ?? null;
  }

  async inspectArchivedCases(records: CaseRecord[]): Promise<Array<{
    caseId: string; archivedRevision: string; currentRevision: string | null;
    sameCiphertext: boolean; artifacts: Array<{ artifactId: string; sha256: string }>;
  }>> {
    this.db();
    const result = [];
    for (const record of records) {
      if (!record || record.accountId !== this.session.accountId ||
          !validId(record.caseId) || !validId(record.revisionId) || !HEX_256.test(record.digest) ||
          record.package?.accountId !== record.accountId ||
          record.package?.caseId !== record.caseId ||
          record.package?.revisionId !== record.revisionId ||
          record.package?.keyGeneration !== record.keyGeneration ||
          await digestText(checkedStringify(record.package)) !== record.digest) {
        throw new StorageError('CORRUPT_ARCHIVE');
      }
      let stored: StoredCaseV1;
      try {
        const plaintext = await openCase(this.session, record.package, record.caseId, record.revisionId);
        stored = await validateStored(parseStored(plaintext), record.caseId, this.#validateCase);
      } catch { throw new StorageError('CORRUPT_ARCHIVE'); }
      const current = await this.loadCase(record.caseId);
      const currentDigest = current ? await this.caseDigest(record.caseId) : null;
      result.push({ caseId: record.caseId, archivedRevision: record.revisionId,
        currentRevision: current?.revisionId ?? null,
        sameCiphertext: currentDigest === record.digest,
        artifacts: stored.case.artifacts.map((artifact) => ({
          artifactId: artifact.artifactId, sha256: artifact.sha256,
        })) });
    }
    return result;
  }

  async caseDigest(caseId: string): Promise<string | null> {
    const db = this.db();
    if (!validId(caseId)) throw new StorageError('INVALID_CASE_ID');
    return transactionResult(db, ['anchors'], 'readonly', (tx, finish) => {
      const request = tx.objectStore('anchors').get([this.session.accountId, caseId]);
      request.onsuccess = () => finish((request.result as AnchorRecord | undefined)?.digest ?? null);
    });
  }

  async rootProof(): Promise<string> {
    this.db();
    const bytes = await this.session.verificationBytes();
    try { return base64UrlEncode(bytes); }
    finally { bytes.fill(0); }
  }

  async recordPreparedRotation(journal: RotationJournal): Promise<void> {
    const db = this.db();
    if (!journal || !validId(journal.operationId) ||
        journal.id !== `rotation:${journal.operationId}` ||
        journal.accountId !== this.session.accountId ||
        journal.status !== 'prepared' ||
        !['generation', 'recovery'].includes(journal.kind) ||
        !Array.isArray(journal.entries) || journal.entries.length > 64 ||
        journal.priorRootProof !== await this.rootProof()) {
      throw new StorageError('INVALID_ROTATION');
    }
    let copied: RotationJournal;
    try { copied = structuredClone(journal); }
    catch { throw new StorageError('INVALID_ROTATION'); }
    return transactionResult(db, ['migrations'], 'readwrite', (tx, finish, fail) => {
      const store = tx.objectStore('migrations');
      const request = store.get(copied.id);
      request.onsuccess = () => {
        if (request.result !== undefined) { fail(new StorageError('OPERATION_CONFLICT')); return; }
        store.put(copied);
        finish(undefined);
      };
    });
  }

  async readRotation(operationId: string): Promise<RotationJournal> {
    const db = this.db();
    if (!validId(operationId)) throw new StorageError('INVALID_ROTATION');
    return transactionResult(db, ['migrations'], 'readonly', (tx, finish, fail) => {
      const request = tx.objectStore('migrations').get(`rotation:${operationId}`);
      request.onsuccess = () => {
        const item = request.result as RotationJournal | undefined;
        if (!item) { fail(new StorageError('ROTATION_MISSING')); return; }
        finish(structuredClone(item));
      };
    });
  }

  async abortRotation(operationId: string): Promise<void> {
    const db = this.db();
    if (!validId(operationId)) throw new StorageError('INVALID_ROTATION');
    return transactionResult(db, ['migrations'], 'readwrite', (tx, finish, fail) => {
      const store = tx.objectStore('migrations');
      const request = store.get(`rotation:${operationId}`);
      request.onsuccess = () => {
        const item = request.result as RotationJournal | undefined;
        if (!item) { fail(new StorageError('ROTATION_MISSING')); return; }
        if (item.status !== 'prepared') { fail(new StorageError('ROTATION_COMMITTED')); return; }
        store.delete(item.id);
        finish(undefined);
      };
    });
  }

  async commitPreparedRotation(operationId: string,
    nextSession: AccountSession): Promise<{ rotated: number;
      revisions: Array<{ caseId: string; revisionId: string }> }> {
    const db = this.db();
    nextSession.bindLocalStorage(db.name);
    const journal = await this.readRotation(operationId);
    if (journal.status === 'committed' && journal.result) return journal.result;
    if (journal.status !== 'prepared' || journal.id !== `rotation:${operationId}` ||
        journal.accountId !== this.session.accountId ||
        nextSession.accountId !== this.session.accountId ||
        journal.priorRootProof !== await this.rootProof() ||
        !journal.priorRecoveryEnvelope ||
        !['generation', 'recovery'].includes(journal.kind) ||
        !Array.isArray(journal.entries) || journal.entries.length > 64) {
      throw new StorageError('INVALID_ROTATION');
    }
    const nextProofBytes = await nextSession.verificationBytes();
    const nextProof = base64UrlEncode(nextProofBytes);
    nextProofBytes.fill(0);
    if (journal.kind === 'generation' && (nextProof !== journal.priorRootProof ||
        journal.newRecoveryEnvelope !== undefined || journal.newRootProof !== undefined ||
        journal.newDeviceId !== undefined)) {
      throw new StorageError('WRONG_KEY');
    }
    if (journal.kind === 'recovery' && (!journal.newRecoveryEnvelope ||
        journal.newRootProof !== nextProof || nextProof === journal.priorRootProof)) {
      throw new StorageError('WRONG_KEY');
    }
    if (journal.kind === 'recovery') {
      try { base64UrlDecode(journal.newDeviceId, 16, 16); }
      catch { throw new StorageError('INVALID_ROTATION'); }
    }
    const snapshot = await this.encryptedSnapshot();
    if (JSON.stringify(snapshot.recoveryEnvelope) !==
        JSON.stringify(journal.priorRecoveryEnvelope)) {
      throw new StorageError('STALE_LOCAL_REVISION');
    }
    if (snapshot.cases.length !== journal.entries.length ||
        new Set(journal.entries.map((item) => item.caseId)).size !== journal.entries.length) {
      throw new StorageError('STALE_LOCAL_REVISION');
    }
    const currentByCase = new Map(snapshot.cases.map((item) => [item.caseId, item]));
    const prepared: Array<{ entry: RotationEntry; operationId: string; steps: SyncStep[] }> = [];
    for (const entry of journal.entries) {
      const current = currentByCase.get(entry.caseId);
      if (!current || current.revisionId !== entry.priorRevision ||
          current.digest !== entry.priorDigest || !validId(entry.nextRevision) ||
          entry.package?.accountId !== this.session.accountId ||
          entry.package.caseId !== entry.caseId ||
          entry.package.revisionId !== entry.nextRevision ||
          entry.package.keyGeneration !== entry.nextGeneration ||
          (journal.kind === 'generation' && entry.nextGeneration !== current.keyGeneration + 1) ||
          (journal.kind === 'recovery' && entry.nextGeneration !== 1) ||
          (journal.kind === 'recovery' && entry.package.deviceId !== journal.newDeviceId) ||
          !HEX_256.test(entry.digest) ||
          await digestText(checkedStringify(entry.package)) !== entry.digest) {
        throw new StorageError('INVALID_ROTATION');
      }
      let nextStored: StoredCaseV1;
      try {
        const plaintext = await openCase(nextSession, entry.package, entry.caseId, entry.nextRevision);
        nextStored = await validateStored(parseStored(plaintext), entry.caseId, this.#validateCase);
      } catch { throw new StorageError('INVALID_ROTATION'); }
      const currentLoaded = await this.loadCase(entry.caseId);
      if (!currentLoaded || JSON.stringify({ case: currentLoaded.case, ledger: currentLoaded.ledger }) !==
          JSON.stringify({ case: nextStored.case, ledger: nextStored.ledger })) {
        throw new StorageError('INVALID_ROTATION');
      }
      const syncOperationId = `rot_${base64UrlEncode(randomBytes(16))}`;
      if (prepared.some((item) => item.operationId === syncOperationId)) {
        throw new StorageError('OPERATION_CONFLICT');
      }
      prepared.push({ entry, operationId: syncOperationId,
        steps: await prepareSteps(entry.package, syncOperationId, entry.digest) });
    }
    const result = { rotated: prepared.length,
      revisions: prepared.map(({ entry }) => ({ caseId: entry.caseId,
        revisionId: entry.nextRevision })) };
    return transactionResult(db, ['accounts', 'cases', 'anchors', 'outbox', 'migrations'],
      'readwrite', (tx, finish, fail) => {
        const accounts = tx.objectStore('accounts');
        const cases = tx.objectStore('cases');
        const anchors = tx.objectStore('anchors');
        const outbox = tx.objectStore('outbox');
        const migrations = tx.objectStore('migrations');
        let account: AccountRecord | undefined;
        let currentCases: CaseRecord[] = [];
        let currentAnchors: AnchorRecord[] = [];
        let currentOutbox: OutboxRecord[] = [];
        const accountRequest = accounts.get(this.session.accountId);
        const caseRequest = cases.getAll();
        const anchorRequest = anchors.getAll();
        const outboxRequest = outbox.getAll();
        const journalRequest = migrations.get(journal.id);
        accountRequest.onsuccess = () => { account = accountRequest.result as AccountRecord | undefined; };
        caseRequest.onsuccess = () => { currentCases = caseRequest.result as CaseRecord[]; };
        anchorRequest.onsuccess = () => { currentAnchors = anchorRequest.result as AnchorRecord[]; };
        outboxRequest.onsuccess = () => { currentOutbox = outboxRequest.result as OutboxRecord[]; };
        journalRequest.onsuccess = () => {
          const liveJournal = journalRequest.result as RotationJournal | undefined;
          if (!account || account.rootProof !== journal.priorRootProof ||
              JSON.stringify(account.recoveryEnvelope) !==
                JSON.stringify(journal.priorRecoveryEnvelope) ||
              liveJournal?.status !== 'prepared' ||
              JSON.stringify(liveJournal) !== JSON.stringify(journal)) {
            fail(new StorageError('STALE_LOCAL_REVISION')); return;
          }
          const ownCases = currentCases.filter((item) => item.accountId === this.session.accountId);
          if (ownCases.length !== prepared.length) {
            fail(new StorageError('STALE_LOCAL_REVISION')); return;
          }
          const liveByCase = new Map(ownCases.map((item) => [item.caseId, item]));
          const anchorByCase = new Map(currentAnchors.filter((item) =>
            item.accountId === this.session.accountId).map((item) => [item.caseId, item]));
          for (const { entry } of prepared) {
            const prior = liveByCase.get(entry.caseId);
            const anchor = anchorByCase.get(entry.caseId);
            if (!prior || !anchor || prior.revisionId !== entry.priorRevision ||
                prior.digest !== entry.priorDigest || anchor.digest !== prior.digest ||
                anchor.revisionId !== prior.revisionId) {
              fail(new StorageError('STALE_LOCAL_REVISION')); return;
            }
          }
          for (const { entry, operationId: syncOperationId, steps } of prepared) {
            const prior = liveByCase.get(entry.caseId)!;
            if (currentOutbox.some((item) => item.accountId === this.session.accountId &&
                item.operationId === syncOperationId)) {
              fail(new StorageError('OPERATION_CONFLICT')); return;
            }
            for (const pending of currentOutbox) {
              if (pending.accountId === this.session.accountId && pending.caseId === entry.caseId) {
                outbox.delete([this.session.accountId, pending.operationId]);
              }
            }
            const localSequence = prior.localSequence + 1;
            const nextCase: CaseRecord = { accountId: this.session.accountId,
              caseId: entry.caseId, revisionId: entry.nextRevision,
              keyGeneration: entry.nextGeneration, localSequence,
              package: entry.package, digest: entry.digest };
            const nextAnchor: AnchorRecord = { accountId: this.session.accountId,
              caseId: entry.caseId, revisionId: entry.nextRevision, digest: entry.digest };
            const nextOutbox: OutboxRecord = { accountId: this.session.accountId,
              caseId: entry.caseId, operationId: syncOperationId,
              revisionId: entry.nextRevision, expectedServerRevision: null,
              localSequence, steps };
            try { cases.put(nextCase); anchors.put(nextAnchor); outbox.put(nextOutbox); }
            catch (error) { fail(storageFault(error)); return; }
          }
          try {
            if (journal.kind === 'recovery') {
              accounts.put({ accountId: this.session.accountId,
                recoveryEnvelope: journal.newRecoveryEnvelope, rootProof: nextProof,
                deviceId: journal.newDeviceId });
            }
            migrations.put({ id: journal.id, operationId, kind: journal.kind,
              status: 'committed', accountId: journal.accountId,
              priorRootProof: journal.priorRootProof, entries: [],
              newRecoveryEnvelope: journal.newRecoveryEnvelope,
              newRootProof: journal.newRootProof,
              newDeviceId: journal.newDeviceId, result });
          } catch (error) { fail(storageFault(error)); return; }
          finish(result);
        };
      });
  }

  async replaceEncryptedCases(
    inputRecords: CaseRecord[], expectedLocalRevisions: Record<string, string | null>,
  ): Promise<{ restored: number; unchanged: number }> {
    const db = this.db();
    if (!Array.isArray(inputRecords) || inputRecords.length < 1 || inputRecords.length > 64 ||
        !expectedLocalRevisions || typeof expectedLocalRevisions !== 'object' ||
        Array.isArray(expectedLocalRevisions)) throw new StorageError('INVALID_RESTORE');
    const accountId = this.session.accountId;
    const caseIds = new Set<string>();
    const prepared: Array<{ record: CaseRecord; operationId: string; steps: SyncStep[] }> = [];
    for (const record of inputRecords) {
      if (!record || !validId(record.caseId) || !validId(record.revisionId) ||
          record.accountId !== accountId || caseIds.has(record.caseId) ||
          record.package?.accountId !== accountId || record.package?.caseId !== record.caseId ||
          record.package?.revisionId !== record.revisionId ||
          record.package?.keyGeneration !== record.keyGeneration ||
          !Object.hasOwn(expectedLocalRevisions, record.caseId) ||
          !HEX_256.test(record.digest) ||
          await digestText(checkedStringify(record.package)) !== record.digest) {
        throw new StorageError('INVALID_RESTORE');
      }
      caseIds.add(record.caseId);
      try {
        const plaintext = await openCase(this.session, record.package, record.caseId, record.revisionId);
        await validateStored(parseStored(plaintext), record.caseId, this.#validateCase);
      } catch { throw new StorageError('CORRUPT_ARCHIVE'); }
      const operationId = `restore_${base64UrlEncode(randomBytes(16))}`;
      if (prepared.some((item) => item.operationId === operationId)) {
        throw new StorageError('OPERATION_CONFLICT');
      }
      const steps = await prepareSteps(record.package, operationId, record.digest);
      prepared.push({ record: structuredClone(record), operationId, steps });
    }
    if (Object.keys(expectedLocalRevisions).length !== caseIds.size ||
        Object.values(expectedLocalRevisions).some((value) => value !== null && !validId(value))) {
      throw new StorageError('INVALID_RESTORE');
    }
    const expectedRootProof = await this.rootProof();
    const expectedDeviceId = this.session.deviceId;
    return transactionResult(db, ['accounts', 'cases', 'anchors', 'outbox'], 'readwrite', (tx, finish, fail) => {
      const accounts = tx.objectStore('accounts');
      const cases = tx.objectStore('cases');
      const anchors = tx.objectStore('anchors');
      const outbox = tx.objectStore('outbox');
      let currentCases: CaseRecord[] = [];
      let currentAnchors: AnchorRecord[] = [];
      const accountRequest = accounts.get(accountId);
      const caseRequest = cases.getAll();
      const anchorRequest = anchors.getAll();
      const outboxRequest = outbox.getAll();
      accountRequest.onsuccess = () => {
        const account = accountRequest.result as AccountRecord | undefined;
        const legacyWithoutDevice = db.version === 1 && account?.deviceId === undefined;
        if (!account || account.rootProof !== expectedRootProof ||
            (account.deviceId !== expectedDeviceId && !legacyWithoutDevice)) {
          fail(new StorageError('STALE_ACCOUNT_ROOT'));
        }
      };
      caseRequest.onsuccess = () => { currentCases = caseRequest.result as CaseRecord[]; };
      anchorRequest.onsuccess = () => { currentAnchors = anchorRequest.result as AnchorRecord[]; };
      outboxRequest.onsuccess = () => {
        const currentOutbox = outboxRequest.result as OutboxRecord[];
        const byCase = new Map(currentCases.filter((item) => item.accountId === accountId)
          .map((item) => [item.caseId, item]));
        const anchorByCase = new Map(currentAnchors.filter((item) => item.accountId === accountId)
          .map((item) => [item.caseId, item]));
        for (const { record } of prepared) {
          const prior = byCase.get(record.caseId);
          const anchor = anchorByCase.get(record.caseId);
          if ((prior?.revisionId ?? null) !== expectedLocalRevisions[record.caseId]) {
            fail(new StorageError('STALE_LOCAL_REVISION')); return;
          }
          if ((prior && (!anchor || anchor.digest !== prior.digest ||
              anchor.revisionId !== prior.revisionId)) || (!prior && anchor)) {
            fail(new StorageError('CORRUPT_RECORD')); return;
          }
        }
        let restored = 0;
        let unchanged = 0;
        for (const { record, operationId, steps } of prepared) {
          const prior = byCase.get(record.caseId);
          if (prior?.revisionId === record.revisionId && prior.digest === record.digest) {
            unchanged++;
            continue;
          }
          if (currentOutbox.some((item) => item.accountId === accountId &&
              item.operationId === operationId)) {
            fail(new StorageError('OPERATION_CONFLICT')); return;
          }
          for (const existing of currentOutbox) {
            if (existing.accountId === accountId && existing.caseId === record.caseId) {
              outbox.delete([accountId, existing.operationId]);
            }
          }
          const localSequence = (prior?.localSequence ?? 0) + 1;
          const nextCase: CaseRecord = { ...record, localSequence };
          const nextAnchor: AnchorRecord = { accountId, caseId: record.caseId,
            revisionId: record.revisionId, digest: record.digest };
          const nextOutbox: OutboxRecord = { accountId, caseId: record.caseId,
            operationId, revisionId: record.revisionId, expectedServerRevision: null,
            localSequence, steps };
          try { cases.put(nextCase); anchors.put(nextAnchor); outbox.put(nextOutbox); }
          catch (error) { fail(storageFault(error)); return; }
          restored++;
        }
        finish({ restored, unchanged });
      };
    });
  }

  async reserveEncryptions(caseId: string, keyGeneration: number, uses: number): Promise<number> {
    return this.reserveEncryptionsForDevice(caseId, keyGeneration, this.session.deviceId, uses);
  }

  async reserveEncryptionsForDevice(caseId: string, keyGeneration: number,
    deviceId: string, uses: number): Promise<number> {
    const db = this.db();
    if (!validId(caseId) || !Number.isSafeInteger(keyGeneration) || keyGeneration < 1 ||
        keyGeneration > 2_147_483_647 || !Number.isSafeInteger(uses) || uses < 1 ||
        uses > MAX_KEY_USES) throw new StorageError('INVALID_RESERVATION');
    try { base64UrlDecode(deviceId, 16, 16); }
    catch { throw new StorageError('INVALID_RESERVATION'); }
    const accountId = this.session.accountId;
    const key = [accountId, caseId, keyGeneration, deviceId];
    return transactionResult(db, ['budgets'], 'readwrite', (tx, finish, fail) => {
      const store = tx.objectStore('budgets');
      const request = store.get(key);
      request.onsuccess = () => {
        const previous = request.result as BudgetRecord | undefined;
        const used = previous?.used ?? 0;
        if (!Number.isSafeInteger(used) || used < 0 || used > MAX_KEY_USES) {
          fail(new StorageError('CORRUPT_RECORD')); return;
        }
        if (used + uses > MAX_KEY_USES) { fail(new StorageError('KEY_USE_LIMIT')); return; }
        try { store.put({ accountId, caseId, keyGeneration, deviceId, used: used + uses }); }
        catch (error) { fail(storageFault(error)); return; }
        finish(used + uses);
      };
    });
  }

  async commitReviewed(input: ReviewedCommit): Promise<{ revisionId: string; packageId: string; digest: string }> {
    const db = this.db();
    let copied: ReviewedCommit;
    try { copied = structuredClone(input); }
    catch { throw new StorageError('INVALID_COMMIT'); }
    const requestedGeneration = validateCommit(copied);
    const caseId = copied.case?.caseId;
    if (!validId(caseId)) throw new StorageError('INVALID_COMMIT');
    const payload = { schemaVersion: '1', case: copied.case, ledger: copied.ledger };
    const plaintext = checkedStringify(payload);
    const bytes = utf8Bytes(plaintext);
    const size = bytes.length;
    bytes.fill(0);
    if (size < 1 || size > MAX_CASE_BYTES) throw new StorageError('CASE_TOO_LARGE');
    await validateStored(parseStored(plaintext), caseId, this.#validateCase);
    const current = await this.loadCase(caseId);
    if ((current?.revisionId ?? null) !== copied.expectedLocalRevision) {
      throw new StorageError('STALE_LOCAL_REVISION');
    }
    const generation = requestedGeneration ?? current?.keyGeneration ?? 1;
    if ((current && generation !== current.keyGeneration) || (!current && generation !== 1)) {
      throw new StorageError('STALE_KEY_GENERATION');
    }
    const count = Math.ceil(size / MAX_CHUNK_BYTES);
    if (count < 1 || count > MAX_CHUNKS) throw new StorageError('CASE_TOO_LARGE');
    const reservedDeviceId = this.session.deviceId;
    await this.reserveEncryptionsForDevice(caseId, generation, reservedDeviceId, count);
    const pkg = await sealCase(this.session, caseId, copied.revisionId, plaintext, generation);
    if (pkg.deviceId !== reservedDeviceId) throw new StorageError('STALE_ACCOUNT_ROOT');
    const digest = await digestText(checkedStringify(pkg));
    const steps = await prepareSteps(pkg, copied.operationId, digest);
    const accountId = this.session.accountId;
    const expectedRootProof = await this.rootProof();
    const expectedDeviceId = reservedDeviceId;
    const caseKey = [accountId, caseId];
    const operationKey = [accountId, copied.operationId];
    return transactionResult(db, ['accounts', 'cases', 'outbox', 'anchors'], 'readwrite', (tx, finish, fail) => {
      const accounts = tx.objectStore('accounts');
      const cases = tx.objectStore('cases');
      const outbox = tx.objectStore('outbox');
      const anchors = tx.objectStore('anchors');
      const getAccount = accounts.get(accountId);
      getAccount.onsuccess = () => {
        const account = getAccount.result as AccountRecord | undefined;
        const legacyWithoutDevice = db.version === 1 && account?.deviceId === undefined;
        if (!account || account.rootProof !== expectedRootProof ||
            (account.deviceId !== expectedDeviceId && !legacyWithoutDevice)) {
          fail(new StorageError('STALE_ACCOUNT_ROOT')); return;
        }
        const getCase = cases.get(caseKey);
        getCase.onsuccess = () => {
          const prior = getCase.result as CaseRecord | undefined;
          if ((prior?.revisionId ?? null) !== copied.expectedLocalRevision) {
            fail(new StorageError('STALE_LOCAL_REVISION')); return;
          }
          if (prior && (!Number.isSafeInteger(prior.localSequence) || prior.localSequence < 1 ||
              !HEX_256.test(prior.digest))) { fail(new StorageError('CORRUPT_RECORD')); return; }
          const getAnchor = anchors.get(caseKey);
          getAnchor.onsuccess = () => {
            const anchor = getAnchor.result as AnchorRecord | undefined;
            if ((!prior && anchor) || (prior && (!anchor || anchor.revisionId !== prior.revisionId ||
                anchor.digest !== prior.digest))) {
              fail(new StorageError('CORRUPT_RECORD')); return;
            }
            const getOperation = outbox.get(operationKey);
            getOperation.onsuccess = () => {
              if (getOperation.result !== undefined) { fail(new StorageError('OPERATION_CONFLICT')); return; }
              const localSequence = (prior?.localSequence ?? 0) + 1;
              const caseRecord: CaseRecord = { accountId, caseId, revisionId: copied.revisionId,
                keyGeneration: generation, localSequence, package: pkg, digest };
              const outboxRecord: OutboxRecord = { accountId, caseId, operationId: copied.operationId,
                revisionId: copied.revisionId, expectedServerRevision: copied.serverRevision,
                localSequence, steps };
              const anchorRecord: AnchorRecord = { accountId, caseId, revisionId: copied.revisionId, digest };
              try { cases.put(caseRecord); outbox.put(outboxRecord); anchors.put(anchorRecord); }
              catch (error) { fail(storageFault(error)); return; }
              finish({ revisionId: copied.revisionId, packageId: pkg.packageId, digest });
            };
          };
        };
      };
    });
  }

  async loadCase(caseId: string): Promise<LoadedCase | null> {
    const db = this.db();
    if (!validId(caseId)) throw new StorageError('INVALID_CASE_ID');
    const accountId = this.session.accountId;
    const records = await transactionResult<{ caseRecord: CaseRecord | undefined; anchor: AnchorRecord | undefined }>(
      db, ['cases', 'anchors'], 'readonly', (tx, finish) => {
      const caseRequest = tx.objectStore('cases').get([accountId, caseId]);
      const anchorRequest = tx.objectStore('anchors').get([accountId, caseId]);
      let caseRecord: CaseRecord | undefined;
      let anchor: AnchorRecord | undefined;
      caseRequest.onsuccess = () => { caseRecord = caseRequest.result as CaseRecord | undefined; };
      anchorRequest.onsuccess = () => { anchor = anchorRequest.result as AnchorRecord | undefined; };
      // Both gets are issued in the same read transaction; completion is the read boundary.
      anchorRequest.addEventListener('success', () => finish({ caseRecord, anchor }));
      });
    const { caseRecord, anchor } = records;
    if (!caseRecord && !anchor) return null;
    if (!caseRecord || !anchor || caseRecord.accountId !== accountId ||
        caseRecord.caseId !== caseId || anchor.revisionId !== caseRecord.revisionId ||
        anchor.digest !== caseRecord.digest || !HEX_256.test(anchor.digest) ||
        caseRecord.package?.keyGeneration !== caseRecord.keyGeneration ||
        !Number.isSafeInteger(caseRecord.localSequence) || caseRecord.localSequence < 1) {
      throw new StorageError('CORRUPT_RECORD');
    }
    const currentDigest = await digestText(checkedStringify(caseRecord.package));
    if (currentDigest !== anchor.digest) throw new StorageError('CORRUPT_RECORD');
    const plaintext = await openCase(this.session, caseRecord.package, caseId, caseRecord.revisionId);
    let stored: StoredCaseV1;
    try { stored = await validateStored(parseStored(plaintext), caseId, this.#validateCase); }
    catch { throw new StorageError('CORRUPT_RECORD'); }
    return { case: stored.case, ledger: stored.ledger, revisionId: caseRecord.revisionId,
      keyGeneration: caseRecord.keyGeneration };
  }

  async prepareSync(caseId: string): Promise<PreparedSync[]> {
    const db = this.db();
    if (!validId(caseId)) throw new StorageError('INVALID_CASE_ID');
    const accountId = this.session.accountId;
    return transactionResult(db, ['outbox'], 'readonly', (tx, finish, fail) => {
      const request = tx.objectStore('outbox').index('byCase').getAll([accountId, caseId]);
      request.onsuccess = () => {
        const items = request.result as OutboxRecord[];
        if (items.some((item) => item.accountId !== accountId || item.caseId !== caseId ||
            !validId(item.operationId) || !validId(item.revisionId) ||
            !Number.isSafeInteger(item.localSequence) || item.localSequence < 1 ||
            !Array.isArray(item.steps) || item.steps.length < 2 || item.steps.length > MAX_CHUNKS + 1 ||
            item.steps.some((step) => typeof step.body !== 'string' ||
              step.body.length > MAX_SYNC_STEP_BYTES))) {
          fail(new StorageError('CORRUPT_RECORD')); return;
        }
        items.sort((a, b) => a.localSequence - b.localSequence);
        finish(items.map(({ operationId, caseId: itemCaseId, revisionId,
          expectedServerRevision, localSequence, steps }) => ({
          operationId, caseId: itemCaseId, revisionId, expectedServerRevision,
          localSequence, steps: structuredClone(steps),
        })));
      };
    });
  }

  async ackSync(operationId: string, confirmedRevisionId: string): Promise<void> {
    const db = this.db();
    if (!validId(operationId)) throw new StorageError('INVALID_OPERATION_ID');
    if (!validId(confirmedRevisionId)) throw new StorageError('INVALID_REVISION_ID');
    const accountId = this.session.accountId;
    const key = [accountId, operationId];
    return transactionResult(db, ['outbox'], 'readwrite', (tx, finish, fail) => {
      const store = tx.objectStore('outbox');
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result === undefined) { fail(new StorageError('OUTBOX_MISSING')); return; }
        const current = request.result as OutboxRecord;
        if (current.accountId !== accountId || current.operationId !== operationId ||
            !validId(current.caseId) || !validId(current.revisionId) ||
            !Number.isSafeInteger(current.localSequence) || current.localSequence < 1) {
          fail(new StorageError('CORRUPT_RECORD')); return;
        }
        if (current.revisionId !== confirmedRevisionId) {
          fail(new StorageError('SYNC_REVISION_MISMATCH')); return;
        }
        const pendingRequest = store.index('byCase').getAll([accountId, current.caseId]);
        pendingRequest.onsuccess = () => {
          const pending = pendingRequest.result as OutboxRecord[];
          const sequences = new Set<number>();
          for (const item of pending) {
            if (item.accountId !== accountId || item.caseId !== current.caseId ||
                !validId(item.operationId) || !validId(item.revisionId) ||
                !Number.isSafeInteger(item.localSequence) || item.localSequence < 1 ||
                (item.expectedServerRevision !== null && !validId(item.expectedServerRevision)) ||
                !Array.isArray(item.steps) || sequences.has(item.localSequence)) {
              fail(new StorageError('CORRUPT_RECORD')); return;
            }
            sequences.add(item.localSequence);
          }
          if (!pending.some((item) => item.operationId === operationId &&
              item.localSequence === current.localSequence)) {
            fail(new StorageError('CORRUPT_RECORD')); return;
          }
          if (pending.some((item) => item.localSequence < current.localSequence)) {
            fail(new StorageError('SYNC_OUT_OF_ORDER')); return;
          }
          const successor = pending.find((item) => item.localSequence === current.localSequence + 1);
          if (!successor && pending.some((item) => item.localSequence > current.localSequence)) {
            fail(new StorageError('CORRUPT_RECORD')); return;
          }
          try {
            if (successor) store.put({ ...successor, expectedServerRevision: confirmedRevisionId });
            store.delete(key);
          } catch (error) { fail(storageFault(error)); return; }
          finish(undefined);
        };
      };
    });
  }
}

export async function openLocalRepository(options: {
  dbName: string; session: AccountSession; validateCase: CaseValidator;
  recoveryEnvelope?: RecoveryEnvelopeV1; recoverySecret?: string;
}): Promise<LocalRepository> {
  if (!options || !(options.session instanceof AccountSession) ||
      options.session.locked) throw new CryptoError('KEY_LOCKED');
  if (typeof options.validateCase !== 'function') throw new StorageError('VALIDATOR_REQUIRED');
  options.session.bindLocalStorage(options.dbName);
  const proofBytes = await options.session.verificationBytes();
  const rootProof = base64UrlEncode(proofBytes);
  proofBytes.fill(0);
  const db = await openDatabase(options.dbName);
  try {
    const accountId = options.session.accountId;
    const existing = await transactionResult<AccountRecord | undefined>(db, ['accounts'], 'readonly', (tx, finish) => {
      const request = tx.objectStore('accounts').get(accountId);
      request.onsuccess = () => finish(request.result as AccountRecord | undefined);
    });
    let verifiedEnvelope: RecoveryEnvelopeV1 | undefined;
    if (existing) {
      if (existing.rootProof !== rootProof) throw new StorageError('WRONG_KEY');
    } else {
      if (!options.recoveryEnvelope || !options.recoverySecret) {
        throw new StorageError('RECOVERY_VERIFICATION_REQUIRED');
      }
      try { verifiedEnvelope = structuredClone(options.recoveryEnvelope); }
      catch { throw new StorageError('RECOVERY_VERIFICATION_REQUIRED'); }
      if (!await verifyRecoverySecret(options.session, verifiedEnvelope, options.recoverySecret)) {
        throw new StorageError('RECOVERY_VERIFICATION_REQUIRED');
      }
    }
    const boundDeviceId = await transactionResult<string>(db, ['accounts'], 'readwrite',
      (tx, finish, fail) => {
        const store = tx.objectStore('accounts');
        const request = store.get(accountId);
        request.onsuccess = () => {
          const concurrent = request.result as AccountRecord | undefined;
          if (concurrent && concurrent.rootProof !== rootProof) {
            fail(new StorageError('WRONG_KEY')); return;
          }
          if (concurrent?.deviceId !== undefined) {
            try { base64UrlDecode(concurrent.deviceId, 16, 16); }
            catch { fail(new StorageError('CORRUPT_RECORD')); return; }
            finish(concurrent.deviceId); return;
          }
          // Missing account metadata means its prior counter state is unavailable.
          // Mint a new key identity even if this unlocked session used this DB name before.
          const deviceId = base64UrlEncode(randomBytes(16));
          if (concurrent) store.put({ ...concurrent, deviceId });
          else if (verifiedEnvelope) store.put({ accountId,
            recoveryEnvelope: verifiedEnvelope, rootProof, deviceId });
          else { fail(new StorageError('RECOVERY_VERIFICATION_REQUIRED')); return; }
          finish(deviceId);
        };
      });
    options.session.bindLocalDeviceId(boundDeviceId);
    return new LocalRepository(db, options.session, options.validateCase);
  } catch (error) {
    db.close();
    throw error;
  }
}
