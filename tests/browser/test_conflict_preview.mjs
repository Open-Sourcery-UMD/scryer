import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBrowserHarness } from './harness.mjs';

const engineDir = fileURLToPath(new URL('../../engine', import.meta.url));
const nativeCli = fileURLToPath(new URL('../../engine/build/scryer-native', import.meta.url));

test('real browser previews both authenticated encrypted conflict branches without changing the outbox', async (t) => {
  const { page } = await openBrowserHarness(t);
  const result = await page.evaluate(async (dbName) => {
    const { createAccountKeys, unlockRecovery } = await import('/crypto/keys.js');
    const { sealCase } = await import('/crypto/envelope.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const { previewSyncConflict } = await import('/sync/conflict.js');
    const { analyzeConflictPreview, analyzeAncestorCandidate } =
      await import('/sync/analysis.js');
    const created = await createAccountKeys('acct-conflict-preview');
    const validateCase = async (value) => {
      if (value.events.some((event) => event.kind === 'invalid')) throw new Error('INVALID_CASE');
    };
    const repo = await openLocalRepository({ dbName, session: created.session,
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
      validateCase });
    const base = { schemaVersion: '1', caseId: 'case-conflict-preview', currency: 'USD',
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
      created.recoverySecret, 'acct-conflict-preview');
    const packageBody = await sealCase(remoteSession, 'case-conflict-preview', 'rev-remote',
      JSON.stringify({ schemaVersion: '1', case: remoteCase, ledger }));
    const ancestorCase = { ...base, events: [baseEvent] };
    const ancestorPackage = await sealCase(remoteSession, 'case-conflict-preview', 'rev-base',
      JSON.stringify({ schemaVersion: '1', case: ancestorCase, ledger }));
    const sha = async (body) => Array.from(new Uint8Array(await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(body))), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
    const fromPending = async (item) => ({ pendingOperationId: item.operationId,
      pendingRevisionId: item.revisionId,
      pendingManifestDigest: await sha(item.steps.at(-1).body),
      pendingExpectedServerRevision: item.expectedServerRevision });
    const pendingAtConflict = (await repo.prepareSync('case-conflict-preview'))[0];
    const conflict = { status: 'conflict', ...await fromPending(pendingAtConflict),
      remote: { revisionId: 'rev-remote', etag: '"rev-remote"',
        ciphertextBody: JSON.stringify(packageBody) },
      ancestor: { status: 'available', revisionId: 'rev-base', etag: '"rev-base"',
        ciphertextBody: JSON.stringify(ancestorPackage) } };
    const beforeLocal = JSON.stringify(await repo.loadCase('case-conflict-preview'));
    const beforePending = JSON.stringify(await repo.prepareSync('case-conflict-preview'));
    const preview = await previewSyncConflict(repo, 'case-conflict-preview', conflict);
    const analysis = analyzeConflictPreview(preview);
    const baseAnalysis = analyzeAncestorCandidate(preview);
    const afterLocal = JSON.stringify(await repo.loadCase('case-conflict-preview'));
    const afterPending = JSON.stringify(await repo.prepareSync('case-conflict-preview'));
    const codeOf = async (candidate) => {
      try { await previewSyncConflict(repo, 'case-conflict-preview', candidate); return null; }
      catch (error) { return error.code; }
    };
    const badTag = structuredClone(packageBody);
    badTag.chunks[0].tag = 'AAAAAAAAAAAAAAAAAAAAAA';
    const badCase = structuredClone(packageBody);
    badCase.caseId = 'case-other';
    const badAccount = structuredClone(packageBody);
    badAccount.accountId = 'acct-other';
    const badRevision = structuredClone(packageBody);
    badRevision.revisionId = 'rev-other';
    const semantic = await sealCase(remoteSession, 'case-conflict-preview', 'rev-remote',
      JSON.stringify({ schemaVersion: '1', case: { ...remoteCase,
        events: [{ ...remoteCase.events[0], kind: 'invalid' }] }, ledger }));
    const wrongRoot = await createAccountKeys('acct-conflict-preview');
    const wrongRootPkg = await sealCase(wrongRoot.session, 'case-conflict-preview', 'rev-remote',
      JSON.stringify({ schemaVersion: '1', case: remoteCase, ledger }));
    const badAncestor = structuredClone(ancestorPackage);
    badAncestor.chunks[0].tag = 'AAAAAAAAAAAAAAAAAAAAAA';
    const refused = {
      tag: await codeOf({ ...conflict, remote: { ...conflict.remote,
        ciphertextBody: JSON.stringify(badTag) } }),
      caseId: await codeOf({ ...conflict, remote: { ...conflict.remote,
        ciphertextBody: JSON.stringify(badCase) } }),
      accountId: await codeOf({ ...conflict, remote: { ...conflict.remote,
        ciphertextBody: JSON.stringify(badAccount) } }),
      revisionId: await codeOf({ ...conflict, remote: { ...conflict.remote,
        ciphertextBody: JSON.stringify(badRevision) } }),
      semantic: await codeOf({ ...conflict, remote: { ...conflict.remote,
        ciphertextBody: JSON.stringify(semantic) } }),
      wrongRoot: await codeOf({ ...conflict, remote: { ...conflict.remote,
        ciphertextBody: JSON.stringify(wrongRootPkg) } }),
      etag: await codeOf({ ...conflict, remote: { ...conflict.remote, etag: '"rev-other"' } }),
      whitespace: await codeOf({ ...conflict, remote: { ...conflict.remote,
        ciphertextBody: `${conflict.remote.ciphertextBody} ` } }),
      oversized: await codeOf({ ...conflict, remote: { ...conflict.remote,
        ciphertextBody: 'x'.repeat(12 * 1024 * 1024 + 1) } }),
      stale: await codeOf({ ...conflict, pendingRevisionId: 'rev-other' }),
      wrongOperation: await codeOf({ ...conflict, pendingOperationId: 'op-other' }),
      wrongManifest: await codeOf({ ...conflict, pendingManifestDigest: '0'.repeat(64) }),
      badAncestor: await codeOf({ ...conflict, ancestor: { ...conflict.ancestor,
        ciphertextBody: JSON.stringify(badAncestor) } }),
      wrongAncestorRevision: await codeOf({ ...conflict, ancestor: { ...conflict.ancestor,
        revisionId: 'rev-other' } }),
    };
    const missingAncestor = (await previewSyncConflict(repo, 'case-conflict-preview',
      { ...conflict, ancestor: { status: 'unavailable' } })).ancestor;
    const pendingAfterRefusals = JSON.stringify(await repo.prepareSync('case-conflict-preview'));
    const localAfterRefusals = JSON.stringify(await repo.loadCase('case-conflict-preview'));
    const replacementPackage = await sealCase(remoteSession, 'case-conflict-preview', 'rev-local',
      JSON.stringify({ schemaVersion: '1', case: localCase, ledger }));
    const replacementBody = JSON.stringify(replacementPackage);
    const replacement = { ...(await repo.encryptedSnapshot()).cases[0],
      package: replacementPackage, digest: await sha(replacementBody) };
    await repo.replaceEncryptedCases([replacement], { 'case-conflict-preview': 'rev-local' });
    const restoredStale = await codeOf(conflict);
    const newPending = (await repo.prepareSync('case-conflict-preview'))[0];
    const freshConflict = { ...conflict, ...await fromPending(newPending),
      ancestor: { status: 'not_requested' } };
    const inspect = repo.inspectRemoteCase.bind(repo);
    repo.inspectRemoteCase = async (...args) => {
      const inspected = await inspect(...args);
      if (args[2] === 'rev-remote') {
        await repo.commitReviewed({ case: localCase, ledger, revisionId: 'rev-local-mid',
          operationId: 'op-local-mid', expectedLocalRevision: 'rev-local', serverRevision: 'rev-base' });
        await repo.commitReviewed({ case: localCase, ledger, revisionId: 'rev-local',
          operationId: 'op-local-later', expectedLocalRevision: 'rev-local-mid', serverRevision: 'rev-base' });
      }
      return inspected;
    };
    const raced = await codeOf(freshConflict);
    const pendingAfterRace = await repo.prepareSync('case-conflict-preview');
    repo.inspectRemoteCase = inspect;
    const load = repo.loadCase.bind(repo);
    repo.loadCase = async () => { throw new Error('AUTH_FAILED'); };
    const initialReadRace = await codeOf(freshConflict);
    repo.loadCase = load;
    repo.close();
    return { preview, analysis, baseAnalysis,
      unchanged: beforeLocal === afterLocal && beforePending === afterPending,
      refusalUnchanged: beforePending === pendingAfterRefusals &&
        beforeLocal === localAfterRefusals,
      refused, missingAncestor, restoredStale, raced, initialReadRace,
      pendingAfterRace: pendingAfterRace.map((item) => item.revisionId) };
  }, `scryer-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const built = spawnSync('make', ['-C', engineDir, 'cli'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  for (const branch of [result.preview.ancestor.branch, result.preview.local,
    result.preview.remote]) {
    const validated = spawnSync(nativeCli, [], { input: JSON.stringify({ schemaVersion: '1',
      operation: 'validate', case: branch.case }), encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024 });
    assert.equal(validated.status, 0, validated.stderr);
  }
  assert.equal(result.preview.caseId, 'case-conflict-preview');
  assert.equal(result.preview.pendingRevisionId, 'rev-local');
  assert.equal(result.preview.pendingOperationId, 'op-local');
  assert.equal(result.preview.local.revisionId, 'rev-local');
  assert.deepEqual(result.preview.local.heads, ['event-local']);
  assert.equal(result.preview.local.case.events[1].fact.amountMinor, '200');
  assert.equal(result.preview.remote.revisionId, 'rev-remote');
  assert.deepEqual(result.preview.remote.heads, ['event-remote']);
  assert.equal(result.preview.remote.case.events[1].fact.amountMinor, '300');
  assert.equal(result.preview.ancestor.status, 'available');
  assert.equal(result.preview.ancestor.branch.revisionId, 'rev-base');
  assert.deepEqual(result.preview.ancestor.branch.heads, ['event-base']);
  assert.equal(result.preview.ancestor.branch.case.events[0].fact.amountMinor, '100');
  assert.deepEqual(result.missingAncestor, { status: 'unavailable' });
  assert.deepEqual(result.analysis, { caseId: 'case-conflict-preview',
    sharedEventIds: ['event-base'], localOnlyEventIds: ['event-local'],
    remoteOnlyEventIds: ['event-remote'], differentCaseFields: [],
    differentLedger: false, issues: [] });
  const retained = { missingBaseEventIds: [], changedBaseEventIds: [],
    changedCaseFields: [], changedLedgerPrefix: false, baseContentRetained: true };
  assert.deepEqual(result.baseAnalysis, { status: 'available', baseRevisionId: 'rev-base',
    local: retained, remote: retained });
  assert.equal(result.unchanged, true);
  assert.equal(result.refusalUnchanged, true);
  for (const [name, code] of Object.entries(result.refused)) {
    assert.equal(code, ['stale', 'wrongOperation', 'wrongManifest'].includes(name) ?
      'STALE_CONFLICT_PREVIEW' : name.includes('Ancestor') ?
        'ANCESTOR_UNVERIFIED' : 'REMOTE_UNVERIFIED', name);
  }
  assert.equal(result.restoredStale, 'STALE_CONFLICT_PREVIEW');
  assert.equal(result.raced, 'STALE_CONFLICT_PREVIEW');
  assert.equal(result.initialReadRace, 'STALE_CONFLICT_PREVIEW');
  assert.deepEqual(result.pendingAfterRace, ['rev-local', 'rev-local-mid', 'rev-local']);
});
