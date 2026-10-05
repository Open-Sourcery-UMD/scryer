import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBrowserHarness } from '../browser/harness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = fileURLToPath(new URL('../../.venv/bin/python', import.meta.url));
const fixture = fileURLToPath(new URL('./_client_api_fixture.py', import.meta.url));
const sentinel = 'SYNTHETIC_ONLY_BANK_LINE_7F9B24';

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function startApi(t, browserOrigin) {
  assert.ok(process.env.SCRYER_TEST_PG_SOCKET, 'SCRYER_TEST_PG_SOCKET required');
  const port = await unusedPort();
  const api = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env, SCRYER_TEST_API_PORT: String(port),
    SCRYER_TEST_BROWSER_ORIGIN: browserOrigin,
    SCRYER_TEST_DBNAME: `scryer_browser_${randomBytes(6).toString('hex')}`,
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const child = spawn(python, [fixture], { cwd: root, env: environment,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let logContainsSentinel = false;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      const combined = output + chunk.toString();
      logContainsSentinel ||= combined.includes(sentinel);
      output = combined.slice(-8000);
    });
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      let timer;
      await Promise.race([once(child, 'exit'), new Promise((resolve) => {
        timer = setTimeout(resolve, 5000);
      })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    const cleanup = spawn(python, [fixture, '--cleanup'], { cwd: root,
      env: environment, stdio: 'ignore' });
    const [code] = await once(cleanup, 'exit');
    assert.equal(code, 0, 'disposable database cleanup failed');
  });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try { ready = (await fetch(`${api}/health/ready`)).status === 200; }
    catch { /* Server not listening yet. */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'local synthetic API did not become ready');
  const scanSentinel = (marker) => {
    const result = spawnSync(python, [fixture, '--scan-sentinel'], {
      cwd: root, env: { ...environment, SCRYER_TEST_SENTINEL: marker },
      encoding: 'utf8', maxBuffer: 64 * 1024,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'disposable database sentinel scan failed');
    const counts = JSON.parse(result.stdout);
    assert.ok(counts.scannedColumns > 0);
    assert.ok(counts.byteColumns > 0);
    assert.ok(counts.textColumns > 0);
    return counts;
  };
  return { api, scanSentinel, logHasSentinel: () => logContainsSentinel };
}

async function account(api, token) {
  const response = await fetch(`${api}/v1/account`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('Chrome syncs real ciphertext through local HTTP and PostgreSQL, preserving conflicts', async (t) => {
  const { page } = await openBrowserHarness(t);
  const { api, scanSentinel, logHasSentinel } = await startApi(t,
    new URL(page.url()).origin);
  const browserWireBodies = [];
  const sentinelBytes = Buffer.from(sentinel, 'utf8');
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== api) return;
    const body = request.postDataBuffer();
    if (body !== null) browserWireBodies.push(body.includes(sentinelBytes));
  });
  const one = await account(api, 'one');
  const two = await account(api, 'two');
  assert.notEqual(one.accountId, two.accountId);
  const dbName = `scryer-api-browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const first = await page.evaluate(async ({ accountId, dbName, api, sentinel }) => {
    const { createAccountKeys, verifyRecoverySecret } = await import('/crypto/keys.js');
    const { base64UrlEncode } = await import('/crypto/codec.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const { syncCase } = await import('/sync/transport.js');
    const created = await createAccountKeys(accountId);
    const wrongSecret = `scryer-recovery-v1:${base64UrlEncode(new Uint8Array(32))}`;
    if (await verifyRecoverySecret(created.session, created.recoveryEnvelope, wrongSecret)) {
      throw new Error('wrong synthetic recovery secret accepted');
    }
    const missingBeforeVerification = await fetch(`${api}/v1/account/recovery-envelope`, {
      headers: { Authorization: 'Bearer one' },
    });
    if (missingBeforeVerification.status !== 404) {
      throw new Error('wrapper uploaded before recovery re-entry');
    }
    if (!await verifyRecoverySecret(created.session, created.recoveryEnvelope,
      created.recoverySecret)) throw new Error('synthetic recovery re-entry failed');
    const wrapperBody = JSON.stringify(created.recoveryEnvelope);
    const wrapperUpload = await fetch(`${api}/v1/account/recovery-envelope`, {
      method: 'PUT', headers: { Authorization: 'Bearer one',
        'Content-Type': 'application/json', 'Idempotency-Key': 'browser:wrapper:create',
        'If-None-Match': '*' }, body: wrapperBody,
    });
    if (wrapperUpload.status !== 200) throw new Error('synthetic wrapper upload failed');
    const repo = await openLocalRepository({ dbName, session: created.session,
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
      validateCase: async () => {} });
    const caseData = { schemaVersion: '1', caseId: 'case-browser-api', currency: 'USD',
      institutions: [], accountRefs: [{ accountRefId: 'account-bank', kind: 'bank',
        institutionId: null, holderKind: 'student' }], terms: [], aidItems: [],
      artifacts: [{ artifactId: 'artifact-synthetic', sha256: 'a'.repeat(64),
        kind: 'bank_statement', observedAt: '2026-10-04T00:00:00Z',
        accountRefId: 'account-bank' }],
      proposals: [{ proposalId: 'proposal-synthetic', artifactId: 'artifact-synthetic',
        sourceLocation: 'row:1', rawValue: sentinel, parserVersion: 'synthetic.1',
        mappingVersion: 'synthetic.1', proposedAmountMinor: '849217' }],
      events: [{ eventId: 'event-bank-observed', parents: [],
        recordedAt: '2026-10-05T00:00:00Z', kind: 'approve_fact', fact: {
          factId: 'fact-bank-observed', termId: null, accountRefId: 'account-bank',
          aidItemId: null, currency: 'USD', role: 'bank_credit_observed',
          recipientKind: null, amountMinor: '849217', proposalId: null,
          effectiveDate: '2026-10-03',
          source: { kind: 'manual', entryId: 'entry-bank-observed' },
          reviewId: 'review-bank-observed' } }] };
    const ledger = { schemaVersion: '1', reviews: [] };
    await repo.commitReviewed({ case: caseData, ledger, revisionId: 'rev-one',
      operationId: 'op-one', expectedLocalRevision: null, serverRevision: null });
    await repo.commitReviewed({ case: caseData, ledger, revisionId: 'rev-two',
      operationId: 'op-two', expectedLocalRevision: 'rev-one', serverRevision: null });
    const loadedLocal = (await repo.loadCase('case-browser-api')).case;
    const localContainsSentinel = loadedLocal.proposals.some(
      (proposal) => proposal.rawValue === sentinel);
    const localHasApprovedAmount = loadedLocal.events.some((event) =>
      event.eventId === 'event-bank-observed' && event.kind === 'approve_fact' &&
      event.fact?.role === 'bank_credit_observed' &&
      event.fact?.amountMinor === '849217');
    const before = await repo.prepareSync('case-browser-api');
    const controller = new AbortController();
    let lost = false;
    const fetchImpl = async (url, init) => {
      const response = await fetch(url, init);
      if (!lost && url.endsWith('/revisions')) {
        lost = true;
        controller.abort();
        throw new DOMException('synthetic interruption after server commit', 'AbortError');
      }
      return response;
    };
    const result = await syncCase(repo, 'case-browser-api', { baseUrl: api,
      accessToken: 'one', fetchImpl, signal: controller.signal });
    const after = await repo.prepareSync('case-browser-api');
    const snapshot = await repo.encryptedSnapshot();
    repo.close();
    return { before, result, after, localContainsSentinel, localHasApprovedAmount,
      packageJson: JSON.stringify(snapshot.cases[0].package),
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
      wrapperBody, wrapperEtag: wrapperUpload.headers.get('etag') };
  }, { accountId: one.accountId, dbName, api, sentinel });
  assert.equal(first.localContainsSentinel, true);
  assert.equal(first.localHasApprovedAmount, true);
  const browserBodiesAfterFirst = browserWireBodies.length;
  assert.ok(browserBodiesAfterFirst >= 2,
    'browser request observer missed initial API bodies');
  assert.equal(JSON.stringify(first.before).includes(sentinel), false);
  assert.equal(first.packageJson.includes(sentinel), false);
  assert.equal(first.before.length, 2);
  assert.equal(first.result.status, 'interrupted');
  assert.ok(JSON.stringify(first.after) === JSON.stringify(first.before),
    'interrupted sync changed the saved outbox');
  assert.equal(first.wrapperEtag, '"1"');
  const wrapperGet = await fetch(`${api}/v1/account/recovery-envelope`, {
    headers: { Authorization: 'Bearer one' },
  });
  assert.equal(wrapperGet.status, 200);
  assert.equal(wrapperGet.headers.get('etag'), '"1"');
  const retrievedWrapper = await wrapperGet.text();
  assert.ok(retrievedWrapper === first.wrapperBody,
    'retrieved recovery wrapper differs from uploaded bytes');
  const serverEnvelope = JSON.parse(retrievedWrapper);
  const otherWrapper = await fetch(`${api}/v1/account/recovery-envelope`, {
    headers: { Authorization: 'Bearer two' },
  });
  assert.equal(otherWrapper.status, 404);
  const committedBeforeAck = await fetch(`${api}/v1/cases/case-browser-api`, {
    headers: { Authorization: 'Bearer one' },
  });
  assert.equal(committedBeforeAck.status, 200);
  assert.equal(committedBeforeAck.headers.get('etag'), '"rev-one"');
  assert.equal((await committedBeforeAck.text()).includes(sentinel), false);
  const firstScan = scanSentinel(sentinel);
  assert.equal(firstScan.matches, 0);
  assert.ok(firstScan.revisions >= 1);
  const crossTenant = await fetch(`${api}/v1/cases/case-browser-api`, {
    headers: { Authorization: 'Bearer two' },
  });
  assert.equal(crossTenant.status, 404);

  await page.reload();
  const resumed = await page.evaluate(async ({ accountId, dbName, api, envelope,
    secret, sentinel }) => {
    const { unlockRecovery } = await import('/crypto/keys.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const { syncCase } = await import('/sync/transport.js');
    const session = await unlockRecovery(envelope, secret, accountId);
    const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
    const recoveredCase = (await repo.loadCase('case-browser-api')).case;
    const recoveredSource = recoveredCase.proposals.some(
      (proposal) => proposal.rawValue === sentinel);
    const recoveredAmount = recoveredCase.events.some((event) =>
      event.eventId === 'event-bank-observed' && event.kind === 'approve_fact' &&
      event.fact?.role === 'bank_credit_observed' &&
      event.fact?.amountMinor === '849217');
    const pendingBefore = await repo.prepareSync('case-browser-api');
    const sent = [];
    const wireBodies = [];
    const fetchImpl = async (url, init) => {
      if (typeof init.body === 'string') wireBodies.push(init.body.includes(sentinel));
      if (url.endsWith('/revisions')) sent.push({ body: init.body,
        key: init.headers['Idempotency-Key'],
        precondition: init.headers['If-None-Match'] ?? init.headers['If-Match'] });
      return fetch(url, init);
    };
    const result = await syncCase(repo, 'case-browser-api', { baseUrl: api,
      accessToken: 'one', fetchImpl });
    const pendingAfter = await repo.prepareSync('case-browser-api');
    repo.close();
    return { pendingBefore, sent, wireBodies, result, pendingAfter,
      recoveredSource, recoveredAmount };
  }, { accountId: one.accountId, dbName, api,
    envelope: serverEnvelope, secret: first.recoverySecret, sentinel });
  assert.equal(resumed.recoveredSource, true);
  assert.equal(resumed.recoveredAmount, true);
  const browserBodiesAfterResume = browserWireBodies.length;
  assert.ok(browserBodiesAfterResume > browserBodiesAfterFirst,
    'browser request observer missed resumed API bodies');
  assert.ok(JSON.stringify(resumed.pendingBefore) === JSON.stringify(first.before),
    'recovery changed the saved outbox');
  assert.equal(resumed.result.status, 'committed');
  assert.equal(resumed.result.revisionId, 'rev-two');
  assert.equal(resumed.result.count, 2);
  assert.equal(resumed.pendingAfter.length, 0);
  assert.equal(resumed.sent.length, 2);
  for (let index = 0; index < resumed.sent.length; index++) {
    const expected = first.before[index].steps.at(-1);
    assert.ok(resumed.sent[index].body === expected.body,
      `resumed manifest ${index} changed its saved bytes`);
    assert.equal(resumed.sent[index].key, expected.idempotencyKey);
    assert.equal(resumed.sent[index].precondition,
      index === 0 ? '*' : '"rev-one"');
  }
  assert.equal(JSON.stringify(resumed.sent).includes(sentinel), false);
  assert.ok(resumed.wireBodies.length >= 2);
  assert.ok(resumed.wireBodies.every((found) => !found));
  const head = await fetch(`${api}/v1/cases/case-browser-api`, {
    headers: { Authorization: 'Bearer one' },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('etag'), '"rev-two"');
  const headBody = await head.text();
  assert.ok(headBody === first.packageJson,
    'HTTP head ciphertext differs from the saved encrypted package');
  assert.equal(headBody.includes(sentinel), false);
  const historical = await fetch(`${api}/v1/cases/case-browser-api/revisions/rev-one`, {
    headers: { Authorization: 'Bearer one' },
  });
  assert.equal(historical.status, 200);
  assert.equal((await historical.text()).includes(sentinel), false);
  await page.reload();
  const conflict = await page.evaluate(async ({ accountId, dbName, api, envelope,
    secret, marker }) => {
    const { unlockRecovery } = await import('/crypto/keys.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const { syncCase } = await import('/sync/transport.js');
    const { previewSyncConflict } = await import('/sync/conflict.js');
    const sessionA = await unlockRecovery(envelope, secret, accountId);
    const repoA = await openLocalRepository({ dbName, session: sessionA,
      validateCase: async () => {} });
    const loaded = await repoA.loadCase('case-browser-api');
    const sessionB = await unlockRecovery(envelope, secret, accountId);
    const repoB = await openLocalRepository({ dbName: `${dbName}-device-b`, session: sessionB,
      recoveryEnvelope: envelope, recoverySecret: secret, validateCase: async () => {} });
    await repoB.commitReviewed({ case: loaded.case, ledger: loaded.ledger,
      revisionId: 'rev-divergent', operationId: 'op-divergent',
      expectedLocalRevision: null, serverRevision: 'rev-two' });
    const wrongAccount = await syncCase(repoB, 'case-browser-api', { baseUrl: api,
      accessToken: 'two' });
    await repoA.commitReviewed({ case: loaded.case, ledger: loaded.ledger,
      revisionId: 'rev-three', operationId: 'op-three',
      expectedLocalRevision: 'rev-two', serverRevision: 'rev-two' });
    const winner = await syncCase(repoA, 'case-browser-api', { baseUrl: api,
      accessToken: 'one' });
    const loser = await syncCase(repoB, 'case-browser-api', { baseUrl: api,
      accessToken: 'one' });
    const preview = loser.status === 'conflict' ?
      await previewSyncConflict(repoB, 'case-browser-api', loser) : null;
    const remaining = await repoB.prepareSync('case-browser-api');
    repoA.close(); repoB.close();
    return { wrongAccount, winner, loser, remaining,
      plaintextRecovered: preview && [preview.local, preview.remote,
        preview.ancestor.status === 'available' ? preview.ancestor.branch : null]
        .every((branch) => branch?.case.proposals[0]?.rawValue === marker &&
          branch.case.events.some((event) =>
            event.eventId === 'event-bank-observed' &&
            event.kind === 'approve_fact' &&
            event.fact?.role === 'bank_credit_observed' &&
            event.fact?.amountMinor === '849217')),
      preview: preview && { caseId: preview.caseId,
        pendingRevisionId: preview.pendingRevisionId,
        localRevisionId: preview.local.revisionId,
        remoteRevisionId: preview.remote.revisionId,
        ancestorStatus: preview.ancestor.status,
        ancestorRevisionId: preview.ancestor.status === 'available' ?
          preview.ancestor.branch.revisionId : null,
        localHeads: preview.local.heads, remoteHeads: preview.remote.heads } };
  }, { accountId: one.accountId, dbName, api,
    envelope: serverEnvelope, secret: first.recoverySecret, marker: sentinel });
  assert.equal(conflict.wrongAccount.status, 'permanent');
  assert.equal(conflict.winner.status, 'committed');
  assert.equal(conflict.winner.revisionId, 'rev-three');
  assert.equal(conflict.winner.count, 1);
  assert.equal(conflict.loser.status, 'conflict');
  assert.equal(conflict.loser.remote.revisionId, 'rev-three');
  assert.equal(JSON.stringify(conflict.loser).includes(sentinel), false);
  assert.equal(conflict.plaintextRecovered, true);
  assert.ok(browserWireBodies.length > browserBodiesAfterResume,
    'browser request observer missed conflict API bodies');
  assert.equal(conflict.remaining.length, 1);
  assert.deepEqual(conflict.preview, { caseId: 'case-browser-api',
    pendingRevisionId: 'rev-divergent', localRevisionId: 'rev-divergent',
    remoteRevisionId: 'rev-three', ancestorStatus: 'available',
    ancestorRevisionId: 'rev-two', localHeads: ['event-bank-observed'],
    remoteHeads: ['event-bank-observed'] });
  const conflictScan = scanSentinel(sentinel);
  assert.equal(conflictScan.matches, 0);
  assert.ok(conflictScan.revisions >= 3);
  assert.ok(conflictScan.staged >= 1);

  const deleted = await fetch(`${api}/v1/cases/case-browser-api`, { method: 'DELETE',
    headers: { Authorization: 'Bearer one', 'Idempotency-Key': 'browser:delete',
      'If-Match': '"rev-three"' } });
  assert.equal(deleted.status, 200);
  const afterDelete = await page.evaluate(async ({ accountId, dbName, api, envelope, secret }) => {
    const { unlockRecovery } = await import('/crypto/keys.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const { syncCase } = await import('/sync/transport.js');
    const session = await unlockRecovery(envelope, secret, accountId);
    const repo = await openLocalRepository({ dbName: `${dbName}-device-b`, session,
      validateCase: async () => {} });
    const result = await syncCase(repo, 'case-browser-api', { baseUrl: api,
      accessToken: 'one' });
    const pending = await repo.prepareSync('case-browser-api');
    repo.close();
    return { result, pending };
  }, { accountId: one.accountId, dbName, api,
    envelope: serverEnvelope, secret: first.recoverySecret });
  assert.equal(afterDelete.result.status, 'permanent');
  assert.equal(afterDelete.result.httpStatus, 409);
  assert.equal(afterDelete.pending.length, 1);
  assert.ok(browserWireBodies.length >= 4,
    'browser request observer saw too few API bodies');
  assert.ok(browserWireBodies.every((found) => !found),
    'synthetic source text appeared in a browser API request body');
  assert.equal(logHasSentinel(), false);
});

test('Chrome publishes a reviewed join and preserves a later stale join through local API and PostgreSQL', async (t) => {
  const { page } = await openBrowserHarness(t);
  const { api, scanSentinel, logHasSentinel } = await startApi(t,
    new URL(page.url()).origin);
  const one = await account(api, 'one').catch((error) => {
    throw new Error('joined journey account one failed', { cause: error });
  });
  const two = await account(api, 'two').catch((error) => {
    throw new Error('joined journey account two failed', { cause: error });
  });
  const wireBodies = [];
  const sentinelBytes = Buffer.from(sentinel, 'utf8');
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== api) return;
    const body = request.postDataBuffer();
    if (body !== null) wireBodies.push(body.includes(sentinelBytes));
  });
  const dbName = `scryer-join-api-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const journey = await page.evaluate(async ({ accountId, dbName, api, sentinel }) => {
    const { createAccountKeys, unlockRecovery } = await import('/crypto/keys.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const { syncCase } = await import('/sync/transport.js');
    const { previewSyncConflict } = await import('/sync/conflict.js');
    const { digestDisjointApprovalCandidate } = await import('/sync/analysis.js');
    const { commitReviewedApprovalJoin } = await import('/sync/resolve.js');
    const created = await createAccountKeys(accountId);
    const validateCase = async (value) => {
      if (value.events.some((event) => event.kind === 'invalid')) throw new Error('INVALID_CASE');
    };
    const repoA = await openLocalRepository({ dbName, session: created.session,
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
      validateCase });
    const shell = { schemaVersion: '1', caseId: 'case-joined-api', currency: 'USD',
      institutions: [], accountRefs: [{ accountRefId: 'account-bank', kind: 'bank',
        institutionId: null, holderKind: 'student' }], terms: [], aidItems: [],
      artifacts: [{ artifactId: 'artifact-join', sha256: 'a'.repeat(64),
        kind: 'bank_statement', observedAt: '2026-10-04T00:00:00Z',
        accountRefId: 'account-bank' }],
      proposals: [{ proposalId: 'proposal-join', artifactId: 'artifact-join',
        sourceLocation: 'row:1', rawValue: sentinel, parserVersion: 'synthetic.1',
        mappingVersion: 'synthetic.1', proposedAmountMinor: '100' }] };
    const approved = (eventId, factId, amountMinor, parents) => ({ eventId, parents,
      recordedAt: '2026-10-05T00:00:00Z', kind: 'approve_fact', fact: {
        factId, termId: null, accountRefId: 'account-bank', aidItemId: null,
        currency: 'USD', role: 'bank_credit_observed', recipientKind: null,
        amountMinor, proposalId: null, effectiveDate: '2026-10-03',
        source: { kind: 'manual', entryId: `entry-${factId}` },
        reviewId: `review-${factId}` } });
    const storedCiphertext = async () => new Promise((resolve, reject) => {
      const opened = indexedDB.open(dbName);
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const db = opened.result;
        const tx = db.transaction('cases', 'readonly');
        const request = tx.objectStore('cases').get([accountId, shell.caseId]);
        let record;
        request.onsuccess = () => { record = request.result; };
        tx.oncomplete = () => { db.close(); resolve(JSON.stringify(record)); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
    const baseEvent = approved('event-base', 'fact-base', '100', []);
    const baseCase = { ...shell, events: [baseEvent] };
    const ledger = { schemaVersion: '1', reviews: [] };
    await repoA.commitReviewed({ case: baseCase, ledger, revisionId: 'rev-base',
      operationId: 'op-base', expectedLocalRevision: null, serverRevision: null });
    const basePublished = await syncCase(repoA, shell.caseId,
      { baseUrl: api, accessToken: 'one' });
    const sessionB = await unlockRecovery(created.recoveryEnvelope,
      created.recoverySecret, accountId);
    const repoB = await openLocalRepository({ dbName: `${dbName}-device-b`, session: sessionB,
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
      validateCase });
    const branchB = { ...shell, events: [baseEvent,
      approved('event-b', 'fact-b', '300', ['event-base'])] };
    await repoB.commitReviewed({ case: branchB, ledger, revisionId: 'rev-b',
      operationId: 'op-b', expectedLocalRevision: null, serverRevision: 'rev-base' });
    const branchA = { ...shell, events: [baseEvent,
      approved('event-a', 'fact-a', '200', ['event-base'])] };
    await repoA.commitReviewed({ case: branchA, ledger, revisionId: 'rev-a',
      operationId: 'op-a', expectedLocalRevision: 'rev-base', serverRevision: 'rev-base' });
    const winner = await syncCase(repoA, shell.caseId,
      { baseUrl: api, accessToken: 'one' });
    const loser = await syncCase(repoB, shell.caseId,
      { baseUrl: api, accessToken: 'one' });
    if (loser.status !== 'conflict') throw new Error('expected synthetic CAS conflict');
    const preview = await previewSyncConflict(repoB, shell.caseId, loser);
    const candidateDigest = await digestDisjointApprovalCandidate(preview);
    const command = { caseId: preview.caseId,
      pendingOperationId: preview.pendingOperationId,
      pendingRevisionId: preview.pendingRevisionId,
      pendingManifestDigest: preview.pendingManifestDigest,
      pendingStepsDigest: preview.pendingStepsDigest,
      localCiphertextDigest: preview.localCiphertextDigest,
      localRevisionId: preview.local.revisionId,
      remoteRevisionId: preview.remote.revisionId,
      baseRevisionId: preview.ancestor.branch.revisionId,
      localHead: 'event-b', remoteHead: 'event-a',
      localOnlyEventIds: ['event-b'], remoteOnlyEventIds: ['event-a'],
      candidateDigest, eventId: 'event-join', reviewId: 'review-join',
      recordedAt: '2026-10-05T12:00:00Z' };
    const committedLocally = await commitReviewedApprovalJoin(repoB, loser, command,
      'rev-joined', 'op-joined', validateCase);
    const pendingBeforePublish = await repoB.prepareSync(shell.caseId);
    const joinedBeforePublish = await repoB.loadCase(shell.caseId);
    const published = await syncCase(repoB, shell.caseId,
      { baseUrl: api, accessToken: 'one' });
    const pendingAfterPublish = await repoB.prepareSync(shell.caseId);
    const joined = await repoB.loadCase(shell.caseId);
    const joinedHeadResponse = await fetch(`${api}/v1/cases/${shell.caseId}`, {
      headers: { Authorization: 'Bearer one' },
    });
    const joinedServerEtag = joinedHeadResponse.headers.get('etag');
    await joinedHeadResponse.body?.cancel();

    // A second pair of approvals starts from the already published join.
    const sessionC = await unlockRecovery(created.recoveryEnvelope,
      created.recoverySecret, accountId);
    const repoC = await openLocalRepository({ dbName: `${dbName}-device-c`, session: sessionC,
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
      validateCase });
    const branchD = { ...joined.case, events: [...joined.case.events,
      approved('event-d', 'fact-d', '400', ['event-join'])] };
    const branchE = { ...joined.case, events: [...joined.case.events,
      approved('event-e', 'fact-e', '500', ['event-join'])] };
    await repoB.commitReviewed({ case: branchD, ledger, revisionId: 'rev-d',
      operationId: 'op-d', expectedLocalRevision: 'rev-joined',
      serverRevision: 'rev-joined' });
    await repoC.commitReviewed({ case: branchE, ledger, revisionId: 'rev-e',
      operationId: 'op-e', expectedLocalRevision: null,
      serverRevision: 'rev-joined' });
    const secondWinner = await syncCase(repoC, shell.caseId,
      { baseUrl: api, accessToken: 'one' });
    const secondLoser = await syncCase(repoB, shell.caseId,
      { baseUrl: api, accessToken: 'one' });
    if (secondLoser.status !== 'conflict') throw new Error('expected second CAS conflict');
    const secondPreview = await previewSyncConflict(repoB, shell.caseId, secondLoser);
    const secondDigest = await digestDisjointApprovalCandidate(secondPreview);
    const secondCommand = { caseId: secondPreview.caseId,
      pendingOperationId: secondPreview.pendingOperationId,
      pendingRevisionId: secondPreview.pendingRevisionId,
      pendingManifestDigest: secondPreview.pendingManifestDigest,
      pendingStepsDigest: secondPreview.pendingStepsDigest,
      localCiphertextDigest: secondPreview.localCiphertextDigest,
      localRevisionId: secondPreview.local.revisionId,
      remoteRevisionId: secondPreview.remote.revisionId,
      baseRevisionId: secondPreview.ancestor.branch.revisionId,
      localHead: 'event-d', remoteHead: 'event-e',
      localOnlyEventIds: ['event-d'], remoteOnlyEventIds: ['event-e'],
      candidateDigest: secondDigest, eventId: 'event-join-2',
      reviewId: 'review-join-2', recordedAt: '2026-10-05T13:00:00Z' };
    await commitReviewedApprovalJoin(repoB, secondLoser, secondCommand,
      'rev-joined-2', 'op-joined-2', validateCase);
    const queuedJoin = await repoB.prepareSync(shell.caseId);
    const queuedCase = await repoB.loadCase(shell.caseId);
    const queuedCiphertext = await storedCiphertext();

    // The remote head moves again before this reviewed join is published.
    const branchF = { ...branchE, events: [...branchE.events,
      approved('event-f', 'fact-f', '600', ['event-e'])] };
    await repoC.commitReviewed({ case: branchF, ledger, revisionId: 'rev-f',
      operationId: 'op-f', expectedLocalRevision: 'rev-e', serverRevision: 'rev-e' });
    const remoteAdvance = await syncCase(repoC, shell.caseId,
      { baseUrl: api, accessToken: 'one' });
    const staleJoin = await syncCase(repoB, shell.caseId,
      { baseUrl: api, accessToken: 'one' });
    const queuedAfterConflict = await repoB.prepareSync(shell.caseId);
    const localAfterConflict = await repoB.loadCase(shell.caseId);
    const ciphertextAfterConflict = await storedCiphertext();
    const advancedPreview = await previewSyncConflict(repoB, shell.caseId, staleJoin);
    repoA.close(); repoB.close(); repoC.close();
    return { basePublished, winner, loserStatus: loser.status,
      previewHeads: [preview.local.heads, preview.remote.heads],
      committedLocally, pendingBeforePublish, joinedBeforePublish,
      published, pendingAfterPublish, joined, joinedServerEtag,
      secondWinner, secondLoserStatus: secondLoser.status,
      queuedJoin, queuedCase, remoteAdvance, staleJoinStatus: staleJoin.status,
      pendingPreserved: JSON.stringify(queuedAfterConflict) === JSON.stringify(queuedJoin),
      casePreserved: JSON.stringify(localAfterConflict) === JSON.stringify(queuedCase),
      ciphertextPreserved: ciphertextAfterConflict === queuedCiphertext,
      advancedPreviewHeads: [advancedPreview.local.heads, advancedPreview.remote.heads],
      localSourceRetained: joined.case.proposals[0].rawValue === sentinel };
  }, { accountId: one.accountId, dbName, api, sentinel });
  assert.equal(journey.basePublished.status, 'committed');
  assert.equal(journey.winner.status, 'committed');
  assert.equal(journey.loserStatus, 'conflict');
  assert.deepEqual(journey.previewHeads, [['event-b'], ['event-a']]);
  assert.equal(journey.committedLocally.joinEventId, 'event-join');
  assert.equal(journey.pendingBeforePublish.length, 1);
  assert.equal(journey.pendingBeforePublish[0].operationId, 'op-joined');
  assert.equal(journey.pendingBeforePublish[0].expectedServerRevision, 'rev-a');
  assert.deepEqual(journey.joinedBeforePublish.case.events.map((event) => event.eventId),
    ['event-a', 'event-b', 'event-base', 'event-join']);
  assert.equal(journey.published.status, 'committed');
  assert.equal(journey.published.revisionId, 'rev-joined');
  assert.equal(journey.joinedServerEtag, '"rev-joined"');
  assert.equal(journey.pendingAfterPublish.length, 0);
  assert.equal(journey.localSourceRetained, true);
  assert.deepEqual(journey.joined.case.events.at(-1).parents, ['event-a', 'event-b']);
  assert.equal(journey.secondWinner.status, 'committed');
  assert.equal(journey.secondLoserStatus, 'conflict');
  assert.equal(journey.queuedJoin.length, 1);
  assert.equal(journey.queuedJoin[0].operationId, 'op-joined-2');
  assert.equal(journey.queuedJoin[0].expectedServerRevision, 'rev-e');
  assert.equal(journey.remoteAdvance.status, 'committed');
  assert.equal(journey.staleJoinStatus, 'conflict');
  assert.equal(journey.pendingPreserved, true);
  assert.equal(journey.casePreserved, true);
  assert.equal(journey.ciphertextPreserved, true);
  assert.deepEqual(journey.advancedPreviewHeads, [['event-join-2'], ['event-f']]);
  const head = await fetch(`${api}/v1/cases/case-joined-api`, {
    headers: { Authorization: 'Bearer one' },
  }).catch((error) => { throw new Error('joined journey head fetch failed', { cause: error }); });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('etag'), '"rev-f"');
  assert.equal((await head.text()).includes(sentinel), false);
  const otherHead = await fetch(`${api}/v1/cases/case-joined-api`, {
    headers: { Authorization: 'Bearer two' },
  }).catch((error) => { throw new Error('joined journey cross-tenant fetch failed', { cause: error }); });
  assert.equal(otherHead.status, 404);
  const counts = scanSentinel(sentinel);
  assert.equal(counts.matches, 0);
  assert.ok(counts.revisions >= 5);
  assert.ok(wireBodies.length > 0);
  assert.ok(wireBodies.every((found) => !found));
  assert.equal(logHasSentinel(), false);
  // Synchronous native compilation follows the HTTP checks so an idle keep-alive
  // connection is not reused after the fixture server closes it.
  const built = spawnSync('make', ['-C', `${root}/engine`, 'cli'], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const native = spawnSync(`${root}/engine/build/scryer-native`, [], {
    input: JSON.stringify({ schemaVersion: '1', operation: 'validate', case: journey.joined.case }),
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(native.status, 0, native.stderr);
  const secondNative = spawnSync(`${root}/engine/build/scryer-native`, [], {
    input: JSON.stringify({ schemaVersion: '1', operation: 'validate',
      case: journey.queuedCase.case }),
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(secondNative.status, 0, secondNative.stderr);
});
