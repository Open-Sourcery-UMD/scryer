import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { syncCase } from '../../client/sync/transport.ts';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

function operation(number, expectedServerRevision = null) {
  const accountId = 'acct-unit';
  const caseId = 'case-unit';
  const revisionId = `rev-${number}`;
  const operationId = `op-${number}`;
  const packageId = Buffer.alloc(16, number).toString('base64url');
  const chunk = { schemaVersion: '1', kind: 'chunk', accountId, caseId, revisionId,
    packageId, index: 0, chunkCount: 1,
    nonce: Buffer.alloc(12, number).toString('base64url'),
    ciphertext: Buffer.from(`synthetic-${number}`).toString('base64url'),
    tag: Buffer.alloc(16, number + 1).toString('base64url') };
  const chunkBody = JSON.stringify(chunk);
  const manifest = { schemaVersion: '1', kind: 'manifest', format: 'scryer-case-v1',
    algorithm: 'AES-256-GCM+HKDF-SHA-256', accountId, caseId, revisionId,
    deviceId: Buffer.alloc(16, 9).toString('base64url'), keyGeneration: 1,
    packageId, chunkCount: 1, chunkDigests: [sha(chunkBody)],
    packageDigest: sha(`package-${number}`) };
  return { operationId, caseId, revisionId, expectedServerRevision,
    localSequence: number, steps: [
      { kind: 'chunk', idempotencyKey: `${operationId}:chunk:0`, body: chunkBody },
      { kind: 'manifest', idempotencyKey: `${operationId}:manifest`, body: JSON.stringify(manifest) },
    ] };
}

function repository(operations = [operation(1)]) {
  const queue = structuredClone(operations);
  const acknowledgments = [];
  return { session: { accountId: 'acct-unit' }, queue, acknowledgments,
    async prepareSync(caseId) {
      assert.equal(caseId, 'case-unit');
      return structuredClone(queue);
    },
    async ackSync(operationId, confirmedRevisionId) {
      assert.equal(queue[0]?.operationId, operationId);
      assert.equal(queue[0]?.revisionId, confirmedRevisionId);
      queue.shift();
      if (queue[0]) queue[0].expectedServerRevision = confirmedRevisionId;
      acknowledgments.push([operationId, confirmedRevisionId]);
    } };
}

function successFetch(repo, requests, transform = (_kind, response) => response) {
  return async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/v1/account')) return transform('account', json({ accountId: repo.session.accountId,
      status: 'active', usedBytes: 0, quotaBytes: 268435456,
      capabilities: ['ciphertext-sync-v1'] }));
    const saved = JSON.parse(init.body);
    if (saved.kind === 'chunk') return transform('chunk', json({ kind: 'chunk',
      caseId: saved.caseId, revisionId: saved.revisionId, packageId: saved.packageId,
      index: saved.index, digest: sha(init.body) }, 202));
    const etag = `"${saved.revisionId}"`;
    return transform('manifest', json({ kind: 'manifest', caseId: saved.caseId,
      revisionId: saved.revisionId, packageDigest: saved.packageDigest, etag },
    init.headers['If-None-Match'] === '*' ? 201 : 200, { ETag: etag }));
  };
}

test('two offline revisions send exact saved bytes with durable create then update preconditions', async () => {
  const repo = repository([operation(1), operation(2)]);
  const requests = [];
  const result = await syncCase(repo, 'case-unit', { baseUrl: 'http://127.0.0.1:8081',
    accessToken: 'unit-token', fetchImpl: successFetch(repo, requests) });
  assert.deepEqual(result, { status: 'committed', revisionId: 'rev-2', count: 2 });
  assert.deepEqual(repo.acknowledgments, [['op-1', 'rev-1'], ['op-2', 'rev-2']]);
  assert.equal(requests.length, 5);
  for (const request of requests) {
    assert.equal(request.init.headers.Authorization, 'Bearer unit-token');
    assert.equal(request.init.credentials, 'omit');
    assert.equal(request.init.redirect, 'error');
    assert.equal(request.init.cache, 'no-store');
  }
  assert.equal(requests[1].init.body, operation(1).steps[0].body);
  assert.equal(requests[2].init.body, operation(1).steps[1].body);
  assert.equal(requests[3].init.body, operation(2).steps[0].body);
  assert.equal(requests[4].init.body, operation(2).steps[1].body);
  assert.equal(requests[2].init.headers['If-None-Match'], '*');
  assert.equal(requests[4].init.headers['If-Match'], '"rev-1"');
});

