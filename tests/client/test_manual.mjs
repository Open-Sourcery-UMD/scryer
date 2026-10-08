import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { detectSource } from '../../client/import/detect.ts';
import { manualCorrection, manualFact } from '../../client/import/manual.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const binary = join(root, 'engine', 'build', 'scryer-native');
const originalCase = () => JSON.parse(readFileSync(new URL('../reference/fixtures/golden-case.json', import.meta.url), 'utf8'));
const encode = (text) => new TextEncoder().encode(text);
const base = { recordedAt: '2026-09-10T10:00:00Z', baseHead: 'event-bank-credit' };

async function nativeValidate(value) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ schemaVersion: '1', operation: 'validate', case: value }),
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(JSON.parse(result.stderr).error.code);
}

async function codeOf(action) {
  try { await action(); return null; } catch (error) { return error.code ?? error.message; }
}

function manualInput(overrides = {}) {
  return {
    ...base, eventId: 'manual-event-1', factId: 'manual-fact-1', reviewId: 'manual-review-1',
    sourceEntryId: 'manual-entry-1', role: 'school_credit', termId: '2026-fall',
    accountRefId: 'school-a', recipientKind: null, amountMinor: '12500',
    effectiveDate: '2026-09-08', ...overrides,
  };
}

test('manual school, refund, and bank facts are explicit user assertions validated by native case parser', async () => {
  const original = originalCase();
  const before = JSON.stringify(original);
  const school = await manualFact(original, manualInput(), nativeValidate);
  assert.equal(JSON.stringify(original), before);
  assert.equal(school.events.at(-1).fact.source.kind, 'manual');
  assert.equal(school.events.at(-1).fact.source.entryId, 'manual-entry-1');
  assert.equal(school.events.at(-1).fact.proposalId, null);
  assert.equal(school.events.at(-1).fact.amountMinor, '12500');
  const refund = await manualFact(school, manualInput({
    eventId: 'manual-event-2', factId: 'manual-fact-2', reviewId: 'manual-review-2',
    sourceEntryId: 'manual-entry-2', baseHead: 'manual-event-1',
    recordedAt: '2026-09-11T10:00:00Z', role: 'refund_issued', recipientKind: 'student',
    amountMinor: '90000',
  }), nativeValidate);
  const bank = await manualFact(refund, manualInput({
    eventId: 'manual-event-3', factId: 'manual-fact-3', reviewId: 'manual-review-3',
    sourceEntryId: 'manual-entry-3', baseHead: 'manual-event-2',
    recordedAt: '2026-09-12T10:00:00Z', role: 'bank_credit_observed',
    termId: null, accountRefId: 'bank-a', recipientKind: null, amountMinor: '90000',
  }), nativeValidate);
  assert.equal(bank.events.at(-1).fact.role, 'bank_credit_observed');
  assert.deepEqual(bank.events.slice(-3).map((event) => event.parents),
    [['event-bank-credit'], ['manual-event-1'], ['manual-event-2']]);
  await nativeValidate(bank);
});

test('manual correction is an immutable reviewed event; invalid correction remains atomic', async () => {
  const first = await manualFact(originalCase(), manualInput(), nativeValidate);
  const command = {
    eventId: 'manual-correction-1', reviewId: 'manual-correction-review-1',
    sourceEntryId: 'manual-correction-entry-1', factId: 'manual-fact-1',
    recordedAt: '2026-09-11T10:00:00Z', baseHead: 'manual-event-1',
    cancelled: false, replacementAmountMinor: '12000',
  };
  const before = JSON.stringify(first);
  const corrected = await manualCorrection(first, command, nativeValidate);
  assert.equal(JSON.stringify(first), before);
  assert.deepEqual(corrected.events.at(-1).correction, {
    factId: 'manual-fact-1', replacementAmountMinor: '12000', cancelled: false,
    source: { kind: 'manual', entryId: 'manual-correction-entry-1' },
    reviewId: 'manual-correction-review-1',
  });
  const cancelled = await manualCorrection(corrected, {
    ...command, eventId: 'manual-correction-2', reviewId: 'manual-correction-review-2',
    sourceEntryId: 'manual-correction-entry-2', recordedAt: '2026-09-12T10:00:00Z',
    baseHead: 'manual-correction-1', cancelled: true, replacementAmountMinor: null,
  }, nativeValidate);
  await nativeValidate(cancelled);
  assert.equal(await codeOf(() => manualCorrection(first, { ...command, cancelled: true }, nativeValidate)), 'INVALID_MANUAL_CORRECTION');
  assert.equal(await codeOf(() => manualCorrection(first, { ...command, factId: 'missing' }, nativeValidate)), 'MISSING_FACT');
  assert.equal(JSON.stringify(first), before);
});

