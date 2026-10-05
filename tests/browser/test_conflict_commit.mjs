import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBrowserHarness } from './harness.mjs';

const nativeCli = fileURLToPath(new URL('../../engine/build/scryer-native', import.meta.url));
const engineDir = fileURLToPath(new URL('../../engine', import.meta.url));

test('reviewed join atomically replaces one encrypted pending branch and preserves both histories', async (t) => {
  const { page } = await openBrowserHarness(t);
  const dbName = `scryer-join-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await page.evaluate(async (dbName) => {
    const { createAccountKeys, unlockRecovery } = await import('/crypto/keys.js');
    const { sealCase } = await import('/crypto/envelope.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const { openDatabase, transactionResult } = await import('/storage/idb.js');
    const { previewSyncConflict } = await import('/sync/conflict.js');
    const { digestDisjointApprovalCandidate, prepareReviewedApprovalJoin } =
      await import('/sync/analysis.js');
    const { commitReviewedApprovalJoin } = await import('/sync/resolve.js');
    const { syncBodyDigest } = await import('/sync/transport.js');
    const created = await createAccountKeys('acct-join-commit');
    const validateCase = async (value) => {
      if (value.events.some((event) => event.kind === 'invalid')) throw new Error('INVALID_CASE');
    };
    const repo = await openLocalRepository({ dbName, session: created.session,
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
      validateCase });
    const base = { schemaVersion: '1', caseId: 'case-join-commit', currency: 'USD',
      institutions: [], accountRefs: [{ accountRefId: 'account-bank', kind: 'bank',
        institutionId: null, holderKind: 'student' }], terms: [], aidItems: [],
      artifacts: [], proposals: [] };
    const approved = (eventId, factId, amountMinor, parents) => ({ eventId, parents,
      recordedAt: '2026-10-04T00:00:00Z', kind: 'approve_fact', fact: {
        factId, termId: null, accountRefId: 'account-bank', aidItemId: null,
        currency: 'USD', role: 'bank_credit_observed', recipientKind: null,
        amountMinor, proposalId: null, effectiveDate: '2026-10-03',
        source: { kind: 'manual', entryId: `entry-${factId}` },
        reviewId: `review-${factId}` } });
    const baseEvent = approved('event-base', 'fact-base', '100', []);
    const localCase = { ...base, events: [baseEvent,
      approved('event-local', 'fact-local', '200', ['event-base'])] };
    const remoteCase = { ...base, events: [baseEvent,
      approved('event-remote', 'fact-remote', '300', ['event-base'])] };
    const ledger = { schemaVersion: '1', reviews: [] };
    await repo.commitReviewed({ case: localCase, ledger, revisionId: 'rev-local',
      operationId: 'op-local', expectedLocalRevision: null, serverRevision: 'rev-base' });
    const remoteSession = await unlockRecovery(created.recoveryEnvelope,
      created.recoverySecret, 'acct-join-commit');
    const remotePackage = await sealCase(remoteSession, base.caseId, 'rev-remote',
      JSON.stringify({ schemaVersion: '1', case: remoteCase, ledger }));
    const basePackage = await sealCase(remoteSession, base.caseId, 'rev-base',
      JSON.stringify({ schemaVersion: '1', case: { ...base, events: [baseEvent] }, ledger }));
    const priorPending = (await repo.prepareSync(base.caseId))[0];
    const conflict = { status: 'conflict', pendingOperationId: priorPending.operationId,
      pendingRevisionId: priorPending.revisionId,
      pendingManifestDigest: await syncBodyDigest(priorPending.steps.at(-1).body),
      pendingExpectedServerRevision: priorPending.expectedServerRevision,
      remote: { revisionId: 'rev-remote', etag: '"rev-remote"',
        ciphertextBody: JSON.stringify(remotePackage) },
      ancestor: { status: 'available', revisionId: 'rev-base', etag: '"rev-base"',
        ciphertextBody: JSON.stringify(basePackage) } };
    const preview = await previewSyncConflict(repo, base.caseId, conflict);
    const candidateDigest = await digestDisjointApprovalCandidate(preview);
    const command = { caseId: preview.caseId, pendingOperationId: preview.pendingOperationId,
      pendingRevisionId: preview.pendingRevisionId,
      pendingManifestDigest: preview.pendingManifestDigest,
      pendingStepsDigest: preview.pendingStepsDigest,
      localCiphertextDigest: preview.localCiphertextDigest,
      localRevisionId: preview.local.revisionId, remoteRevisionId: preview.remote.revisionId,
      baseRevisionId: preview.ancestor.branch.revisionId,
      localHead: 'event-local', remoteHead: 'event-remote',
      localOnlyEventIds: ['event-local'], remoteOnlyEventIds: ['event-remote'],
      candidateDigest, eventId: 'event-join', reviewId: 'review-join',
      recordedAt: '2026-10-05T12:00:00Z' };
    const prepared = await prepareReviewedApprovalJoin(preview, command, validateCase);
    const replacement = { case: prepared.case, ledger: prepared.ledger,
      revisionId: 'rev-joined', operationId: 'op-joined',
      expectedLocalRevision: preview.local.revisionId,
      expectedLocalDigest: preview.localCiphertextDigest,
      expectedPendingOperationId: preview.pendingOperationId,
      expectedPendingRevisionId: preview.pendingRevisionId,
      expectedPendingServerRevision: preview.pendingExpectedServerRevision,
      expectedPendingManifestDigest: preview.pendingManifestDigest,
      expectedPendingStepsDigest: preview.pendingStepsDigest,
      serverRevision: preview.remote.revisionId };
    const beforeCase = JSON.stringify(await repo.loadCase(base.caseId));
    const beforePending = JSON.stringify(await repo.prepareSync(base.caseId));
    const codeOf = async (action) => {
      try { await action(); return null; } catch (error) { return error.code; }
    };
    const db = await openDatabase(dbName);
    let savedPending;
    await transactionResult(db, ['outbox'], 'readwrite', (tx, finish) => {
      const store = tx.objectStore('outbox');
      const request = store.get(['acct-join-commit', 'op-local']);
      request.onsuccess = () => {
        savedPending = structuredClone(request.result);
        const changed = structuredClone(savedPending);
        changed.steps[0].body += ' ';
        store.put(changed);
        finish(undefined);
      };
    });
    const changedPendingReview = await codeOf(() => commitReviewedApprovalJoin(
      repo, conflict, command, 'rev-joined', 'op-joined', validateCase));
    await transactionResult(db, ['outbox'], 'readwrite', (tx, finish) => {
      tx.objectStore('outbox').put(savedPending);
      finish(undefined);
    });
    db.close();
    const wrongDigest = await codeOf(() => repo.commitConflictResolution({ ...replacement,
      expectedLocalDigest: '0'.repeat(64) }));
    const wrongRevision = await codeOf(() => repo.commitConflictResolution({ ...replacement,
      expectedLocalRevision: 'rev-wrong', expectedPendingRevisionId: 'rev-wrong' }));
    const wrongPending = await codeOf(() => repo.commitConflictResolution({ ...replacement,
      expectedPendingManifestDigest: '0'.repeat(64) }));
    const wrongSteps = await codeOf(() => repo.commitConflictResolution({ ...replacement,
      expectedPendingStepsDigest: '0'.repeat(64) }));
    const wrongPendingOperation = await codeOf(() => repo.commitConflictResolution({ ...replacement,
      expectedPendingOperationId: 'op-wrong' }));
    const wrongBase = await codeOf(() => repo.commitConflictResolution({ ...replacement,
      expectedPendingServerRevision: 'rev-wrong' }));
    const reusedOperation = await codeOf(() => repo.commitConflictResolution({ ...replacement,
      operationId: 'op-local' }));
    await repo.commitReviewed({ case: { ...base, caseId: 'case-second', events: [] },
      ledger, revisionId: 'rev-second-case', operationId: 'op-duplicate',
      expectedLocalRevision: null, serverRevision: null });
    const duplicateOperation = await codeOf(() => repo.commitConflictResolution({ ...replacement,
      operationId: 'op-duplicate' }));
    const wrongReview = await codeOf(() => commitReviewedApprovalJoin(repo, conflict,
      { ...command, candidateDigest: 'f'.repeat(64) },
      'rev-joined', 'op-joined', validateCase));
    const afterRefusal = JSON.stringify(await repo.loadCase(base.caseId)) === beforeCase &&
      JSON.stringify(await repo.prepareSync(base.caseId)) === beforePending;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'outbox') throw new DOMException('synthetic quota', 'QuotaExceededError');
      return originalPut.apply(this, args);
    };
    let interrupted;
    try { interrupted = await codeOf(() => repo.commitConflictResolution(replacement)); }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const afterInterrupted = JSON.stringify(await repo.loadCase(base.caseId)) === beforeCase &&
      JSON.stringify(await repo.prepareSync(base.caseId)) === beforePending;
    const committed = await commitReviewedApprovalJoin(repo, conflict, command,
      'rev-joined', 'op-joined', validateCase);
    const joined = await repo.loadCase(base.caseId);
    const pending = await repo.prepareSync(base.caseId);
    const oldAck = await codeOf(() => repo.ackSync('op-local', 'rev-local'));
    repo.close();
    return { changedPendingReview, wrongDigest, wrongRevision, wrongPending, wrongSteps,
      wrongPendingOperation, wrongBase, reusedOperation, duplicateOperation,
      wrongReview, afterRefusal, interrupted, afterInterrupted,
      committed, joined, pending, oldAck,
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret };
  }, dbName);
  assert.equal(result.changedPendingReview, 'REVIEW_MISMATCH');
  assert.equal(result.wrongDigest, 'STALE_LOCAL_REVISION');
  assert.equal(result.wrongRevision, 'STALE_LOCAL_REVISION');
  assert.equal(result.wrongPending, 'STALE_CONFLICT');
  assert.equal(result.wrongSteps, 'STALE_CONFLICT');
  assert.equal(result.wrongPendingOperation, 'STALE_CONFLICT');
  assert.equal(result.wrongBase, 'STALE_CONFLICT');
  assert.equal(result.reusedOperation, 'INVALID_CONFLICT_COMMIT');
  assert.equal(result.duplicateOperation, 'OPERATION_CONFLICT');
  assert.equal(result.wrongReview, 'REVIEW_MISMATCH');
  assert.equal(result.afterRefusal, true);
  assert.equal(result.interrupted, 'STORAGE_QUOTA');
  assert.equal(result.afterInterrupted, true);
  assert.equal(result.joined.revisionId, 'rev-joined');
  assert.equal(result.committed.joinEventId, 'event-join');
  assert.deepEqual(result.joined.case.events.map((event) => event.eventId),
    ['event-base', 'event-local', 'event-remote', 'event-join']);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].operationId, 'op-joined');
  assert.equal(result.pending[0].expectedServerRevision, 'rev-remote');
  assert.equal(result.oldAck, 'OUTBOX_MISSING');
  assert.deepEqual(result.joined.case.events.at(-1).parents,
    ['event-local', 'event-remote']);
  assert.equal(JSON.stringify(result.pending).includes('fact-local'), false);
  const built = spawnSync('make', ['-C', engineDir, 'cli'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const validated = spawnSync(nativeCli, [], { input: JSON.stringify({ schemaVersion: '1',
    operation: 'validate', case: result.joined.case }), encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024 });
  assert.equal(validated.status, 0, validated.stderr);
  await page.reload();
  const persisted = await page.evaluate(async ({ dbName, recoveryEnvelope, recoverySecret }) => {
    const { unlockRecovery } = await import('/crypto/keys.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const { openDatabase, transactionResult } = await import('/storage/idb.js');
    const { syncBodyDigest } = await import('/sync/transport.js');
    const session = await unlockRecovery(recoveryEnvelope, recoverySecret, 'acct-join-commit');
    const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
    const loaded = await repo.loadCase('case-join-commit');
    const pending = await repo.prepareSync('case-join-commit');
    const db = await openDatabase(dbName);
    let originalAccount;
    await transactionResult(db, ['accounts'], 'readwrite', (tx, finish) => {
      const store = tx.objectStore('accounts');
      const request = store.get('acct-join-commit');
      request.onsuccess = () => {
        originalAccount = request.result;
        store.put({ ...originalAccount, rootProof: 'synthetic-stale-root' });
        finish(undefined);
      };
    });
    const joinedDigest = await repo.caseDigest('case-join-commit');
    let staleRootCode = null;
    try {
      await repo.commitConflictResolution({ case: loaded.case, ledger: loaded.ledger,
        revisionId: 'rev-root-test', operationId: 'op-root-test',
        expectedLocalRevision: 'rev-joined', expectedLocalDigest: joinedDigest,
        expectedPendingOperationId: pending[0].operationId,
        expectedPendingRevisionId: pending[0].revisionId,
        expectedPendingServerRevision: pending[0].expectedServerRevision,
        expectedPendingManifestDigest: await syncBodyDigest(pending[0].steps.at(-1).body),
        expectedPendingStepsDigest: await syncBodyDigest(JSON.stringify(pending[0].steps)),
        serverRevision: 'rev-remote' });
    } catch (error) { staleRootCode = error.code; }
    await transactionResult(db, ['accounts'], 'readwrite', (tx, finish) => {
      tx.objectStore('accounts').put(originalAccount);
      finish(undefined);
    });
    db.close();
    const unchangedAfterRoot = JSON.stringify(loaded) ===
      JSON.stringify(await repo.loadCase('case-join-commit')) &&
      JSON.stringify(pending) === JSON.stringify(await repo.prepareSync('case-join-commit'));
    await repo.commitReviewed({ case: loaded.case, ledger: loaded.ledger,
      revisionId: 'rev-after', operationId: 'op-after',
      expectedLocalRevision: 'rev-joined', serverRevision: 'rev-remote' });
    const twoPending = await repo.prepareSync('case-join-commit');
    const latest = await repo.loadCase('case-join-commit');
    const currentDigest = await repo.caseDigest('case-join-commit');
    const next = twoPending[1];
    let multiPendingCode = null;
    try {
      await repo.commitConflictResolution({ case: latest.case, ledger: latest.ledger,
        revisionId: 'rev-third', operationId: 'op-third',
        expectedLocalRevision: 'rev-after', expectedLocalDigest: currentDigest,
        expectedPendingOperationId: next.operationId,
        expectedPendingRevisionId: next.revisionId,
        expectedPendingServerRevision: next.expectedServerRevision,
        expectedPendingManifestDigest: await syncBodyDigest(next.steps.at(-1).body),
        expectedPendingStepsDigest: await syncBodyDigest(JSON.stringify(next.steps)),
        serverRevision: 'rev-remote' });
    } catch (error) { multiPendingCode = error.code; }
    const unchangedAfterMulti = JSON.stringify(twoPending) ===
      JSON.stringify(await repo.prepareSync('case-join-commit')) &&
      JSON.stringify(latest) === JSON.stringify(await repo.loadCase('case-join-commit'));
    repo.close();
    return { revisionId: loaded.revisionId, heads: loaded.case.events.at(-1).parents,
      pendingOperationId: pending[0].operationId,
      expectedServerRevision: pending[0].expectedServerRevision,
      retainedEvents: loaded.case.events.map((event) => event.eventId),
      staleRootCode, unchangedAfterRoot, multiPendingCode, unchangedAfterMulti };
  }, { dbName, recoveryEnvelope: result.recoveryEnvelope,
    recoverySecret: result.recoverySecret });
  assert.deepEqual(persisted, { revisionId: 'rev-joined',
    heads: ['event-local', 'event-remote'], pendingOperationId: 'op-joined',
    expectedServerRevision: 'rev-remote', retainedEvents:
      ['event-base', 'event-local', 'event-remote', 'event-join'],
    staleRootCode: 'STALE_ACCOUNT_ROOT', unchangedAfterRoot: true,
    multiPendingCode: 'STALE_CONFLICT', unchangedAfterMulti: true });
});
