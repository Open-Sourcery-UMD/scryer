import { exactKeys, utf8Bytes, validId } from '../crypto/codec.ts';
import { maximalHeads } from '../import/case-shape.ts';
import type { CaseV1, ImportLedger } from '../import/types.ts';
import { StorageError } from '../storage/idb.ts';
import type { LocalRepository } from '../storage/repository.ts';
import { syncBodyDigest } from './transport.ts';
import type { SyncResult } from './transport.ts';

const MAX_HEAD_BYTES = 12 * 1024 * 1024;
const HEX_256 = /^[0-9a-f]{64}$/;
const PACKAGE_KEYS = ['schemaVersion', 'format', 'algorithm', 'accountId', 'caseId',
  'revisionId', 'deviceId', 'keyGeneration', 'packageId', 'chunks'] as const;
const CHUNK_KEYS = ['index', 'nonce', 'ciphertext', 'tag'] as const;

export class ConflictPreviewError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ConflictPreviewError'; this.code = code; }
}

export type ConflictBranch = { revisionId: string; case: CaseV1;
  ledger: ImportLedger; heads: string[] };
export type ConflictPreview = { caseId: string; pendingOperationId: string;
  pendingRevisionId: string; pendingManifestDigest: string;
  pendingStepsDigest: string; localCiphertextDigest: string;
  pendingExpectedServerRevision: string | null;
  local: ConflictBranch; remote: ConflictBranch;
  ancestor: { status: 'not_requested' | 'unavailable' } |
    { status: 'available'; branch: ConflictBranch } };

async function matchesPending(item: Awaited<ReturnType<LocalRepository['prepareSync']>>[number] | undefined,
  conflict: Extract<SyncResult, { status: 'conflict' }>): Promise<boolean> {
  if (!item || item.operationId !== conflict.pendingOperationId ||
      item.revisionId !== conflict.pendingRevisionId ||
      item.expectedServerRevision !== conflict.pendingExpectedServerRevision ||
      item.steps.at(-1)?.kind !== 'manifest') return false;
  try { return await syncBodyDigest(item.steps.at(-1)!.body) === conflict.pendingManifestDigest; }
  catch { return false; }
}

function packageFromConflict(body: string, accountId: string, caseId: string,
  revisionId: string): unknown {
  if (typeof body !== 'string' || body.length < 1 || body.length > MAX_HEAD_BYTES) {
    throw new ConflictPreviewError('REMOTE_UNVERIFIED');
  }
  try {
    if (utf8Bytes(body).length > MAX_HEAD_BYTES) {
      throw new ConflictPreviewError('REMOTE_UNVERIFIED');
    }
  } catch { throw new ConflictPreviewError('REMOTE_UNVERIFIED'); }
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { throw new ConflictPreviewError('REMOTE_UNVERIFIED'); }
  if (!exactKeys(value, PACKAGE_KEYS) || JSON.stringify(value) !== body ||
      Object.keys(value as object).join(',') !== PACKAGE_KEYS.join(',')) {
    throw new ConflictPreviewError('REMOTE_UNVERIFIED');
  }
  const pkg = value as Record<string, unknown>;
  if (pkg.accountId !== accountId || pkg.caseId !== caseId ||
      pkg.revisionId !== revisionId || !Array.isArray(pkg.chunks) ||
      pkg.chunks.length < 1 || pkg.chunks.length > 8 ||
      pkg.chunks.some((chunk) => typeof chunk !== 'object' || chunk === null ||
        !exactKeys(chunk, CHUNK_KEYS) ||
        Object.keys(chunk as object).join(',') !== CHUNK_KEYS.join(','))) {
    throw new ConflictPreviewError('REMOTE_UNVERIFIED');
  }
  return value;
}

