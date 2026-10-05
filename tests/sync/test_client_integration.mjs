import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openBrowserHarness } from '../browser/harness.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = fileURLToPath(new URL('../../.venv/bin/python', import.meta.url));
const fixture = fileURLToPath(new URL('./_client_api_fixture.py', import.meta.url));

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
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { output = (output + chunk.toString()).slice(-8000); });
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
      env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let cleanupError = '';
    cleanup.stderr.on('data', (chunk) => { cleanupError += chunk.toString(); });
    const [code] = await once(cleanup, 'exit');
    assert.equal(code, 0, `disposable database cleanup failed: ${cleanupError}`);
  });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) break;
    try { ready = (await fetch(`${api}/health/ready`)).status === 200; }
    catch { /* Server not listening yet. */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `local synthetic API did not become ready: ${output}`);
  return api;
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
  const api = await startApi(t, new URL(page.url()).origin);
  const one = await account(api, 'one');
  const two = await account(api, 'two');
  assert.notEqual(one.accountId, two.accountId);
  const dbName = `scryer-api-browser-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const first = await page.evaluate(async ({ accountId, dbName, api }) => {
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
      institutions: [], accountRefs: [], terms: [], aidItems: [], artifacts: [],
      proposals: [], events: [] };
    const ledger = { schemaVersion: '1', reviews: [] };
    await repo.commitReviewed({ case: caseData, ledger, revisionId: 'rev-one',
      operationId: 'op-one', expectedLocalRevision: null, serverRevision: null });
    await repo.commitReviewed({ case: caseData, ledger, revisionId: 'rev-two',
      operationId: 'op-two', expectedLocalRevision: 'rev-one', serverRevision: null });
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
    return { before, result, after, packageJson: JSON.stringify(snapshot.cases[0].package),
      recoveryEnvelope: created.recoveryEnvelope, recoverySecret: created.recoverySecret,
      wrapperBody, wrapperEtag: wrapperUpload.headers.get('etag') };
  }, { accountId: one.accountId, dbName, api });
  assert.equal(first.before.length, 2);
  assert.equal(first.result.status, 'interrupted');
  assert.deepEqual(first.after, first.before);
  assert.equal(first.wrapperEtag, '"1"');
  const wrapperGet = await fetch(`${api}/v1/account/recovery-envelope`, {
    headers: { Authorization: 'Bearer one' },
  });
  assert.equal(wrapperGet.status, 200);
  assert.equal(wrapperGet.headers.get('etag'), '"1"');
  const retrievedWrapper = await wrapperGet.text();
  assert.equal(retrievedWrapper, first.wrapperBody);
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
  const crossTenant = await fetch(`${api}/v1/cases/case-browser-api`, {
    headers: { Authorization: 'Bearer two' },
  });
  assert.equal(crossTenant.status, 404);

  await page.reload();
  const resumed = await page.evaluate(async ({ accountId, dbName, api, envelope, secret }) => {
    const { unlockRecovery } = await import('/crypto/keys.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const { syncCase } = await import('/sync/transport.js');
    const session = await unlockRecovery(envelope, secret, accountId);
    const repo = await openLocalRepository({ dbName, session, validateCase: async () => {} });
    const pendingBefore = await repo.prepareSync('case-browser-api');
    const sent = [];
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/revisions')) sent.push({ body: init.body,
        key: init.headers['Idempotency-Key'],
        precondition: init.headers['If-None-Match'] ?? init.headers['If-Match'] });
      return fetch(url, init);
    };
    const result = await syncCase(repo, 'case-browser-api', { baseUrl: api,
      accessToken: 'one', fetchImpl });
    const pendingAfter = await repo.prepareSync('case-browser-api');
    repo.close();
    return { pendingBefore, sent, result, pendingAfter };
  }, { accountId: one.accountId, dbName, api,
    envelope: serverEnvelope, secret: first.recoverySecret });
  assert.deepEqual(resumed.pendingBefore, first.before);
  assert.deepEqual(resumed.result, { status: 'committed', revisionId: 'rev-two', count: 2 });
  assert.deepEqual(resumed.pendingAfter, []);
  assert.deepEqual(resumed.sent, [
    { body: first.before[0].steps.at(-1).body, key: first.before[0].steps.at(-1).idempotencyKey,
      precondition: '*' },
    { body: first.before[1].steps.at(-1).body, key: first.before[1].steps.at(-1).idempotencyKey,
      precondition: '"rev-one"' },
  ]);
  const head = await fetch(`${api}/v1/cases/case-browser-api`, {
    headers: { Authorization: 'Bearer one' },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('etag'), '"rev-two"');
  assert.equal(await head.text(), first.packageJson);
  await page.reload();
  const conflict = await page.evaluate(async ({ accountId, dbName, api, envelope, secret }) => {
    const { unlockRecovery } = await import('/crypto/keys.js');
    const { openLocalRepository } = await import('/storage/repository.js');
    const { syncCase } = await import('/sync/transport.js');
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
    const remaining = await repoB.prepareSync('case-browser-api');
    repoA.close(); repoB.close();
    return { wrongAccount, winner, loser, remaining };
  }, { accountId: one.accountId, dbName, api,
    envelope: serverEnvelope, secret: first.recoverySecret });
  assert.equal(conflict.wrongAccount.status, 'permanent');
  assert.deepEqual(conflict.winner, { status: 'committed', revisionId: 'rev-three', count: 1 });
  assert.equal(conflict.loser.status, 'conflict');
  assert.equal(conflict.loser.remote.revisionId, 'rev-three');
  assert.equal(conflict.remaining.length, 1);

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
});