test('wrong account and malformed manifest receipt preserve the outbox', async () => {
  const repo = repository();
  const requests = [];
  const wrongAccount = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
    accessToken: 'unit-token', fetchImpl: successFetch(repo, requests, (kind, response) =>
      kind === 'account' ? json({ accountId: 'acct-other', status: 'active', usedBytes: 0,
        quotaBytes: 268435456, capabilities: ['ciphertext-sync-v1'] }) : response) });
  assert.equal(wrongAccount.status, 'permanent');
  assert.equal(requests.length, 1);
  const malformed = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
    accessToken: 'unit-token', fetchImpl: successFetch(repo, [], (kind, response) =>
      kind === 'manifest' ? json({ kind: 'manifest', caseId: 'case-unit', revisionId: 'rev-wrong',
        packageDigest: 'a'.repeat(64), etag: '"rev-wrong"' }, 201,
      { ETag: '"rev-wrong"' }) : response) });
  assert.equal(malformed.status, 'permanent');
  assert.deepEqual(repo.acknowledgments, []);
  assert.equal(repo.queue.length, 1);
});

test('stale precondition returns encrypted remote head without dropping the local branch', async () => {
  const repo = repository();
  const remote = { schemaVersion: '1', format: 'scryer-case-v1',
    algorithm: 'AES-256-GCM+HKDF-SHA-256', accountId: 'acct-unit', caseId: 'case-unit',
    revisionId: 'rev-remote', deviceId: Buffer.alloc(16, 9).toString('base64url'),
    keyGeneration: 1, packageId: Buffer.alloc(16, 7).toString('base64url'),
    chunks: [{ index: 0, nonce: Buffer.alloc(12, 8).toString('base64url'),
      ciphertext: Buffer.from('synthetic').toString('base64url'),
      tag: Buffer.alloc(16, 4).toString('base64url') }] };
  const fetchImpl = async (url, init) => {
    if (init.method === 'GET' && url.endsWith('/v1/cases/case-unit')) {
      return json(remote, 200, { ETag: '"rev-remote"' });
    }
    return successFetch(repo, [], (kind, response) => kind === 'manifest' ?
      json({ error: { code: 'STALE_REVISION', requestId: 'req-1' } }, 412) : response)(url, init);
  };
  const result = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
    accessToken: 'unit-token', fetchImpl });
  assert.equal(result.status, 'conflict');
  assert.equal(result.remote.revisionId, 'rev-remote');
  assert.equal(result.remote.ciphertextBody, JSON.stringify(remote));
  assert.deepEqual(repo.acknowledgments, []);
  assert.equal(repo.queue.length, 1);
});

test('only transport failures and 503 retry; 401 stops immediately', async () => {
  const repo = repository();
  const waits = [];
  let attempts = 0;
  const retry = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
    accessToken: 'unit-token', sleepImpl: async (ms) => { waits.push(ms); },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/v1/account')) return successFetch(repo, [])(url, init);
      attempts++;
      if (attempts === 1) throw new TypeError('connection lost');
      return json({ error: { code: 'STORAGE_UNAVAILABLE', requestId: 'req-1' } }, 503,
        { 'Retry-After': '1' });
    } });
  assert.equal(retry.status, 'retryable');
  assert.equal(attempts, 3);
  assert.equal(waits.length, 2);
  assert.deepEqual(repo.acknowledgments, []);
  let unauthorizedRequests = 0;
  const unauthorized = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
    accessToken: 'unit-token', fetchImpl: async () => {
      unauthorizedRequests++;
      return json({ error: { code: 'INVALID_TOKEN', requestId: 'req-2' } }, 401);
    } });
  assert.equal(unauthorized.status, 'permanent');
  assert.equal(unauthorizedRequests, 1);
});

test('lost manifest response retries identical bytes and key before a single acknowledgment', async () => {
  const repo = repository();
  const saved = operation(1).steps[1];
  const manifestAttempts = [];
  const normal = successFetch(repo, []);
  const result = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
    accessToken: 'unit-token', sleepImpl: async () => {}, fetchImpl: async (url, init) => {
      if (url.endsWith('/revisions')) {
        manifestAttempts.push({ body: init.body, key: init.headers['Idempotency-Key'],
          precondition: init.headers['If-None-Match'] });
        if (manifestAttempts.length === 1) throw new TypeError('response lost after commit');
      }
      return normal(url, init);
    } });
  assert.equal(result.status, 'committed');
  assert.deepEqual(manifestAttempts, [
    { body: saved.body, key: saved.idempotencyKey, precondition: '*' },
    { body: saved.body, key: saved.idempotencyKey, precondition: '*' },
  ]);
  assert.deepEqual(repo.acknowledgments, [['op-1', 'rev-1']]);
});

