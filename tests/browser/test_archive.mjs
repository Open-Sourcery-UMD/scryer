import assert from 'node:assert/strict';
import { createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
import { test } from 'node:test';

import { openBrowserHarness } from './harness.mjs';

function independentArchiveTag(bytes, recoverySecret) {
  const archive = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const wrapper = archive.recoveryEnvelope;
  const secret = Buffer.from(recoverySecret.slice('scryer-recovery-v1:'.length), 'base64url');
  const wrapInfo = JSON.stringify({ schemaVersion: '1', purpose: 'recovery-wrap-v1',
    accountId: archive.accountId });
  const wrapKey = Buffer.from(hkdfSync('sha256', secret, Buffer.from(wrapper.salt, 'base64url'),
    Buffer.from(wrapInfo), 32));
  const wrapAad = JSON.stringify({ schemaVersion: wrapper.schemaVersion,
    format: wrapper.format, algorithm: wrapper.algorithm, accountId: wrapper.accountId,
    salt: wrapper.salt, nonce: wrapper.nonce });
  const decipher = createDecipheriv('aes-256-gcm', wrapKey,
    Buffer.from(wrapper.nonce, 'base64url'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(wrapAad));
  decipher.setAuthTag(Buffer.from(wrapper.tag, 'base64url'));
  const root = Buffer.concat([decipher.update(Buffer.from(wrapper.ciphertext, 'base64url')),
    decipher.final()]);
  const authInfo = JSON.stringify({ schemaVersion: '1', purpose: 'archive-auth-v1',
    accountId: archive.accountId });
  const authKey = Buffer.from(hkdfSync('sha256', root,
    Buffer.from('scryer:archive-auth:v1'), Buffer.from(authInfo), 32));
  const { authTag, ...content } = archive;
  const actual = createHmac('sha256', authKey).update(JSON.stringify(content)).digest('base64url');
  root.fill(0); secret.fill(0); wrapKey.fill(0); authKey.fill(0);
  return { expected: authTag, actual };
}

test('real browser portable encrypted archive previews and restores atomically', async (t) => {
  const { page, browser } = await openBrowserHarness(t);
  const dbName = `scryer-archive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let archiveBytes;
  let originalArchiveBytes;
  let recoverySecret;
  let recoveryEnvelope;

  await t.test('default export omits originals and optional encrypted originals verify', async () => {
    const result = await page.evaluate(async (name) => {
      const { createAccountKeys } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const { exportEncrypted, previewRestore } = await import('/export/archive.js');
      const original = new TextEncoder().encode('SENSITIVE_ORIGINAL_BYTES');
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', original));
      const sha256 = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
      const created = await createAccountKeys('acct-archive');
      const repo = await openLocalRepository({ dbName: name, session: created.session,
        recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
        validateCase: async () => {} });
      const caseData = { schemaVersion: '1', caseId: 'case-archive', currency: 'USD',
        institutions: [], accountRefs: [], terms: [], aidItems: [], proposals: [],
        artifacts: [{ artifactId: 'artifact-archive', sha256, accountRefId: null, kind: 'bank_transactions' }],
        events: [{ eventId: 'event-archive', parents: [], recordedAt: '2026-10-04T00:00:00Z',
          kind: 'manual', fact: { factId: 'fact-archive', reviewId: 'review-archive',
            proposalId: null, rawValue: 'SENSITIVE_ARCHIVE_CASE' } }] };
      await repo.commitReviewed({ case: caseData, ledger: { schemaVersion: '1', reviews: [] },
        revisionId: 'rev-archive-one', operationId: 'op-archive-one',
        expectedLocalRevision: null, serverRevision: null });
      const archive = await exportEncrypted(repo, { recoverySecret: created.recoverySecret });
      const parsed = JSON.parse(new TextDecoder().decode(archive));
      const before = await repo.loadCase('case-archive');
      const preview = await previewRestore(repo, archive, created.recoverySecret);
      const after = await repo.loadCase('case-archive');
      const withOriginal = await exportEncrypted(repo, { recoverySecret: created.recoverySecret,
        originals: [{ artifactId: 'artifact-archive', bytes: original }] });
      const originalPreview = await previewRestore(repo, withOriginal, created.recoverySecret);
      const encoded = new TextDecoder().decode(withOriginal);
      repo.close();
      return { bytes: Array.from(archive), originalBytes: Array.from(withOriginal),
        recoverySecret: created.recoverySecret,
        recoveryEnvelope: created.recoveryEnvelope, preview, originalPreview,
        defaultOriginalCount: parsed.originals.length,
        unchanged: JSON.stringify(before) === JSON.stringify(after),
        noPlaintext: !encoded.includes('SENSITIVE_ORIGINAL_BYTES') &&
          !encoded.includes('SENSITIVE_ARCHIVE_CASE') };
    }, dbName);
    archiveBytes = result.bytes;
    originalArchiveBytes = result.originalBytes;
    recoverySecret = result.recoverySecret;
    recoveryEnvelope = result.recoveryEnvelope;
    assert.equal(result.defaultOriginalCount, 0);
    assert.equal(result.preview.cases.length, 1);
    assert.equal(result.originalPreview.originals.length, 1);
    assert.equal(result.unchanged, true);
    assert.equal(result.noPlaintext, true);
    const independent = independentArchiveTag(archiveBytes, recoverySecret);
    assert.equal(independent.actual, independent.expected);
  });

  await t.test('wrong secret, duplicate keys, and ciphertext tamper do not change the store', async () => {
    const result = await page.evaluate(async ({ dbName, wrapper, secret, bytes, originalBytes }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const { previewRestore } = await import('/export/archive.js');
      const session = await unlockRecovery(wrapper, secret, 'acct-archive');
      const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
      const archive = Uint8Array.from(bytes);
      const codeOf = async (action) => { try { await action(); return null; } catch (error) { return error.code; } };
      const wrong = await codeOf(() => previewRestore(repo, archive,
        'scryer-recovery-v1:' + 'A'.repeat(43)));
      const text = new TextDecoder().decode(archive);
      const duplicate = new TextEncoder().encode(text.replace('"schemaVersion":"1",',
        '"schemaVersion":"1","schemaVersion":"1",'));
      const duplicateCode = await codeOf(() => previewRestore(repo, duplicate, secret));
      const parsed = JSON.parse(text);
      parsed.cases[0].package.chunks[0].tag = 'AAAAAAAAAAAAAAAAAAAAAA';
      const tampered = new TextEncoder().encode(JSON.stringify(parsed));
      const tamperedCode = await codeOf(() => previewRestore(repo, tampered, secret));
      const changedHeader = JSON.parse(text);
      changedHeader.accountId = 'acct-other';
      const headerCode = await codeOf(() => previewRestore(repo,
        new TextEncoder().encode(JSON.stringify(changedHeader)), secret));
      const changedOriginal = JSON.parse(new TextDecoder().decode(Uint8Array.from(originalBytes)));
      changedOriginal.originals[0].package.chunks[0].tag = 'AAAAAAAAAAAAAAAAAAAAAA';
      const originalCode = await codeOf(() => previewRestore(repo,
        new TextEncoder().encode(JSON.stringify(changedOriginal)), secret));
      const loaded = await repo.loadCase('case-archive');
      repo.close();
      return { wrong, duplicateCode, tamperedCode, headerCode, originalCode,
        revisionId: loaded.revisionId };
    }, { dbName, wrapper: recoveryEnvelope, secret: recoverySecret,
      bytes: archiveBytes, originalBytes: originalArchiveBytes });
    assert.equal(result.wrong, 'WRONG_KEY');
    assert.equal(result.duplicateCode, 'INVALID_ARCHIVE');
    assert.equal(result.tamperedCode, 'CORRUPT_ARCHIVE');
    assert.equal(result.headerCode, 'INVALID_ARCHIVE');
    assert.equal(result.originalCode, 'CORRUPT_ARCHIVE');
    assert.equal(result.revisionId, 'rev-archive-one');
  });

  await t.test('fresh device restores an archive using only the recovery secret', async () => {
    const context = await browser.newContext();
    const fresh = await context.newPage();
    await fresh.goto(page.url());
    const result = await fresh.evaluate(async ({ bytes, secret }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const { previewRestore, restoreEncrypted } = await import('/export/archive.js');
      const archive = Uint8Array.from(bytes);
      const parsed = JSON.parse(new TextDecoder().decode(archive));
      const session = await unlockRecovery(parsed.recoveryEnvelope, secret, parsed.accountId);
      const repo = await openLocalRepository({ dbName: `fresh-${parsed.exportId}`, session,
        recoveryEnvelope: parsed.recoveryEnvelope, recoverySecret: secret,
        validateCase: async () => {} });
      const preview = await previewRestore(repo, archive, secret);
      const committed = await restoreEncrypted(repo, archive, secret,
        { 'case-archive': null });
      const loaded = await repo.loadCase('case-archive');
      const pending = await repo.prepareSync('case-archive');
      repo.close();
      return { preview, committed, loaded, pendingCount: pending.length };
    }, { bytes: archiveBytes, secret: recoverySecret });
    assert.equal(result.preview.cases[0].currentRevision, null);
    assert.equal(result.loaded.case.events[0].fact.rawValue, 'SENSITIVE_ARCHIVE_CASE');
    assert.equal(result.loaded.revisionId, 'rev-archive-one');
    assert.equal(result.pendingCount, 1);
    assert.equal(result.committed.restored, 1);
  });

  await t.test('encrypted originals can be extracted only after recovery verification', async () => {
    const result = await page.evaluate(async ({ dbName, wrapper, secret, bytes }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const { extractArchiveOriginals } = await import('/export/archive.js');
      const session = await unlockRecovery(wrapper, secret, 'acct-archive');
      const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
      const originals = await extractArchiveOriginals(repo, Uint8Array.from(bytes), secret);
      repo.close();
      return originals.map((item) => ({ artifactId: item.artifactId,
        value: new TextDecoder().decode(item.bytes) }));
    }, { dbName, wrapper: recoveryEnvelope, secret: recoverySecret, bytes: originalArchiveBytes });
    assert.deepEqual(result, [{ artifactId: 'artifact-archive', value: 'SENSITIVE_ORIGINAL_BYTES' }]);
  });

  await t.test('conflict, interrupted restore, and explicit replacement are atomic', async () => {
    const result = await page.evaluate(async ({ dbName, wrapper, secret, bytes }) => {
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const { previewRestore, restoreEncrypted } = await import('/export/archive.js');
      const session = await unlockRecovery(wrapper, secret, 'acct-archive');
      const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
      const current = await repo.loadCase('case-archive');
      current.case.events[0].fact.rawValue = 'NEWER_LOCAL_REVISION';
      await repo.commitReviewed({ case: current.case, ledger: current.ledger,
        revisionId: 'rev-archive-two', operationId: 'op-archive-two',
        expectedLocalRevision: 'rev-archive-one', serverRevision: null });
      const archive = Uint8Array.from(bytes);
      const preview = await previewRestore(repo, archive, secret);
      const codeOf = async (action) => { try { await action(); return null; } catch (error) { return error.code; } };
      const stale = await codeOf(() => restoreEncrypted(repo, archive, secret,
        { 'case-archive': null }));
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'anchors') throw new DOMException('simulated quota', 'QuotaExceededError');
        return originalPut.apply(this, args);
      };
      let interrupted;
      try { interrupted = await codeOf(() => restoreEncrypted(repo, archive, secret,
        { 'case-archive': 'rev-archive-two' })); }
      finally { IDBObjectStore.prototype.put = originalPut; }
      const afterAbort = await repo.loadCase('case-archive');
      const pendingAfterAbort = await repo.prepareSync('case-archive');
      const restored = await restoreEncrypted(repo, archive, secret,
        { 'case-archive': 'rev-archive-two' });
      const afterRestore = await repo.loadCase('case-archive');
      const pendingAfterRestore = await repo.prepareSync('case-archive');
      repo.close();
      return { preview, stale, interrupted, afterAbort: afterAbort.revisionId,
        pendingAfterAbort: pendingAfterAbort.length, restored,
        afterRestore: afterRestore.revisionId,
        rawValue: afterRestore.case.events[0].fact.rawValue,
        pendingAfterRestore: pendingAfterRestore.length };
    }, { dbName, wrapper: recoveryEnvelope, secret: recoverySecret, bytes: archiveBytes });
    assert.equal(result.preview.cases[0].currentRevision, 'rev-archive-two');
    assert.equal(result.stale, 'STALE_LOCAL_REVISION');
    assert.equal(result.interrupted, 'STORAGE_QUOTA');
    assert.equal(result.afterAbort, 'rev-archive-two');
    assert.equal(result.pendingAfterAbort, 2);
    assert.equal(result.restored.restored, 1);
    assert.equal(result.afterRestore, 'rev-archive-one');
    assert.equal(result.rawValue, 'SENSITIVE_ARCHIVE_CASE');
    assert.equal(result.pendingAfterRestore, 1);
  });

  await t.test('a two-case restore cannot partially commit when its second case fails', async () => {
    const result = await page.evaluate(async () => {
      const { createAccountKeys } = await import('/crypto/keys.js');
      const { openLocalRepository } = await import('/storage/repository.js');
      const { exportEncrypted, previewRestore, restoreEncrypted } = await import('/export/archive.js');
      const created = await createAccountKeys('acct-two-cases');
      const source = await openLocalRepository({ dbName: 'source-two-cases',
        session: created.session, recoveryEnvelope: created.recoveryEnvelope,
        recoverySecret: created.recoverySecret, validateCase: async () => {} });
      for (const caseId of ['case-a', 'case-b']) {
        const caseData = { schemaVersion: '1', caseId, currency: 'USD',
          institutions: [], accountRefs: [], terms: [], aidItems: [], artifacts: [],
          proposals: [], events: [] };
        await source.commitReviewed({ case: caseData, ledger: { schemaVersion: '1', reviews: [] },
          revisionId: `rev-${caseId}`, operationId: `op-${caseId}`,
          expectedLocalRevision: null, serverRevision: null });
      }
      const archive = await exportEncrypted(source, { recoverySecret: created.recoverySecret });
      source.close();
      const destination = await openLocalRepository({ dbName: 'destination-two-cases',
        session: created.session, recoveryEnvelope: created.recoveryEnvelope,
        recoverySecret: created.recoverySecret, validateCase: async () => {} });
      const removedCase = JSON.parse(new TextDecoder().decode(archive));
      removedCase.cases.pop();
      let removedCaseCode = null;
      try { await previewRestore(destination,
        new TextEncoder().encode(JSON.stringify(removedCase)), created.recoverySecret); }
      catch (error) { removedCaseCode = error.code; }
      const originalPut = IDBObjectStore.prototype.put;
      let anchorWrites = 0;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'anchors' && ++anchorWrites === 2) {
          throw new DOMException('second case quota', 'QuotaExceededError');
        }
        return originalPut.apply(this, args);
      };
      let interrupted = null;
      try { await restoreEncrypted(destination, archive, created.recoverySecret,
        { 'case-a': null, 'case-b': null }); }
      catch (error) { interrupted = error.code; }
      finally { IDBObjectStore.prototype.put = originalPut; }
      const absentA = await destination.loadCase('case-a');
      const absentB = await destination.loadCase('case-b');
      const pendingA = await destination.prepareSync('case-a');
      const pendingB = await destination.prepareSync('case-b');
      const success = await restoreEncrypted(destination, archive, created.recoverySecret,
        { 'case-a': null, 'case-b': null });
      const presentA = await destination.loadCase('case-a');
      const presentB = await destination.loadCase('case-b');
      destination.close();
      return { removedCaseCode, interrupted, absentA, absentB, pendingA: pendingA.length,
        pendingB: pendingB.length, success, presentA: presentA.revisionId,
        presentB: presentB.revisionId };
    });
    assert.equal(result.removedCaseCode, 'CORRUPT_ARCHIVE');
    assert.equal(result.interrupted, 'STORAGE_QUOTA');
    assert.equal(result.absentA, null);
    assert.equal(result.absentB, null);
    assert.equal(result.pendingA, 0);
    assert.equal(result.pendingB, 0);
    assert.equal(result.success.restored, 2);
    assert.equal(result.presentA, 'rev-case-a');
    assert.equal(result.presentB, 'rev-case-b');
  });

  await t.test('v1 data requires an exact pre-upgrade backup and an interrupted upgrade rolls back', async () => {
    const result = await page.evaluate(async ({ bytes, secret }) => {
      const { base64UrlEncode } = await import('/crypto/codec.js');
      const { unlockRecovery } = await import('/crypto/keys.js');
      const { LocalRepository, openLocalRepository } = await import('/storage/repository.js');
      const { exportEncrypted, migrateLocalDatabase } = await import('/export/archive.js');
      const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
      const session = await unlockRecovery(parsed.recoveryEnvelope, secret, 'acct-archive');
      const legacyName = `legacy-${parsed.exportId}`;
      const legacyDb = await new Promise((resolve, reject) => {
        const request = indexedDB.open(legacyName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore('accounts', { keyPath: 'accountId' });
          db.createObjectStore('cases', { keyPath: ['accountId', 'caseId'] });
          db.createObjectStore('anchors', { keyPath: ['accountId', 'caseId'] });
          db.createObjectStore('budgets', { keyPath: ['accountId', 'caseId', 'keyGeneration', 'deviceId'] });
          const outbox = db.createObjectStore('outbox', { keyPath: ['accountId', 'operationId'] });
          outbox.createIndex('byCase', ['accountId', 'caseId']);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const proofBytes = await session.verificationBytes();
      const rootProof = base64UrlEncode(proofBytes);
      proofBytes.fill(0);
      await new Promise((resolve, reject) => {
        const tx = legacyDb.transaction(['accounts', 'cases', 'anchors'], 'readwrite');
        tx.objectStore('accounts').put({ accountId: 'acct-archive',
          recoveryEnvelope: parsed.recoveryEnvelope, rootProof });
        const record = parsed.cases[0];
        tx.objectStore('cases').put(record);
        tx.objectStore('anchors').put({ accountId: record.accountId, caseId: record.caseId,
          revisionId: record.revisionId, digest: record.digest });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      legacyDb.close();
      const codeOf = async (action) => { try { await action(); return null; } catch (error) { return error.code; } };
      const requiresBackup = await codeOf(() => openLocalRepository({ dbName: legacyName,
        session, validateCase: async () => {} }));
      const v1 = await new Promise((resolve, reject) => {
        const request = indexedDB.open(legacyName, 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const legacy = new LocalRepository(v1, session, async () => {});
      const staleBackup = await exportEncrypted(legacy, { recoverySecret: secret });
      const originalCase = await legacy.loadCase('case-archive');
      originalCase.case.events[0].fact.rawValue = 'MIGRATED_NEWER_LOCAL';
      await legacy.commitReviewed({ case: originalCase.case, ledger: originalCase.ledger,
        revisionId: 'rev-migrated-two', operationId: 'op-migrated-two',
        expectedLocalRevision: 'rev-archive-one', serverRevision: null });
      const backup = await exportEncrypted(legacy, { recoverySecret: secret });
      legacy.close();
      const staleBackupCode = await codeOf(() => migrateLocalDatabase({ dbName: legacyName,
        session, validateCase: async () => {}, backup: staleBackup, recoverySecret: secret }));
      const wrong = await codeOf(() => migrateLocalDatabase({ dbName: legacyName,
        session, validateCase: async () => {}, backup,
        recoverySecret: 'scryer-recovery-v1:' + 'A'.repeat(43) }));
      const originalCreate = IDBDatabase.prototype.createObjectStore;
      IDBDatabase.prototype.createObjectStore = function (...args) {
        if (args[0] === 'migrations') throw new DOMException('interrupted upgrade', 'AbortError');
        return originalCreate.apply(this, args);
      };
      let interrupted;
      try { interrupted = await codeOf(() => migrateLocalDatabase({ dbName: legacyName,
        session, validateCase: async () => {}, backup, recoverySecret: secret })); }
      finally { IDBDatabase.prototype.createObjectStore = originalCreate; }
      const stillV1 = await new Promise((resolve, reject) => {
        const request = indexedDB.open(legacyName, 1);
        request.onsuccess = () => { const version = request.result.version;
          request.result.close(); resolve(version); };
        request.onerror = () => reject(request.error);
      });
      const migrated = await migrateLocalDatabase({ dbName: legacyName,
        session, validateCase: async () => {}, backup, recoverySecret: secret });
      const reopened = await openLocalRepository({ dbName: legacyName, session,
        validateCase: async () => {} });
      const loaded = await reopened.loadCase('case-archive');
      const pending = await reopened.prepareSync('case-archive');
      reopened.close();
      return { requiresBackup, staleBackupCode, wrong, interrupted, stillV1, migrated,
        revisionId: loaded.revisionId, rawValue: loaded.case.events[0].fact.rawValue,
        pending: pending.map((item) => item.operationId) };
    }, { bytes: archiveBytes, secret: recoverySecret });
    assert.equal(result.requiresBackup, 'MIGRATION_REQUIRED');
    assert.equal(result.staleBackupCode, 'STALE_MIGRATION_BACKUP');
    assert.equal(result.wrong, 'WRONG_KEY');
    assert.equal(result.interrupted, 'STORAGE_ABORTED');
    assert.equal(result.stillV1, 1);
    assert.equal(result.migrated.from, 1);
    assert.equal(result.migrated.to, 2);
    assert.equal(result.revisionId, 'rev-migrated-two');
    assert.equal(result.rawValue, 'MIGRATED_NEWER_LOCAL');
    assert.deepEqual(result.pending, ['op-migrated-two']);
  });
});
