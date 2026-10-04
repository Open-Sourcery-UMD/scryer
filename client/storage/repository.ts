import { MAX_CASE_BYTES, MAX_CHUNK_BYTES, MAX_CHUNKS, CryptoError,
  base64UrlEncode, exactKeys, utf8Bytes, validId } from '../crypto/codec.ts';
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

type AccountRecord = { accountId: string; recoveryEnvelope: RecoveryEnvelopeV1; rootProof: string };
type CaseRecord = { accountId: string; caseId: string; revisionId: string;
  keyGeneration: number; localSequence: number; package: CasePackageV1; digest: string };
type AnchorRecord = { accountId: string; caseId: string; revisionId: string; digest: string };
type BudgetRecord = { accountId: string; caseId: string; keyGeneration: number; deviceId: string; used: number };
type OutboxRecord = PreparedSync & { accountId: string };

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

function validateCommit(input: ReviewedCommit): number {
  const keys = ['case', 'ledger', 'revisionId', 'operationId', 'expectedLocalRevision', 'serverRevision'];
  if (!exactKeys(input, keys) && !exactKeys(input, [...keys, 'keyGeneration'])) {
    throw new StorageError('INVALID_COMMIT');
  }
  if (!validId(input.revisionId) || !validId(input.operationId) ||
      (input.expectedLocalRevision !== null && !validId(input.expectedLocalRevision)) ||
      (input.serverRevision !== null && !validId(input.serverRevision)) ||
      input.revisionId === input.expectedLocalRevision) throw new StorageError('INVALID_COMMIT');
  const generation = input.keyGeneration ?? 1;
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 2_147_483_647) {
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

  async reserveEncryptions(caseId: string, keyGeneration: number, uses: number): Promise<number> {
    const db = this.db();
    if (!validId(caseId) || !Number.isSafeInteger(keyGeneration) || keyGeneration < 1 ||
        keyGeneration > 2_147_483_647 || !Number.isSafeInteger(uses) || uses < 1 ||
        uses > MAX_KEY_USES) throw new StorageError('INVALID_RESERVATION');
    const accountId = this.session.accountId;
    const deviceId = this.session.deviceId;
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
    const generation = validateCommit(copied);
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
    const count = Math.ceil(size / MAX_CHUNK_BYTES);
    if (count < 1 || count > MAX_CHUNKS) throw new StorageError('CASE_TOO_LARGE');
    await this.reserveEncryptions(caseId, generation, count);
    const pkg = await sealCase(this.session, caseId, copied.revisionId, plaintext, generation);
    const digest = await digestText(checkedStringify(pkg));
    const steps = await prepareSteps(pkg, copied.operationId, digest);
    const accountId = this.session.accountId;
    const caseKey = [accountId, caseId];
    const operationKey = [accountId, copied.operationId];
    return transactionResult(db, ['cases', 'outbox', 'anchors'], 'readwrite', (tx, finish, fail) => {
      const cases = tx.objectStore('cases');
      const outbox = tx.objectStore('outbox');
      const anchors = tx.objectStore('anchors');
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
        anchor.digest !== caseRecord.digest || !HEX_256.test(anchor.digest)) {
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

  async ackSync(operationId: string): Promise<void> {
    const db = this.db();
    if (!validId(operationId)) throw new StorageError('INVALID_OPERATION_ID');
    const key = [this.session.accountId, operationId];
    return transactionResult(db, ['outbox'], 'readwrite', (tx, finish, fail) => {
      const store = tx.objectStore('outbox');
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result === undefined) { fail(new StorageError('OUTBOX_MISSING')); return; }
        store.delete(key);
        finish(undefined);
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
    if (existing) {
      if (existing.rootProof !== rootProof) throw new StorageError('WRONG_KEY');
    } else {
      if (!options.recoveryEnvelope || !options.recoverySecret) {
        throw new StorageError('RECOVERY_VERIFICATION_REQUIRED');
      }
      let recoveryEnvelope: RecoveryEnvelopeV1;
      try { recoveryEnvelope = structuredClone(options.recoveryEnvelope); }
      catch { throw new StorageError('RECOVERY_VERIFICATION_REQUIRED'); }
      if (!await verifyRecoverySecret(options.session, recoveryEnvelope, options.recoverySecret)) {
        throw new StorageError('RECOVERY_VERIFICATION_REQUIRED');
      }
      await transactionResult(db, ['accounts'], 'readwrite', (tx, finish, fail) => {
        const store = tx.objectStore('accounts');
        const request = store.get(accountId);
        request.onsuccess = () => {
          const concurrent = request.result as AccountRecord | undefined;
          if (concurrent && concurrent.rootProof !== rootProof) {
            fail(new StorageError('WRONG_KEY')); return;
          }
          if (!concurrent) store.put({ accountId, recoveryEnvelope, rootProof });
          finish(undefined);
        };
      });
    }
    return new LocalRepository(db, options.session, options.validateCase);
  } catch (error) {
    db.close();
    throw error;
  }
}
