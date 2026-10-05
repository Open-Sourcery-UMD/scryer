import { base64UrlDecode, cryptoApi, exactKeys, utf8Bytes, validId } from '../crypto/codec.ts';
import type { CasePackageV1 } from '../crypto/envelope.ts';
import type { LocalRepository, PreparedSync, SyncStep } from '../storage/repository.ts';

type SyncRepository = Pick<LocalRepository, 'prepareSync' | 'ackSync'> &
  { session: { readonly accountId: string } };

export type ConflictAncestor =
  | { status: 'not_requested' | 'unavailable' }
  | { status: 'available'; revisionId: string; etag: string; ciphertextBody: string };

export type SyncResult =
  | { status: 'idle' }
  | { status: 'committed'; revisionId: string; count: number }
  | { status: 'conflict'; pendingOperationId: string; pendingRevisionId: string;
      pendingManifestDigest: string; pendingExpectedServerRevision: string | null; remote: {
      revisionId: string; etag: string; ciphertextBody: string }; ancestor: ConflictAncestor }
  | { status: 'retryable' | 'permanent' | 'interrupted'; code: string; httpStatus?: number };

export type SyncOptions = {
  baseUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  sleepImpl?: (milliseconds: number) => Promise<void>;
};

type JsonReply = { text: string; value: unknown };
type HttpReply = { response: Response; json?: JsonReply };
type StepContext = { chunkBodies: Array<{ step: SyncStep; wire: Record<string, unknown>; digest: string }>;
  manifestStep: SyncStep; manifest: Record<string, unknown> };

const HEX_256 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,159}$/;
const TOKEN = /^[A-Za-z0-9._~-]{1,8192}$/;
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_HEAD_BYTES = 12 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const HEAD_KEYS = ['schemaVersion', 'format', 'algorithm', 'accountId', 'caseId',
  'revisionId', 'deviceId', 'keyGeneration', 'packageId', 'chunks'] as const;
const HEAD_CHUNK_KEYS = ['index', 'nonce', 'ciphertext', 'tag'] as const;

class SyncFault extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

function origin(value: string): string {
  if (typeof value !== 'string') throw new SyncFault('INVALID_SYNC_ORIGIN');
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new SyncFault('INVALID_SYNC_ORIGIN'); }
  const loopback = parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
  if ((parsed.protocol !== 'https:' && !loopback) || parsed.origin !== value ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new SyncFault('INVALID_SYNC_ORIGIN');
  }
  return parsed.origin;
}

function canonicalObject(source: string, keys: readonly string[]): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new SyncFault('INVALID_SYNC_WIRE'); }
  if (!exactKeys(value, keys) || JSON.stringify(value) !== source) {
    throw new SyncFault('INVALID_SYNC_WIRE');
  }
  return value as Record<string, unknown>;
}

