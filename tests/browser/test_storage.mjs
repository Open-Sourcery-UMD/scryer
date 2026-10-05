import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openBrowserHarness } from './harness.mjs';

test('real browser encrypted repository has atomic revisions, durable outbox, and bounded key use', async (t) => {
  const { page } = await openBrowserHarness(t);
  const databaseName = `scryer-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let recoverySecret;
  let recoveryEnvelope;

  await t.test('new store persists encrypted case and ledger with exact retry bytes', async () => {
    const first = await page.evaluate(async (dbName) => {
      const { createAccountKeys } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const created = await createAccountKeys('acct-storage');
      const validateCase = async (value) => {
        if (value.schemaVersion !== '1' || value.caseId !== 'case-storage') throw new Error('BAD_CASE');
      };
      const repo = await openLocalRepository({ dbName, session: created.session,
        recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret, validateCase });
      const empty = await repo.loadCase('case-storage');
      const caseData = { schemaVersion: '1', caseId: 'case-storage', currency: 'USD',
        institutions: [], accountRefs: [], terms: [], aidItems: [], artifacts: [], proposals: [],
        events: [{ eventId: 'event-one', parents: [], recordedAt: '2026-10-04T00:00:00Z',
          kind: 'manual', fact: { factId: 'fact-one', reviewId: 'review-one', proposalId: null,
            rawValue: 'SENSITIVE_AT_REST_SENTINEL' } }] };
      const ledger = { schemaVersion: '1', reviews: [] };
      const result = await repo.commitReviewed({ case: caseData, ledger, revisionId: 'rev-one',
        operationId: 'op-one', expectedLocalRevision: null, serverRevision: null });
      const loaded = await repo.loadCase('case-storage');
      const outbox = await repo.prepareSync('case-storage');
      const raw = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['accounts', 'cases', 'outbox', 'budgets', 'anchors'], 'readonly');
          const records = {};
          for (const name of ['accounts', 'cases', 'outbox', 'budgets', 'anchors']) {
            const get = tx.objectStore(name).getAll();
            get.onsuccess = () => { records[name] = get.result; };
          }
          tx.oncomplete = () => { db.close(); resolve(JSON.stringify(records)); };
          tx.onerror = () => reject(tx.error);
        };
      });
      repo.close();
      return { empty, result, loaded, outbox, raw, recoveryEnvelope: created.recoveryEnvelope,
        recoverySecret: created.recoverySecret, deviceId: created.session.deviceId };
    }, databaseName);
    assert.equal(first.empty, null);
    assert.equal(first.result.revisionId, 'rev-one');
    assert.equal(first.loaded.case.events[0].fact.rawValue, 'SENSITIVE_AT_REST_SENTINEL');
    assert.deepEqual(first.loaded.ledger, { schemaVersion: '1', reviews: [] });
    assert.equal(first.outbox.length, 1);
    assert.equal(first.outbox[0].operationId, 'op-one');
    assert.equal(first.outbox[0].steps.length, 2);
    assert.ok(!first.raw.includes('SENSITIVE_AT_REST_SENTINEL'));
    assert.ok(!first.raw.includes(first.recoverySecret));
    assert.ok(!first.outbox[0].steps.some((step) => step.body.includes('SENSITIVE_AT_REST_SENTINEL')));
    recoverySecret = first.recoverySecret;
    recoveryEnvelope = first.recoveryEnvelope;

    await page.reload();
    const afterReload = await page.evaluate(async ({ dbName, recoveryEnvelope, recoverySecret }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const session = await unlockRecovery(recoveryEnvelope, recoverySecret, 'acct-storage');
      const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
      const loaded = await repo.loadCase('case-storage');
      const retryA = await repo.prepareSync('case-storage');
      const retryB = await repo.prepareSync('case-storage');
      repo.close();
      return { loaded, retryA, retryB };
    }, { dbName: databaseName, recoveryEnvelope: first.recoveryEnvelope, recoverySecret: first.recoverySecret });
    assert.equal(afterReload.loaded.case.events[0].fact.rawValue, 'SENSITIVE_AT_REST_SENTINEL');
    assert.deepEqual(afterReload.retryA, first.outbox);
    assert.deepEqual(afterReload.retryB, first.outbox);
  });

  await t.test('two tabs racing the same revision leave exactly one case/outbox pair', async () => {
    const pageB = await page.context().newPage();
    await pageB.goto(page.url());
    // The recovery secret is deliberately carried by the test harness, never read from IndexedDB.
    const result = await Promise.all([page, pageB].map((tab, index) => tab.evaluate(async ({ dbName, wrapper, recoverySecret, index }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const session = await unlockRecovery(wrapper, recoverySecret, 'acct-storage');
      const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
      const old = await repo.loadCase('case-storage');
      old.case.events[0].fact.rawValue = `winner-${index}`;
      try {
        const commit = await repo.commitReviewed({ ...old, revisionId: `rev-race-${index}`,
          operationId: `op-race-${index}`, expectedLocalRevision: 'rev-one', serverRevision: null });
        repo.close();
        return { ok: true, revisionId: commit.revisionId };
      } catch (error) {
        repo.close();
        return { ok: false, code: error.code };
      }
    }, { dbName: databaseName, wrapper: recoveryEnvelope, recoverySecret, index })));
    assert.equal(result.filter((value) => value.ok).length, 1);
    assert.equal(result.filter((value) => value.code === 'STALE_LOCAL_REVISION').length, 1);
    const after = await page.evaluate(async ({ dbName, wrapper, recoverySecret }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const session = await unlockRecovery(wrapper, recoverySecret, 'acct-storage');
      const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
      const loaded = await repo.loadCase('case-storage');
      const outbox = await repo.prepareSync('case-storage');
      repo.close();
      return { revisionId: loaded.revisionId, outbox: outbox.map((entry) => entry.operationId) };
    }, { dbName: databaseName, wrapper: recoveryEnvelope, recoverySecret });
    assert.equal(after.revisionId, result.find((value) => value.ok).revisionId);
    assert.equal(after.outbox.length, 2);
    assert.ok(after.outbox.includes('op-one'));
  });

  await t.test('aborted transaction and simulated quota denial preserve prior case and outbox', async () => {
    const result = await page.evaluate(async ({ dbName, wrapper, recoverySecret }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const session = await unlockRecovery(wrapper, recoverySecret, 'acct-storage');
      const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
      const prior = await repo.loadCase('case-storage');
      const before = await repo.prepareSync('case-storage');
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'outbox') throw new DOMException('simulated quota', 'QuotaExceededError');
        return originalPut.apply(this, args);
      };
      let code = null;
      try {
        prior.case.events[0].fact.rawValue = 'ABORTED_SENTINEL';
        await repo.commitReviewed({ case: prior.case, ledger: prior.ledger,
          revisionId: 'rev-aborted', operationId: 'op-aborted',
          expectedLocalRevision: prior.revisionId, serverRevision: null });
      } catch (error) { code = error.code; }
      finally { IDBObjectStore.prototype.put = originalPut; }
      repo.close();
      return { code, revisionId: prior.revisionId, outbox: before };
    }, { dbName: databaseName, wrapper: recoveryEnvelope, recoverySecret });
    assert.equal(result.code, 'STORAGE_QUOTA');
    await page.reload();
    const after = await page.evaluate(async ({ dbName, wrapper, recoverySecret }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const session = await unlockRecovery(wrapper, recoverySecret, 'acct-storage');
      const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
      const loaded = await repo.loadCase('case-storage');
      const outbox = await repo.prepareSync('case-storage');
      repo.close();
      return { revisionId: loaded.revisionId, rawValue: loaded.case.events[0].fact.rawValue, outbox };
    }, { dbName: databaseName, wrapper: recoveryEnvelope, recoverySecret });
    assert.equal(after.revisionId, result.revisionId);
    assert.notEqual(after.rawValue, 'ABORTED_SENTINEL');
    assert.deepEqual(after.outbox, result.outbox);
  });

  await t.test('locked, wrong-key, unavailable storage, and exhausted budgets fail typed', async () => {
    const result = await page.evaluate(async ({ dbName, wrapper, recoverySecret }) => {
      const { createAccountKeys, unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const codeOf = async (action) => { try { await action(); return null; } catch (error) { return error.code; } };
      const wrong = await createAccountKeys('acct-storage');
      const wrongKey = await codeOf(() => openLocalRepository({ dbName, session: wrong.session,
        validateCase: async () => {} }));
      const session = await unlockRecovery(wrapper, recoverySecret, 'acct-storage');
      const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
      const used = await repo.reserveEncryptions('case-budget', 1, 1_048_576);
      const exhausted = await codeOf(() => repo.reserveEncryptions('case-budget', 1, 1));
      const emptyCase = { schemaVersion: '1', caseId: 'case-budget', currency: 'USD',
        institutions: [], accountRefs: [], terms: [], aidItems: [], artifacts: [], proposals: [], events: [] };
      const refusedCommit = await codeOf(() => repo.commitReviewed({ case: emptyCase,
        ledger: { schemaVersion: '1', reviews: [] }, revisionId: 'rev-budget',
        operationId: 'op-budget', expectedLocalRevision: null, serverRevision: null }));
      repo.lock();
      const locked = await codeOf(() => repo.loadCase('case-storage'));
      const property = Object.getOwnPropertyDescriptor(window, 'indexedDB');
      Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
      const availableSession = await unlockRecovery(wrapper, recoverySecret, 'acct-storage');
      const unavailable = await codeOf(() => openLocalRepository({ dbName,
        session: availableSession, validateCase: async () => {} }));
      Object.defineProperty(window, 'indexedDB', { value: {
        open() { throw new DOMException('blocked', 'SecurityError'); },
      }, configurable: true });
      const denied = await codeOf(() => openLocalRepository({ dbName,
        session: availableSession, validateCase: async () => {} }));
      if (property) Object.defineProperty(window, 'indexedDB', property);
      else delete window.indexedDB;
      const acknowledged = await openLocalRepository({ dbName, session: availableSession,
        validateCase: async () => {} });
      const pendingBefore = await acknowledged.prepareSync('case-storage');
      await acknowledged.ackSync('op-one', 'rev-one');
      const pendingAfter = await acknowledged.prepareSync('case-storage');
      const missingAck = await codeOf(() => acknowledged.ackSync('op-one', 'rev-one'));
      const stillLoaded = await acknowledged.loadCase('case-storage');
      acknowledged.close();
      return { wrongKey, used, exhausted, refusedCommit, locked, unavailable, denied,
        pendingBefore: pendingBefore.length, pendingAfter: pendingAfter.length,
        missingAck, stillLoaded: stillLoaded !== null };
    }, { dbName: databaseName, wrapper: recoveryEnvelope, recoverySecret });
    assert.deepEqual(result, { wrongKey: 'WRONG_KEY', used: 1_048_576,
      exhausted: 'KEY_USE_LIMIT', refusedCommit: 'KEY_USE_LIMIT',
      locked: 'KEY_LOCKED', unavailable: 'STORAGE_UNAVAILABLE', denied: 'STORAGE_DENIED',
      pendingBefore: 2, pendingAfter: 1, missingAck: 'OUTBOX_MISSING', stillLoaded: true });
  });

  await t.test('mandatory semantic validator rejects an invalid revision before local write', async () => {
    const result = await page.evaluate(async ({ dbName, wrapper, recoverySecret }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const session = await unlockRecovery(wrapper, recoverySecret, 'acct-storage');
      const codeOf = async (action) => { try { await action(); return null; } catch (error) { return error.code; } };
      const absentValidator = await codeOf(() => openLocalRepository({ dbName, session }));
      const repo = await openLocalRepository({ dbName, session, validateCase: async (value) => {
        if (value.events[0]?.fact?.rawValue === 'REJECTED_SENTINEL') throw new Error('semantic failure');
      } });
      const before = await repo.loadCase('case-storage');
      const outboxBefore = await repo.prepareSync('case-storage');
      before.case.events[0].fact.rawValue = 'REJECTED_SENTINEL';
      const rejection = await codeOf(() => repo.commitReviewed({ case: before.case, ledger: before.ledger,
        revisionId: 'rev-invalid', operationId: 'op-invalid',
        expectedLocalRevision: before.revisionId, serverRevision: null }));
      const after = await repo.loadCase('case-storage');
      const outboxAfter = await repo.prepareSync('case-storage');
      repo.close();
      return { absentValidator, rejection, revisionSame: before.revisionId === after.revisionId,
        outboxSame: JSON.stringify(outboxBefore) === JSON.stringify(outboxAfter) };
    }, { dbName: databaseName, wrapper: recoveryEnvelope, recoverySecret });
    assert.deepEqual(result, { absentValidator: 'VALIDATOR_REQUIRED',
      rejection: 'INVALID_REVIEWED_CASE', revisionSame: true, outboxSame: true });
  });

  await t.test('tampering with stored ciphertext never reveals a partial case', async () => {
    const result = await page.evaluate(async ({ dbName, wrapper, recoverySecret }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const session = await unlockRecovery(wrapper, recoverySecret, 'acct-storage');
      const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('cases', 'readwrite');
        const store = tx.objectStore('cases');
        const request = store.get(['acct-storage', 'case-storage']);
        request.onsuccess = () => {
          const record = request.result;
          record.package.chunks[0].tag = 'AAAAAAAAAAAAAAAAAAAAAA';
          store.put(record);
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      let code = null;
      try { await repo.loadCase('case-storage'); } catch (error) { code = error.code; }
      repo.close();
      return { code };
    }, { dbName: databaseName, wrapper: recoveryEnvelope, recoverySecret });
    assert.deepEqual(result, { code: 'CORRUPT_RECORD' });
  });
});
