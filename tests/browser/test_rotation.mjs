import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openBrowserHarness } from './harness.mjs';

test('real browser key and recovery rotations survive interruption without losing approved history', async (t) => {
  const { page } = await openBrowserHarness(t);
  const dbName = `scryer-rotation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let oldSecret;
  let oldWrapper;
  let oldArchive;

  await t.test('key-use exhaustion leads to a journaled generation transition', async () => {
    const result = await page.evaluate(async (name) => {
      const { createAccountKeys, unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const { exportEncrypted, previewRestore } = await import('/export/archive.js');
      const { prepareGenerationRotation, commitGenerationRotation } = await import('/crypto/rotation.js');
      const created = await createAccountKeys('acct-rotate');
      const repo = await openLocalRepository({ dbName: name, session: created.session,
        recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
        validateCase: async () => {} });
      const caseData = { schemaVersion: '1', caseId: 'case-rotate', currency: 'USD',
        institutions: [], accountRefs: [], terms: [], aidItems: [], artifacts: [], proposals: [],
        events: [{ eventId: 'event-rotate', parents: [], recordedAt: '2026-10-04T00:00:00Z',
          kind: 'manual', fact: { factId: 'fact-rotate', reviewId: 'review-rotate',
            proposalId: null, rawValue: 'ROTATION_CASE_SENTINEL' } }] };
      await repo.commitReviewed({ case: caseData, ledger: { schemaVersion: '1', reviews: [] },
        revisionId: 'rev-before-rotation', operationId: 'op-before-rotation',
        expectedLocalRevision: null, serverRevision: null });
      const archive = await exportEncrypted(repo, { recoverySecret: created.recoverySecret });
      await repo.reserveEncryptions('case-rotate', 1, 1_048_575);
      let exhausted = null;
      try { await repo.commitReviewed({ case: caseData, ledger: { schemaVersion: '1', reviews: [] },
        revisionId: 'rev-refused', operationId: 'op-refused',
        expectedLocalRevision: 'rev-before-rotation', serverRevision: null }); }
      catch (error) { exhausted = error.code; }
      const prepared = await prepareGenerationRotation(repo, 'generation-one');
      const before = await repo.loadCase('case-rotate');
      repo.close();
      const reopenedSession = await unlockRecovery(created.recoveryEnvelope,
        created.recoverySecret, 'acct-rotate');
      const reopened = await openLocalRepository({ dbName: name, session: reopenedSession,
        validateCase: async () => {} });
      const committed = await commitGenerationRotation(reopened, 'generation-one');
      const repeated = await commitGenerationRotation(reopened, 'generation-one');
      const after = await reopened.loadCase('case-rotate');
      const previewOld = await previewRestore(reopened, archive, created.recoverySecret);
      let staleGeneration = null;
      try { await reopened.commitReviewed({ case: after.case, ledger: after.ledger,
        revisionId: 'rev-stale-generation', operationId: 'op-stale-generation',
        expectedLocalRevision: after.revisionId, serverRevision: null, keyGeneration: 1 }); }
      catch (error) { staleGeneration = error.code; }
      const nextCommit = await reopened.commitReviewed({ case: after.case, ledger: after.ledger,
        revisionId: 'rev-after-rotation', operationId: 'op-after-rotation',
        expectedLocalRevision: after.revisionId, serverRevision: null });
      const latest = await reopened.loadCase('case-rotate');
      await reopened.commitReviewed({ case: { schemaVersion: '1', caseId: 'case-rotate-two',
        currency: 'USD', institutions: [], accountRefs: [], terms: [], aidItems: [],
        artifacts: [], proposals: [], events: [] },
      ledger: { schemaVersion: '1', reviews: [] }, revisionId: 'rev-second-case',
      operationId: 'op-second-case', expectedLocalRevision: null, serverRevision: null });
      reopened.close();
      return { oldSecret: created.recoverySecret, oldWrapper: created.recoveryEnvelope,
        oldArchive: Array.from(archive), exhausted, prepared, committed, repeated,
        before: before.revisionId, after: after.revisionId,
        generation: after.keyGeneration, previewOld: previewOld.cases[0].archivedRevision,
        staleGeneration, nextCommit, latest: latest.revisionId,
        latestGeneration: latest.keyGeneration };
    }, dbName);
    oldSecret = result.oldSecret;
    oldWrapper = result.oldWrapper;
    oldArchive = result.oldArchive;
    assert.equal(result.exhausted, 'KEY_USE_LIMIT');
    assert.equal(result.before, 'rev-before-rotation');
    assert.equal(result.generation, 2);
    assert.deepEqual(result.repeated, result.committed);
    assert.equal(result.staleGeneration, 'STALE_KEY_GENERATION');
    assert.notEqual(result.after, result.before);
    assert.equal(result.previewOld, 'rev-before-rotation');
    assert.equal(result.latest, 'rev-after-rotation');
    assert.equal(result.latestGeneration, 2);
  });

  await t.test('new-root recovery rotation rejects wrong secret and a failed commit, then succeeds', async () => {
    const result = await page.evaluate(async ({ dbName, oldSecret, oldWrapper, oldArchive }) => {
      const { unlockRecovery, verifyRecoverySecret } = await import('/crypto/keys.js');
      const { openCase } = await import('/crypto/envelope.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const { prepareRecoveryRotation, commitRecoveryRotation,
        prepareGenerationRotation, abortRotation } = await import('/crypto/rotation.js');
      const oldSession = await unlockRecovery(oldWrapper, oldSecret, 'acct-rotate');
      const repo = await openLocalRepository({ dbName, session: oldSession,
        validateCase: async () => {} });
      const before = await repo.loadCase('case-rotate');
      const beforeSecond = await repo.loadCase('case-rotate-two');
      const prepared = await prepareRecoveryRotation(repo, 'recovery-one');
      const journalText = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('migrations', 'readonly');
          const get = tx.objectStore('migrations').get('rotation:recovery-one');
          get.onsuccess = () => { db.close(); resolve(JSON.stringify(get.result)); };
          get.onerror = () => reject(get.error);
        };
        request.onerror = () => reject(request.error);
      });
      repo.close();
      const resumedSession = await unlockRecovery(oldWrapper, oldSecret, 'acct-rotate');
      const active = await openLocalRepository({ dbName, session: resumedSession,
        validateCase: async () => {} });
      let wrong = null;
      try { await commitRecoveryRotation(active, 'recovery-one',
        'scryer-recovery-v1:' + 'A'.repeat(43)); }
      catch (error) { wrong = error.code; }
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'cases') throw new DOMException('simulated quota', 'QuotaExceededError');
        return originalPut.apply(this, args);
      };
      let interrupted = null;
      try { await commitRecoveryRotation(active, 'recovery-one', prepared.recoverySecret); }
      catch (error) { interrupted = error.code; }
      finally { IDBObjectStore.prototype.put = originalPut; }
      const afterAbort = await active.loadCase('case-rotate');
      const secondAfterAbort = await active.loadCase('case-rotate-two');
      const committed = await commitRecoveryRotation(active, 'recovery-one', prepared.recoverySecret);
      const verifiedNew = await verifyRecoverySecret(committed.session,
        committed.recoveryEnvelope, prepared.recoverySecret);
      const oldSecretRejected = await verifyRecoverySecret(committed.session,
        committed.recoveryEnvelope, oldSecret);
      const newRepo = await openLocalRepository({ dbName, session: committed.session,
        validateCase: async () => {} });
      const after = await newRepo.loadCase('case-rotate');
      const secondAfter = await newRepo.loadCase('case-rotate-two');
      const beforeAbort = after.revisionId;
      await prepareGenerationRotation(newRepo, 'discard-one');
      await abortRotation(newRepo, 'discard-one');
      const afterAbortRotation = await newRepo.loadCase('case-rotate');
      newRepo.close();
      const newDevice = await unlockRecovery(committed.recoveryEnvelope,
        prepared.recoverySecret, 'acct-rotate');
      const newDeviceRepo = await openLocalRepository({ dbName, session: newDevice,
        validateCase: async () => {} });
      const newDeviceCase = await newDeviceRepo.loadCase('case-rotate');
      const newDeviceSecond = await newDeviceRepo.loadCase('case-rotate-two');
      const differentDevice = newDevice.deviceId !== committed.session.deviceId;
      newDeviceRepo.close();
      const oldAgain = await unlockRecovery(oldWrapper, oldSecret, 'acct-rotate');
      let oldKeyCode = null;
      try { await openLocalRepository({ dbName, session: oldAgain,
        validateCase: async () => {} }); }
      catch (error) { oldKeyCode = error.code; }
      const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(oldArchive)));
      const oldBackupCase = await openCase(oldAgain, parsed.cases[0].package,
        'case-rotate', 'rev-before-rotation');
      oldAgain.lock();
      return { wrong, interrupted, afterAbort: afterAbort.revisionId,
        secondAfterAbort: secondAfterAbort.revisionId,
        before: before.revisionId, after: after.revisionId,
        beforeSecond: beforeSecond.revisionId, afterSecond: secondAfter.revisionId,
        afterGeneration: after.keyGeneration, oldKeyCode,
        oldBackupStillOpens: oldBackupCase.includes('ROTATION_CASE_SENTINEL'),
        newSecret: prepared.recoverySecret, newWrapper: committed.recoveryEnvelope,
        verifiedNew, oldSecretRejected, differentDevice,
        newDeviceRevision: newDeviceCase.revisionId,
        newDeviceSecondRevision: newDeviceSecond.revisionId,
        abortedGenerationUnchanged: afterAbortRotation.revisionId === beforeAbort,
        journalContainsPlaintext: journalText.includes('ROTATION_CASE_SENTINEL') ||
          journalText.includes(prepared.recoverySecret) };
    }, { dbName, oldSecret, oldWrapper, oldArchive });
    assert.equal(result.wrong, 'WRONG_KEY');
    assert.equal(result.interrupted, 'STORAGE_QUOTA');
    assert.equal(result.afterAbort, result.before);
    assert.equal(result.secondAfterAbort, result.beforeSecond);
    assert.notEqual(result.after, result.before);
    assert.notEqual(result.afterSecond, result.beforeSecond);
    assert.equal(result.afterGeneration, 1);
    assert.equal(result.oldKeyCode, 'WRONG_KEY');
    assert.equal(result.oldBackupStillOpens, true);
    assert.notEqual(result.newSecret, oldSecret);
    assert.equal(result.verifiedNew, true);
    assert.equal(result.oldSecretRejected, false);
    assert.equal(result.differentDevice, true);
    assert.equal(result.newDeviceRevision, result.after);
    assert.equal(result.newDeviceSecondRevision, result.afterSecond);
    assert.equal(result.abortedGenerationUnchanged, true);
    assert.equal(result.journalContainsPlaintext, false);
  });
});