export async function syncBodyDigest(source: string): Promise<string> {
  const bytes = utf8Bytes(source);
  const hash = new Uint8Array(await cryptoApi().subtle.digest('SHA-256', bytes));
  bytes.fill(0);
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function validatePending(item: PreparedSync, accountId: string, caseId: string): Promise<StepContext> {
  if (!item || !validId(item.operationId) || item.caseId !== caseId ||
      !validId(item.revisionId) || !Number.isSafeInteger(item.localSequence) ||
      item.localSequence < 1 || (item.expectedServerRevision !== null &&
      !validId(item.expectedServerRevision)) || !Array.isArray(item.steps) ||
      item.steps.length < 2 || item.steps.length > 9) throw new SyncFault('INVALID_OUTBOX');
  const manifestStep = item.steps.at(-1)!;
  if (manifestStep.kind !== 'manifest' ||
      manifestStep.idempotencyKey !== `${item.operationId}:manifest` ||
      !IDEMPOTENCY_KEY.test(manifestStep.idempotencyKey) ||
      typeof manifestStep.body !== 'string' ||
      utf8Bytes(manifestStep.body).length > 16 * 1024) throw new SyncFault('INVALID_OUTBOX');
  const manifest = canonicalObject(manifestStep.body, [
    'schemaVersion', 'kind', 'format', 'algorithm', 'accountId', 'caseId',
    'revisionId', 'deviceId', 'keyGeneration', 'packageId', 'chunkCount',
    'chunkDigests', 'packageDigest',
  ]);
  const count = item.steps.length - 1;
  if (manifest.schemaVersion !== '1' || manifest.kind !== 'manifest' ||
      manifest.format !== 'scryer-case-v1' ||
      manifest.algorithm !== 'AES-256-GCM+HKDF-SHA-256' ||
      manifest.accountId !== accountId || manifest.caseId !== caseId ||
      manifest.revisionId !== item.revisionId || manifest.chunkCount !== count ||
      !Array.isArray(manifest.chunkDigests) || manifest.chunkDigests.length !== count ||
      !HEX_256.test(String(manifest.packageDigest))) throw new SyncFault('INVALID_OUTBOX');
  try { base64UrlDecode(manifest.packageId, 16, 16); base64UrlDecode(manifest.deviceId, 16, 16); }
  catch { throw new SyncFault('INVALID_OUTBOX'); }
  const chunkBodies: StepContext['chunkBodies'] = [];
  for (let index = 0; index < count; index++) {
    const step = item.steps[index]!;
    if (step.kind !== 'chunk' || step.idempotencyKey !== `${item.operationId}:chunk:${index}` ||
        !IDEMPOTENCY_KEY.test(step.idempotencyKey) || typeof step.body !== 'string' ||
        utf8Bytes(step.body).length > 8 * 1024 * 1024) throw new SyncFault('INVALID_OUTBOX');
    const wire = canonicalObject(step.body, [
      'schemaVersion', 'kind', 'accountId', 'caseId', 'revisionId', 'packageId',
      'index', 'chunkCount', 'nonce', 'ciphertext', 'tag',
    ]);
    if (wire.schemaVersion !== '1' || wire.kind !== 'chunk' ||
        wire.accountId !== accountId || wire.caseId !== caseId ||
        wire.revisionId !== item.revisionId || wire.packageId !== manifest.packageId ||
        wire.index !== index || wire.chunkCount !== count) throw new SyncFault('INVALID_OUTBOX');
    const hash = await syncBodyDigest(step.body);
    if (manifest.chunkDigests[index] !== hash) throw new SyncFault('INVALID_OUTBOX');
    chunkBodies.push({ step, wire, digest: hash });
  }
  return { chunkBodies, manifestStep, manifest };
}

async function readJson(response: Response, limit: number): Promise<JsonReply> {
  if (response.redirected || response.type === 'opaqueredirect' ||
      !/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) {
    throw new SyncFault('INVALID_SYNC_RESPONSE');
  }
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d{1,9}$/.test(declared) || Number(declared) > limit)) {
    throw new SyncFault('INVALID_SYNC_RESPONSE');
  }
  if (!response.body) throw new SyncFault('INVALID_SYNC_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      size += read.value.byteLength;
      if (size > limit) throw new SyncFault('INVALID_SYNC_RESPONSE');
      chunks.push(read.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  let text: string;
  let value: unknown;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(text); }
  catch { throw new SyncFault('INVALID_SYNC_RESPONSE'); }
  if (JSON.stringify(value) !== text) throw new SyncFault('INVALID_SYNC_RESPONSE');
  return { text, value };
}

function jsonObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!exactKeys(value, keys)) throw new SyncFault('INVALID_SYNC_RESPONSE');
  return value as Record<string, unknown>;
}

function statusResult(status: number): SyncResult {
  if (status === 401) return { status: 'permanent', code: 'INVALID_TOKEN', httpStatus: status };
  if (status === 403) return { status: 'permanent', code: 'ACCOUNT_DISABLED', httpStatus: status };
  if (status === 409) return { status: 'permanent', code: 'SYNC_CONFLICT', httpStatus: status };
  if (status === 413) return { status: 'permanent', code: 'SYNC_TOO_LARGE', httpStatus: status };
  return { status: 'permanent', code: 'SYNC_HTTP_FAILURE', httpStatus: status };
}

