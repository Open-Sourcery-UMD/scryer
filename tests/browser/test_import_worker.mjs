import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../client/build/', import.meta.url)));
const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const browserBinary = process.env.SCRYER_BROWSER_BIN || chromium.executablePath();

test('real browser import worker handles files, failures, cancellation, and source availability', async (t) => {
  assert.ok(existsSync(browserBinary), `BROWSER_UNAVAILABLE: ${browserBinary}`);
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Scryer worker test</title>');
      return;
    }
    const target = resolve(root, `.${pathname}`);
    if (!target.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await readFile(target);
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser = null;
  t.after(async () => {
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  browser = await chromium.launch({ headless: true, executablePath: browserBinary });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);

  await t.test('File extraction is deterministic, source-positioned, and never creates events', async () => {
    const result = await page.evaluate(async () => {
      const { extractBankFile } = await import('/import/browser.js');
      const file = new File(['Date,Amount\n2026-09-08,90.00\n2026-09-08,90.00\n'], 'synthetic.csv');
      const metadata = { accountRefId: 'bank-a', observedAt: '2026-09-09T10:00:00Z' };
      const mapping = { kind: 'signed', dateColumn: 'Date', amountColumn: 'Amount', mappingVersion: 'map-1' };
      const first = await extractBankFile(file, metadata, mapping);
      const second = await extractBankFile(file, metadata, mapping);
      return {
        firstId: first.artifact.artifactId, secondId: second.artifact.artifactId,
        firstProposals: first.proposals, secondProposals: second.proposals,
        sourceBytes: [...first.sourceBytes], eventField: Object.hasOwn(first, 'events'),
      };
    });
    assert.equal(result.firstId, result.secondId);
    assert.deepEqual(result.firstProposals, result.secondProposals);
    assert.equal(result.firstProposals.length, 2);
    assert.notEqual(result.firstProposals[0].proposalId, result.firstProposals[1].proposalId);
    assert.equal(result.eventField, false);
    assert.equal(new TextDecoder().decode(new Uint8Array(result.sourceBytes)), 'Date,Amount\n2026-09-08,90.00\n2026-09-08,90.00\n');
  });

  await t.test('malformed and oversized inputs fail with typed errors', async () => {
    const result = await page.evaluate(async () => {
      const { extractBankFile, detectFile } = await import('/import/browser.js');
      const metadata = { accountRefId: 'bank-a', observedAt: '2026-09-09T10:00:00Z' };
      const mapping = { kind: 'signed', dateColumn: 'Date', amountColumn: 'Amount', mappingVersion: 'map-1' };
      const code = async (action) => { try { await action(); return null; } catch (error) { return error.code; } };
      return {
        malformed: await code(() => extractBankFile(new File(['Date,Amount\n"bad,90.00\n'], 'bad.csv'), metadata, mapping)),
        tooLarge: await code(() => extractBankFile(new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'huge.csv'), metadata, mapping)),
        pdf: await detectFile(new File(['%PDF-1.7\n%%EOF'], 'offer.pdf')),
      };
    });
    assert.equal(result.malformed, 'INVALID_CSV');
    assert.equal(result.tooLarge, 'INPUT_TOO_LARGE');
    assert.deepEqual(result.pdf, { outcome: 'MANUAL_REQUIRED', adapter: null, reasonCode: 'PDF_LAYOUT_UNVERIFIED' });
  });

  await t.test('in-flight cancellation terminates worker and leaves caller state untouched', async () => {
    const result = await page.evaluate(async () => {
      const { extractBankFile } = await import('/import/browser.js');
      const RealWorker = window.Worker;
      let terminations = 0;
      let workerStarted;
      const started = new Promise((resolve) => { workerStarted = resolve; });
      window.Worker = class extends RealWorker {
        constructor(...args) { super(...args); workerStarted(); }
        terminate() { terminations++; return super.terminate(); }
      };
      const caseData = { events: [{ eventId: 'existing' }] };
      const before = JSON.stringify(caseData);
      const controller = new AbortController();
      const bytes = new TextEncoder().encode('Date,Amount\n' + '2026-09-08,90.00\n'.repeat(10_000));
      const promise = extractBankFile(bytes,
        { accountRefId: 'bank-a', observedAt: '2026-09-09T10:00:00Z' },
        { kind: 'signed', dateColumn: 'Date', amountColumn: 'Amount', mappingVersion: 'map-1' },
        { signal: controller.signal });
      await started;
      controller.abort();
      let code = null;
      try { await promise; } catch (error) { code = error.code; }
      window.Worker = RealWorker;
      return { code, terminations, unchanged: JSON.stringify(caseData) === before };
    });
    assert.deepEqual(result, { code: 'CANCELLED', terminations: 1, unchanged: true });
  });

  await t.test('file-read cancellation, worker timeout, and blocked worker creation are typed', async () => {
    const result = await page.evaluate(async () => {
      const { extractBankFile } = await import('/import/browser.js');
      const metadata = { accountRefId: 'bank-a', observedAt: '2026-09-09T10:00:00Z' };
      const mapping = { kind: 'signed', dateColumn: 'Date', amountColumn: 'Amount', mappingVersion: 'map-1' };
      const code = async (action) => { try { await action(); return null; } catch (error) { return error.code; } };
      const readerController = new AbortController();
      const read = code(() => extractBankFile(new File([new Uint8Array(10 * 1024 * 1024)], 'big.csv'),
        metadata, mapping, { signal: readerController.signal }));
      readerController.abort();
      const readCode = await read;

      const RealWorker = window.Worker;
      let terminations = 0;
      window.Worker = class extends RealWorker {
        postMessage() { /* Deliberately stall the worker transport. */ }
        terminate() { terminations++; return super.terminate(); }
      };
      const timeoutCode = await code(() => extractBankFile(new TextEncoder().encode('Date,Amount\n'),
        metadata, mapping, { timeoutMs: 5 }));
      window.Worker = class {
        constructor() { throw new DOMException('blocked by policy', 'SecurityError'); }
      };
      const blockedCode = await code(() => extractBankFile(new TextEncoder().encode('Date,Amount\n'),
        metadata, mapping));
      window.Worker = RealWorker;
      return { readCode, timeoutCode, blockedCode, terminations };
    });
    assert.deepEqual(result, {
      readCode: 'CANCELLED', timeoutCode: 'TIMED_OUT', blockedCode: 'WORKER_FAILURE', terminations: 1,
    });
  });

  await t.test('another-device simulation reports source unavailable until hash-matched reattachment', async () => {
    const result = await page.evaluate(async () => {
      const { sourceAvailability } = await import('/import/source.js');
      const { extractBankFile } = await import('/import/browser.js');
      const bytes = new TextEncoder().encode('Date,Amount\n2026-09-08,90.00\n');
      const batch = await extractBankFile(bytes,
        { accountRefId: 'bank-a', observedAt: '2026-09-09T10:00:00Z' },
        { kind: 'signed', dateColumn: 'Date', amountColumn: 'Amount', mappingVersion: 'map-1' });
      return {
        absent: await sourceAvailability(batch.artifact, null),
        attached: await sourceAvailability(batch.artifact, bytes),
        mismatch: await sourceAvailability(batch.artifact, new TextEncoder().encode('changed')),
      };
    });
    assert.equal(result.absent, 'SOURCE_UNAVAILABLE');
    assert.equal(result.attached, 'AVAILABLE');
    assert.equal(result.mismatch, 'HASH_MISMATCH');
  });
});