test('manual commands reject invalid amounts, roles, heads, IDs, and validator failures', async () => {
  const original = originalCase();
  const before = JSON.stringify(original);
  assert.equal(await codeOf(() => manualFact(original, manualInput({ amountMinor: '12.50' }), nativeValidate)), 'INVALID_MONEY');
  assert.equal(await codeOf(() => manualFact(original, manualInput({ amountMinor: '0' }), nativeValidate)), 'INVALID_MONEY');
  assert.equal(await codeOf(() => manualFact(original, manualInput({ role: 'aid_gross_disbursement' }), nativeValidate)), 'UNSUPPORTED_MANUAL_ROLE');
  assert.equal(await codeOf(() => manualFact(original, manualInput({ eventId: 'bad id' }), nativeValidate)), 'INVALID_MANUAL_FACT');
  assert.equal(await codeOf(() => manualFact(original, manualInput({ eventId: 123 }), nativeValidate)), 'INVALID_MANUAL_FACT');
  assert.equal(await codeOf(() => manualFact(original, manualInput({ termId: 123 }), nativeValidate)), 'INVALID_MANUAL_FACT');
  assert.equal(await codeOf(() => manualFact(original, manualInput({ baseHead: 'event-extra-charge' }), nativeValidate)), 'STALE_HEAD');
  assert.equal(await codeOf(() => manualFact(original, manualInput({ recipientKind: 'parent', role: 'school_credit' }), nativeValidate)), 'INVALID_MANUAL_FACT');
  assert.equal(await codeOf(() => manualFact(original, manualInput({ role: 'refund_issued', recipientKind: null }), nativeValidate)), 'INVALID_MANUAL_FACT');
  assert.equal(await codeOf(() => manualFact(original, manualInput({ role: 'bank_credit_observed', termId: '2026-fall' }), nativeValidate)), 'INVALID_MANUAL_FACT');
  assert.equal(await codeOf(() => manualFact(original, manualInput({ accountRefId: 'missing-account' }), nativeValidate)), 'MISSING_ACCOUNT');
  assert.equal(await codeOf(() => manualFact(original, manualInput(), async () => { throw new Error('VALIDATOR_REJECTED'); })), 'VALIDATOR_REJECTED');
  assert.equal(JSON.stringify(original), before);
});

test('format detection routes CSV to explicit mapping and every PDF to manual review', () => {
  const csv = detectSource(encode('Date,Amount\n2026-09-08,90.00\n'));
  assert.deepEqual(csv, { outcome: 'SUPPORTED_CSV', adapter: 'generic-bank-csv-1', reasonCode: 'MAPPING_REQUIRED' });
  assert.equal(detectSource(encode('Date,Amount\n')).outcome, 'SUPPORTED_CSV');
  for (const body of [
    '%PDF-1.7\n1 0 obj <</Encrypt 2 0 R>> endobj\n%%EOF',
    '%PDF-1.7\n1 0 obj <</Subtype /Image>> endobj\n%%EOF',
    '%PDF-1.7\n1 0 obj <</Contents 2 0 R>> endobj\n%%EOF',
  ]) {
    assert.deepEqual(detectSource(encode(body)), {
      outcome: 'MANUAL_REQUIRED', adapter: null, reasonCode: 'PDF_LAYOUT_UNVERIFIED',
    });
  }
  assert.deepEqual(detectSource(encode('Date,Amount\n"unfinished,12.00\n')).outcome, 'UNSUPPORTED_INPUT');
  assert.deepEqual(detectSource(new Uint8Array([0xff, 0x00])).outcome, 'UNSUPPORTED_INPUT');
  assert.deepEqual(detectSource(new Uint8Array(20 * 1024 * 1024 + 1)).reasonCode, 'INPUT_TOO_LARGE');
});