async function request(url: string, init: RequestInit, options: SyncOptions,
                       responseLimit: number): Promise<HttpReply | SyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? ((milliseconds: number) => new Promise<void>((resolve) =>
    setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (options.signal?.aborted) return { status: 'interrupted', code: 'SYNC_ABORTED' };
    let response: Response;
    try { response = await fetchImpl(url, init); }
    catch (error) {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return { status: 'interrupted', code: 'SYNC_ABORTED' };
      }
      if (!(error instanceof TypeError) &&
          !(error instanceof DOMException && error.name === 'NetworkError')) {
        return { status: 'permanent', code: 'SYNC_TRANSPORT_FAILURE' };
      }
      if (attempt === MAX_ATTEMPTS - 1) return { status: 'retryable', code: 'SYNC_NETWORK' };
      await sleep(100 * 2 ** attempt + Math.floor(Math.random() * 100));
      continue;
    }
    if (response.status !== 429 && response.status !== 503) {
      if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
        return { response };
      }
      try { return { response, json: await readJson(response, responseLimit) }; }
      catch (error) {
        if (options.signal?.aborted || (error instanceof DOMException &&
            error.name === 'AbortError')) {
          return { status: 'interrupted', code: 'SYNC_ABORTED' };
        }
        if (!(error instanceof TypeError) &&
            !(error instanceof DOMException && error.name === 'NetworkError')) {
          return { status: 'permanent', code: 'INVALID_SYNC_RESPONSE' };
        }
        if (attempt === MAX_ATTEMPTS - 1) return { status: 'retryable', code: 'SYNC_NETWORK' };
        await sleep(100 * 2 ** attempt + Math.floor(Math.random() * 100));
        continue;
      }
    }
    if (attempt === MAX_ATTEMPTS - 1) {
      return { status: 'retryable', code: response.status === 429 ? 'SYNC_RATE_LIMIT' :
        'SYNC_UNAVAILABLE', httpStatus: response.status };
    }
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter && /^\d{1,2}$/.test(retryAfter) ? Number(retryAfter) : 0;
    await sleep(Math.min(5000,
      Math.max(100 * 2 ** attempt, seconds * 1000) + Math.floor(Math.random() * 100)));
  }
  return { status: 'retryable', code: 'SYNC_NETWORK' };
}

function isResult(value: HttpReply | SyncResult): value is SyncResult {
  return 'status' in value;
}

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

function init(method: string, token: string, signal?: AbortSignal,
              extra: Record<string, string> = {}, body?: string): RequestInit {
  return { method, headers: headers(token, extra), ...(body === undefined ? {} : { body }),
    ...(signal ? { signal } : {}), credentials: 'omit', redirect: 'error',
    cache: 'no-store', referrerPolicy: 'no-referrer' };
}

function validatedHead(value: unknown, accountId: string, caseId: string): CasePackageV1 {
  const item = jsonObject(value, HEAD_KEYS);
  if (Object.keys(item).join(',') !== HEAD_KEYS.join(',')) {
    throw new SyncFault('INVALID_SYNC_RESPONSE');
  }
  if (item.schemaVersion !== '1' || item.format !== 'scryer-case-v1' ||
      item.algorithm !== 'AES-256-GCM+HKDF-SHA-256' || item.accountId !== accountId ||
      item.caseId !== caseId || !validId(item.revisionId) ||
      !Number.isSafeInteger(item.keyGeneration) || Number(item.keyGeneration) < 1 ||
      !Array.isArray(item.chunks) || item.chunks.length < 1 || item.chunks.length > 8) {
    throw new SyncFault('INVALID_SYNC_RESPONSE');
  }
  try {
    base64UrlDecode(item.deviceId, 16, 16);
    base64UrlDecode(item.packageId, 16, 16);
    for (let index = 0; index < item.chunks.length; index++) {
      const chunk = jsonObject(item.chunks[index], HEAD_CHUNK_KEYS);
      if (Object.keys(chunk).join(',') !== HEAD_CHUNK_KEYS.join(',') ||
          chunk.index !== index) throw new SyncFault('INVALID_SYNC_RESPONSE');
      base64UrlDecode(chunk.nonce, 12, 12);
      if (base64UrlDecode(chunk.ciphertext).length < 1) throw new SyncFault('INVALID_SYNC_RESPONSE');
      base64UrlDecode(chunk.tag, 16, 16);
    }
  } catch { throw new SyncFault('INVALID_SYNC_RESPONSE'); }
  return item as CasePackageV1;
}