export async function previewSyncConflict(repo: LocalRepository, caseId: string,
  conflict: SyncResult): Promise<ConflictPreview> {
  if (!validId(caseId) || !conflict || conflict.status !== 'conflict' ||
      !exactKeys(conflict, ['status', 'pendingOperationId', 'pendingRevisionId',
        'pendingManifestDigest', 'pendingExpectedServerRevision', 'remote', 'ancestor']) ||
      !validId(conflict.pendingOperationId) || !validId(conflict.pendingRevisionId) ||
      !HEX_256.test(conflict.pendingManifestDigest) ||
      (conflict.pendingExpectedServerRevision !== null &&
        !validId(conflict.pendingExpectedServerRevision)) ||
      !exactKeys(conflict.remote, ['revisionId', 'etag', 'ciphertextBody']) ||
      !validId(conflict.remote.revisionId) ||
      conflict.remote.etag !== `"${conflict.remote.revisionId}"`) {
    throw new ConflictPreviewError('REMOTE_UNVERIFIED');
  }
  if (!conflict.ancestor ||
      (conflict.ancestor.status === 'not_requested' &&
        (!exactKeys(conflict.ancestor, ['status']) ||
          conflict.pendingExpectedServerRevision !== null)) ||
      (conflict.ancestor.status === 'unavailable' &&
        (!exactKeys(conflict.ancestor, ['status']) ||
          conflict.pendingExpectedServerRevision === null)) ||
      (conflict.ancestor.status === 'available' &&
        (!exactKeys(conflict.ancestor, ['status', 'revisionId', 'etag', 'ciphertextBody']) ||
          conflict.pendingExpectedServerRevision === null ||
          conflict.ancestor.revisionId !== conflict.pendingExpectedServerRevision ||
          conflict.ancestor.etag !== `"${conflict.ancestor.revisionId}"`)) ||
      !['not_requested', 'unavailable', 'available'].includes(conflict.ancestor.status)) {
    throw new ConflictPreviewError('ANCESTOR_UNVERIFIED');
  }
  let first;
  let local;
  let localDigest;
  let pendingStepsDigest;
  try {
    first = (await repo.prepareSync(caseId))[0];
    if (!await matchesPending(first, conflict) || first?.caseId !== caseId) {
      throw new ConflictPreviewError('STALE_CONFLICT_PREVIEW');
    }
    localDigest = await repo.caseDigest(caseId);
    pendingStepsDigest = await syncBodyDigest(JSON.stringify(first!.steps));
    local = await repo.loadCase(caseId);
  } catch {
    throw new ConflictPreviewError('STALE_CONFLICT_PREVIEW');
  }
  if (!local || !localDigest || !pendingStepsDigest) {
    throw new ConflictPreviewError('STALE_CONFLICT_PREVIEW');
  }
  const remotePackage = packageFromConflict(conflict.remote.ciphertextBody,
    repo.session.accountId, caseId, conflict.remote.revisionId);
  let remote;
  try { remote = await repo.inspectRemoteCase(remotePackage, caseId, conflict.remote.revisionId); }
  catch (error) {
    if (error instanceof StorageError && error.code === 'STALE_ACCOUNT_ROOT') {
      throw new ConflictPreviewError('STALE_CONFLICT_PREVIEW');
    }
    throw new ConflictPreviewError('REMOTE_UNVERIFIED');
  }
  let ancestor: ConflictPreview['ancestor'];
  if (conflict.ancestor.status === 'available') {
    let ancestorPackage: unknown;
    try {
      ancestorPackage = packageFromConflict(conflict.ancestor.ciphertextBody,
        repo.session.accountId, caseId, conflict.ancestor.revisionId);
    } catch { throw new ConflictPreviewError('ANCESTOR_UNVERIFIED'); }
    let loaded;
    try {
      loaded = await repo.inspectRemoteCase(ancestorPackage, caseId,
        conflict.ancestor.revisionId);
    } catch (error) {
      if (error instanceof StorageError && error.code === 'STALE_ACCOUNT_ROOT') {
        throw new ConflictPreviewError('STALE_CONFLICT_PREVIEW');
      }
      throw new ConflictPreviewError('ANCESTOR_UNVERIFIED');
    }
    ancestor = { status: 'available', branch: {
      revisionId: loaded.revisionId, case: loaded.case, ledger: loaded.ledger,
      heads: maximalHeads(loaded.case.events),
    } };
  } else ancestor = { status: conflict.ancestor.status };
  let currentPending;
  let currentRevision;
  let currentDigest;
  try {
    currentPending = await repo.prepareSync(caseId);
    currentRevision = await repo.currentRevision(caseId);
    currentDigest = await repo.caseDigest(caseId);
  } catch { throw new ConflictPreviewError('STALE_CONFLICT_PREVIEW'); }
  if (!await matchesPending(currentPending[0], conflict) ||
      currentRevision !== local.revisionId || currentDigest !== localDigest ||
      await syncBodyDigest(JSON.stringify(currentPending[0]!.steps)) !== pendingStepsDigest) {
    throw new ConflictPreviewError('STALE_CONFLICT_PREVIEW');
  }
  return { caseId, pendingOperationId: first!.operationId,
    pendingRevisionId: first!.revisionId,
    pendingManifestDigest: conflict.pendingManifestDigest,
    pendingStepsDigest, localCiphertextDigest: localDigest,
    pendingExpectedServerRevision: conflict.pendingExpectedServerRevision,
    local: { revisionId: local.revisionId, case: local.case,
      ledger: local.ledger, heads: maximalHeads(local.case.events) },
    remote: { revisionId: remote.revisionId, case: remote.case,
      ledger: remote.ledger, heads: maximalHeads(remote.case.events) }, ancestor };
}