test('response body stream failure retries the exact manifest request', async () => {
  const repo = repository();
  const attempts = [];
  const normal = successFetch(repo, []);
  const result = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
    accessToken: 'unit-token', sleepImpl: async () => {}, fetchImpl: async (url, init) => {
      if (url.endsWith('/revisions')) {
        attempts.push({ body: init.body, key: init.headers['Idempotency-Key'] });
        if (attempts.length === 1) return new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError('body connection lost')); },
        }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }
      return normal(url, init);
    } });
  assert.equal(result.status, 'committed');
  assert.deepEqual(attempts, [
    { body: operation(1).steps[1].body, key: 'op-1:manifest' },
    { body: operation(1).steps[1].body, key: 'op-1:manifest' },
  ]);
  assert.deepEqual(repo.acknowledgments, [['op-1', 'rev-1']]);
});

test('account and chunk body-stream faults retry; body abort interrupts without acknowledgment', async () => {
  for (const failedKind of ['account', 'chunk']) {
    const repo = repository();
    let failures = 0;
    const result = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
      accessToken: 'unit-token', sleepImpl: async () => {},
      fetchImpl: successFetch(repo, [], (kind, response) => {
        if (kind !== failedKind || failures++ !== 0) return response;
        return new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError('body connection lost')); },
        }), { status: kind === 'account' ? 200 : 202,
          headers: { 'Content-Type': 'application/json' } });
      }) });
    assert.equal(result.status, 'committed');
    assert.equal(failures, 2);
  }
  const repo = repository();
  let calls = 0;
  const result = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
    accessToken: 'unit-token', fetchImpl: async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) { controller.error(new DOMException('aborted', 'AbortError')); },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } });
  assert.equal(result.status, 'interrupted');
  assert.equal(calls, 1);
  assert.deepEqual(repo.acknowledgments, []);
});

test('permanent HTTP conflicts and invalid ETag stop without acknowledgment', async () => {
  for (const status of [409, 413]) {
    const repo = repository();
    let manifests = 0;
    const result = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
      accessToken: 'unit-token', fetchImpl: successFetch(repo, [], (kind, response) => {
        if (kind === 'manifest') {
          manifests++;
          return json({ error: { code: 'TEST', requestId: 'req-1' } }, status);
        }
        return response;
      }) });
    assert.equal(result.status, 'permanent');
    assert.equal(manifests, 1);
    assert.deepEqual(repo.acknowledgments, []);
  }
  const repo = repository();
  const wrongTag = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
    accessToken: 'unit-token', fetchImpl: successFetch(repo, [], (kind, response) =>
      kind === 'manifest' ? json({ kind: 'manifest', caseId: 'case-unit',
        revisionId: 'rev-1', packageDigest: sha('package-1'), etag: '"rev-1"' },
      201, { ETag: '"rev-forged"' }) : response) });
  assert.equal(wrongTag.status, 'permanent');
  assert.deepEqual(repo.acknowledgments, []);
});

test('429 retries are bounded and tampered saved chunk is never transmitted', async () => {
  const repo = repository();
  let calls = 0;
  const waits = [];
  const rateLimited = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
    accessToken: 'unit-token', sleepImpl: async (ms) => { waits.push(ms); },
    fetchImpl: async () => {
      calls++;
      return json({ error: { code: 'RATE_LIMITED', requestId: 'req-1' } }, 429,
        { 'Retry-After': '99' });
    } });
  assert.equal(rateLimited.status, 'retryable');
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits.every((ms) => ms <= 5000));
  repo.queue[0].steps[0].body = repo.queue[0].steps[0].body.replace('"index":0', '"index":1');
  let mutationCalls = 0;
  const refused = await syncCase(repo, 'case-unit', { baseUrl: 'https://api.example.test',
    accessToken: 'unit-token', fetchImpl: async (url, init) => {
      mutationCalls++;
      if (!url.endsWith('/v1/account')) throw new Error('mutated outbox was sent');
      return successFetch(repo, [])(url, init);
    } });
  assert.equal(refused.status, 'permanent');
  assert.equal(mutationCalls, 1);
  assert.deepEqual(repo.acknowledgments, []);
});

test('unsafe origins are refused before any network call', async () => {
  const repo = repository();
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('should not fetch'); };
  for (const baseUrl of ['http://example.test', 'http://localhost:8080',
    'https://api.example.test/path', 'https://user:pass@api.example.test']) {
    const result = await syncCase(repo, 'case-unit', { baseUrl, accessToken: 'unit-token', fetchImpl });
    assert.equal(result.status, 'permanent');
  }
  assert.equal(calls, 0);
});