export async function syncCase(repo: SyncRepository, caseId: string,
                               options: SyncOptions): Promise<SyncResult> {
  let baseUrl: string;
  try {
    baseUrl = origin(options?.baseUrl);
    if (!validId(caseId) || !validId(repo?.session?.accountId) ||
        !TOKEN.test(options.accessToken)) throw new SyncFault('INVALID_SYNC_CONFIG');
  } catch (error) {
    return { status: 'permanent', code: error instanceof SyncFault ? error.code : 'INVALID_SYNC_CONFIG' };
  }
  const first = await repo.prepareSync(caseId);
  if (!first.length) return { status: 'idle' };
  const account = await request(`${baseUrl}/v1/account`, init('GET', options.accessToken,
    options.signal), options, MAX_RECEIPT_BYTES);
  if (isResult(account)) return account;
  if (account.response.status !== 200) return statusResult(account.response.status);
  try {
    const body = jsonObject(account.json!.value,
      ['accountId', 'status', 'usedBytes', 'quotaBytes', 'capabilities']);
    if (body.accountId !== repo.session.accountId || body.status !== 'active' ||
        !Number.isSafeInteger(body.usedBytes) || Number(body.usedBytes) < 0 ||
        !Number.isSafeInteger(body.quotaBytes) || Number(body.quotaBytes) < 1 ||
        Number(body.usedBytes) > Number(body.quotaBytes) ||
        !Array.isArray(body.capabilities) ||
        !body.capabilities.includes('ciphertext-sync-v1')) throw new SyncFault('WRONG_SYNC_ACCOUNT');
  } catch (error) {
    return { status: 'permanent', code: error instanceof SyncFault ? error.code :
      'INVALID_SYNC_RESPONSE' };
  }
  let count = 0;
  let lastRevisionId = '';
  const seen = new Set<string>();
  const registeredDevices = new Set<string>();
  while (count < 100) {
    const pending = await repo.prepareSync(caseId);
    if (!pending.length) return count ? { status: 'committed', revisionId: lastRevisionId, count } :
      { status: 'idle' };
    const item = pending[0]!;
    if (seen.has(item.operationId)) return { status: 'permanent', code: 'INVALID_OUTBOX' };
    seen.add(item.operationId);
    let prepared: StepContext;
    try { prepared = await validatePending(item, repo.session.accountId, caseId); }
    catch { return { status: 'permanent', code: 'INVALID_OUTBOX' }; }
    const deviceId = prepared.manifest.deviceId as string;
    if (!registeredDevices.has(deviceId)) {
      const deviceBody = JSON.stringify({ schemaVersion: '1', deviceId });
      const device = await request(`${baseUrl}/v1/account/devices`,
        init('POST', options.accessToken, options.signal,
          { 'Content-Type': 'application/json', 'Idempotency-Key': `device:${deviceId}` },
          deviceBody), options, MAX_RECEIPT_BYTES);
      if (isResult(device)) return device;
      if (device.response.status !== 200) return statusResult(device.response.status);
      try {
        const receipt = jsonObject(device.json!.value, ['kind', 'deviceId', 'status']);
        if (receipt.kind !== 'device' || receipt.deviceId !== deviceId ||
            receipt.status !== 'active') throw new SyncFault('INVALID_SYNC_RESPONSE');
      } catch { return { status: 'permanent', code: 'INVALID_SYNC_RESPONSE' }; }
      registeredDevices.add(deviceId);
    }
    const path = `${baseUrl}/v1/cases/${caseId}`;
    for (const { step, wire, digest: chunkDigest } of prepared.chunkBodies) {
      const response = await request(`${path}/chunks`, init('POST', options.accessToken,
        options.signal, { 'Content-Type': 'application/json',
          'Idempotency-Key': step.idempotencyKey }, step.body), options, MAX_RECEIPT_BYTES);
      if (isResult(response)) return response;
      if (response.response.status !== 202) return statusResult(response.response.status);
      try {
        const receipt = jsonObject(response.json!.value,
          ['kind', 'caseId', 'revisionId', 'packageId', 'index', 'digest']);
        if (receipt.kind !== 'chunk' || receipt.caseId !== caseId ||
            receipt.revisionId !== item.revisionId || receipt.packageId !== wire.packageId ||
            receipt.index !== wire.index || receipt.digest !== chunkDigest) {
          throw new SyncFault('INVALID_SYNC_RESPONSE');
        }
      } catch { return { status: 'permanent', code: 'INVALID_SYNC_RESPONSE' }; }
    }
    const creating = item.expectedServerRevision === null;
    const precondition = creating ? { 'If-None-Match': '*' } :
      { 'If-Match': `"${item.expectedServerRevision}"` };
    const response = await request(`${path}/revisions`, init('POST', options.accessToken,
      options.signal, { 'Content-Type': 'application/json',
        'Idempotency-Key': prepared.manifestStep.idempotencyKey, ...precondition },
      prepared.manifestStep.body), options, MAX_RECEIPT_BYTES);
    if (isResult(response)) return response;
    if (response.response.status === 412) {
      const head = await request(path, init('GET', options.accessToken, options.signal),
        options, MAX_HEAD_BYTES);
      if (isResult(head)) return head;
      if (head.response.status !== 200) return statusResult(head.response.status);
      let remote: CasePackageV1;
      let etag: string;
      try {
        const read = head.json!;
        remote = validatedHead(read.value, repo.session.accountId, caseId);
        etag = `"${remote.revisionId}"`;
        if (head.response.headers.get('etag') !== etag) throw new SyncFault('INVALID_SYNC_RESPONSE');
      } catch { return { status: 'permanent', code: 'INVALID_SYNC_RESPONSE' }; }
      let ancestor: ConflictAncestor = { status: 'not_requested' };
      if (item.expectedServerRevision !== null) {
        const historical = await request(`${path}/revisions/${item.expectedServerRevision}`,
          init('GET', options.accessToken, options.signal), options, MAX_HEAD_BYTES);
        if (isResult(historical)) return historical;
        if (historical.response.status === 404) ancestor = { status: 'unavailable' };
        else if (historical.response.status !== 200) return statusResult(historical.response.status);
        else {
          try {
            const candidate = validatedHead(historical.json!.value,
              repo.session.accountId, caseId);
            const historicalEtag = `"${item.expectedServerRevision}"`;
            if (candidate.revisionId !== item.expectedServerRevision ||
                historical.response.headers.get('etag') !== historicalEtag) {
              throw new SyncFault('INVALID_SYNC_RESPONSE');
            }
            ancestor = { status: 'available', revisionId: candidate.revisionId,
              etag: historicalEtag, ciphertextBody: historical.json!.text };
          } catch { return { status: 'permanent', code: 'INVALID_SYNC_RESPONSE' }; }
        }
      }
      return { status: 'conflict', pendingOperationId: item.operationId,
        pendingRevisionId: item.revisionId,
        pendingManifestDigest: await syncBodyDigest(prepared.manifestStep.body),
        pendingExpectedServerRevision: item.expectedServerRevision,
        remote: { revisionId: remote.revisionId, etag,
          ciphertextBody: head.json!.text }, ancestor };
    }
    if (response.response.status !== (creating ? 201 : 200)) {
      return statusResult(response.response.status);
    }
    try {
      const receipt = jsonObject(response.json!.value,
        ['kind', 'caseId', 'revisionId', 'packageDigest', 'etag']);
      const etag = `"${item.revisionId}"`;
      if (receipt.kind !== 'manifest' || receipt.caseId !== caseId ||
          receipt.revisionId !== item.revisionId ||
          receipt.packageDigest !== prepared.manifest.packageDigest ||
          receipt.etag !== etag || response.response.headers.get('etag') !== etag) {
        throw new SyncFault('INVALID_SYNC_RESPONSE');
      }
    } catch { return { status: 'permanent', code: 'INVALID_SYNC_RESPONSE' }; }
    await repo.ackSync(item.operationId, item.revisionId);
    lastRevisionId = item.revisionId;
    count++;
  }
  return { status: 'retryable', code: 'SYNC_CONTINUE' };
}
