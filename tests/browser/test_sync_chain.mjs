import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openBrowserHarness } from './harness.mjs';

test('offline revisions advance the next saved server precondition atomically', async (t) => {
  const { page } = await openBrowserHarness(t);
  const dbName = `scryer-sync-chain-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const initial = await page.evaluate(async (dbName) => {
    const { createAccountKeys } = await import('/crypto/keys.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const created = await createAccountKeys('acct-chain');
    const repo = await openLocalRepository({ dbName, session: created.session,
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
      validateCase: async () => {} });
    const caseData = { schemaVersion: '1', caseId: 'case-chain', currency: 'USD',
      institutions: [], accountRefs: [], terms: [], aidItems: [], artifacts: [],
      proposals: [], events: [] };
    const ledger = { schemaVersion: '1', reviews: [] };
    await repo.commitReviewed({ case: caseData, ledger, revisionId: 'rev-first',
      operationId: 'op-first', expectedLocalRevision: null, serverRevision: null });
    await repo.commitReviewed({ case: caseData, ledger, revisionId: 'rev-second',
      operationId: 'op-second', expectedLocalRevision: 'rev-first', serverRevision: null });
    const before = await repo.prepareSync('case-chain');
    const codeOf = async (action) => {
      try { await action(); return null; } catch (error) { return error.code; }
    };
    const outOfOrder = await codeOf(() => repo.ackSync('op-second', 'rev-second'));
    const wrong = await codeOf(() => repo.ackSync('op-first', 'rev-wrong'));
    const afterWrong = await repo.prepareSync('case-chain');
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'outbox') throw new DOMException('simulated quota', 'QuotaExceededError');
      return originalPut.apply(this, args);
    };
    let interrupted;
    try { interrupted = await codeOf(() => repo.ackSync('op-first', 'rev-first')); }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const afterInterrupted = await repo.prepareSync('case-chain');
    await repo.ackSync('op-first', 'rev-first');
    const after = await repo.prepareSync('case-chain');
    repo.close();
    return { before, outOfOrder, wrong, afterWrong, interrupted, afterInterrupted, after,
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret };
  }, dbName);
  assert.equal(initial.before.length, 2);
  assert.equal(initial.before[0].expectedServerRevision, null);
  assert.equal(initial.before[1].expectedServerRevision, null);
  assert.equal(initial.outOfOrder, 'SYNC_OUT_OF_ORDER');
  assert.equal(initial.wrong, 'SYNC_REVISION_MISMATCH');
  assert.deepEqual(initial.afterWrong, initial.before);
  assert.equal(initial.interrupted, 'STORAGE_QUOTA');
  assert.deepEqual(initial.afterInterrupted, initial.before);
  assert.equal(initial.after.length, 1);
  assert.equal(initial.after[0].operationId, 'op-second');
  assert.equal(initial.after[0].expectedServerRevision, 'rev-first');
  assert.deepEqual(initial.after[0].steps, initial.before[1].steps);

  await page.reload();
  const reopened = await page.evaluate(async ({ dbName, recoveryEnvelope, recoverySecret }) => {
    const { unlockRecovery } = await import('/crypto/keys.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const session = await unlockRecovery(recoveryEnvelope, recoverySecret, 'acct-chain');
    const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
    const pending = await repo.prepareSync('case-chain');
    const current = await repo.loadCase('case-chain');
    await repo.commitReviewed({ case: current.case, ledger: current.ledger,
      revisionId: 'rev-third', operationId: 'op-third',
      expectedLocalRevision: 'rev-second', serverRevision: null });
    const beforeSecondAck = await repo.prepareSync('case-chain');
    await repo.ackSync('op-second', 'rev-second');
    const afterSecondAck = await repo.prepareSync('case-chain');
    await repo.ackSync('op-third', 'rev-third');
    const idle = await repo.prepareSync('case-chain');
    repo.close();
    return { pending, beforeSecondAck, afterSecondAck, idle };
  }, { dbName, recoveryEnvelope: initial.recoveryEnvelope,
    recoverySecret: initial.recoverySecret });
  assert.deepEqual(reopened.pending, initial.after);
  assert.equal(reopened.beforeSecondAck.length, 2);
  assert.equal(reopened.beforeSecondAck[1].expectedServerRevision, null);
  assert.equal(reopened.afterSecondAck.length, 1);
  assert.equal(reopened.afterSecondAck[0].operationId, 'op-third');
  assert.equal(reopened.afterSecondAck[0].expectedServerRevision, 'rev-second');
  assert.deepEqual(reopened.afterSecondAck[0].steps, reopened.beforeSecondAck[1].steps);
  assert.deepEqual(reopened.idle, []);
});
