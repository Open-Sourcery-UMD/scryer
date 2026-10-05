import type { CaseValidator } from '../import/types.ts';
import type { LocalRepository } from '../storage/repository.ts';
import { prepareReviewedApprovalJoin } from './analysis.ts';
import type { ApprovalJoinReviewCommand } from './analysis.ts';
import { previewSyncConflict } from './conflict.ts';
import type { SyncResult } from './transport.ts';

// Reopen the saved conflict before committing. The repository repeats the revision,
// ciphertext digest, and exact pending-byte checks inside its write transaction.
export async function commitReviewedApprovalJoin(repo: LocalRepository,
  conflict: SyncResult, command: ApprovalJoinReviewCommand,
  revisionId: string, operationId: string, validateCase: CaseValidator): Promise<{
    revisionId: string; operationId: string; packageId: string; digest: string;
    joinEventId: string; parentHeads: string[] }> {
  const preview = await previewSyncConflict(repo, command.caseId, conflict);
  const prepared = await prepareReviewedApprovalJoin(preview, command, validateCase);
  const committed = await repo.commitConflictResolution({
    case: prepared.case, ledger: prepared.ledger, revisionId, operationId,
    expectedLocalRevision: preview.local.revisionId,
    expectedLocalDigest: preview.localCiphertextDigest,
    expectedPendingOperationId: preview.pendingOperationId,
    expectedPendingRevisionId: preview.pendingRevisionId,
    expectedPendingServerRevision: preview.pendingExpectedServerRevision!,
    expectedPendingManifestDigest: preview.pendingManifestDigest,
    expectedPendingStepsDigest: preview.pendingStepsDigest,
    serverRevision: preview.remote.revisionId,
  });
  return { revisionId: committed.revisionId, operationId,
    packageId: committed.packageId, digest: committed.digest,
    joinEventId: prepared.joinEventId, parentHeads: prepared.parentHeads };
}
