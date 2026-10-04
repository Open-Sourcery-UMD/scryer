import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractBankCsv } from '../../client/import/bank.ts';

const encode = (text) => new TextEncoder().encode(text);
const metadata = { accountRefId: 'bank-a', observedAt: '2026-09-09T10:00:00Z' };
const signed = { kind: 'signed', dateColumn: 'Date', amountColumn: 'Amount', mappingVersion: 'map-1' };

function codeOf(action) {
  return action().then(() => null, (error) => error.code);
}

test('quoted newline and comma preserve logical source positions and equal-row multiplicity', async () => {
  const bytes = encode('\uFEFFDate,Amount,Description\r\n2026-09-06,"1,000.25","Refund,\nissued ""today"""\r\n2026-09-06,"1,000.25",second\r\n');
  const first = await extractBankCsv(bytes, metadata, signed);
  const second = await extractBankCsv(bytes, metadata, signed);
  assert.equal(first.artifact.kind, 'bank_transactions');
  assert.equal(first.artifact.accountRefId, 'bank-a');
  assert.equal(first.artifact.sha256.length, 64);
  assert.equal(first.artifact.artifactId, second.artifact.artifactId);
  assert.deepEqual(first.proposals.map((item) => item.sourceLocation), ['row:2:col:2', 'row:3:col:2']);
  assert.notEqual(first.proposals[0].proposalId, first.proposals[1].proposalId);
  assert.deepEqual(first.proposals.map((item) => item.proposedAmountMinor), ['100025', '100025']);
  assert.equal(first.candidates[0].rawFields[2], 'Refund,\nissued "today"');
  assert.deepEqual(first.candidates.map((item) => item.direction), ['credit', 'credit']);
  assert.equal(Object.hasOwn(first, 'coverage'), false);
  const otherAccount = await extractBankCsv(bytes, { ...metadata, accountRefId: 'bank-b' }, signed);
  assert.equal(otherAccount.artifact.sha256, first.artifact.sha256);
  assert.notEqual(otherAccount.artifact.artifactId, first.artifact.artifactId);
  bytes[0] = 88;
  assert.equal(first.sourceBytes[0], 0xef);
});

test('debits, zero, bad cents, and bad dates remain unresolved proposals', async () => {
  const bytes = encode('Date,Amount\n2026-09-06,-12.34\n2026-09-06,0.00\n2026-09-06,1.234\n2026-02-30,9.00\n2026-09-06,92233720368547758.08\n');
  const value = await extractBankCsv(bytes, metadata, signed);
  assert.deepEqual(value.candidates.map((item) => item.direction), ['debit', 'unresolved', 'unresolved', 'unresolved', 'unresolved']);
  assert.deepEqual(value.proposals.map((item) => item.proposedAmountMinor), [null, null, null, null, null]);
  assert.deepEqual(value.candidates.map((item) => item.warningCodes), [
    ['DEBIT_NOT_SUPPORTED'], ['ZERO_AMOUNT'], ['INVALID_AMOUNT'], ['INVALID_DATE'], ['INVALID_AMOUNT'],
  ]);
});

test('split credit/debit columns require an unambiguous positive credit', async () => {
  const mapping = { kind: 'split', dateColumn: 'Date', creditColumn: 'Credit', debitColumn: 'Debit', mappingVersion: 'map-2' };
  const value = await extractBankCsv(encode('Date,Credit,Debit\n2026-09-06,90.00,\n2026-09-07,,12.00\n2026-09-08,90.00,12.00\n'), metadata, mapping);
  assert.deepEqual(value.candidates.map((item) => item.direction), ['credit', 'debit', 'unresolved']);
  assert.deepEqual(value.proposals.map((item) => item.proposedAmountMinor), ['9000', null, null]);
  assert.deepEqual(value.candidates[2].warningCodes, ['AMBIGUOUS_AMOUNT']);
});

test('CSV structure, UTF-8, mappings, and explicit size limits fail typed before approval', async () => {
  assert.equal(await codeOf(() => extractBankCsv(encode('Date,Amount,Amount\n2026-09-06,1,2'), metadata, signed)), 'DUPLICATE_HEADER');
  assert.equal(await codeOf(() => extractBankCsv(encode('Date,Other\n2026-09-06,1'), metadata, signed)), 'MISSING_HEADER');
  assert.equal(await codeOf(() => extractBankCsv(encode('Date,Amount\n2026-09-06,"1.00'), metadata, signed)), 'INVALID_CSV');
  assert.equal(await codeOf(() => extractBankCsv(encode('Date,Amount\n2026-09-06,1".00'), metadata, signed)), 'INVALID_CSV');
  assert.equal(await codeOf(() => extractBankCsv(new Uint8Array([0xff]), metadata, signed)), 'UNSUPPORTED_ENCODING');
  assert.equal(await codeOf(() => extractBankCsv(encode('Date,Amount\n'), null, signed)), 'INVALID_METADATA');
  assert.equal(await codeOf(() => extractBankCsv(encode('Date,Amount\n'), metadata, null)), 'INVALID_MAPPING');
  assert.equal(await codeOf(() => extractBankCsv({ byteLength: 1 }, metadata, signed)), 'INVALID_INPUT');
  assert.equal(await codeOf(() => extractBankCsv(new Uint8Array(20 * 1024 * 1024 + 1), metadata, signed)), 'INPUT_TOO_LARGE');
  assert.equal(await codeOf(() => extractBankCsv(encode(`Date,Amount\n2026-09-06,${'1'.repeat(65537)}`), metadata, signed)), 'CSV_FIELD_LIMIT');
  assert.equal(await codeOf(() => extractBankCsv(encode(`${Array.from({ length: 257 }, (_, i) => `H${i}`).join(',')}\n`), metadata, signed)), 'CSV_COLUMN_LIMIT');
  assert.equal(await codeOf(() => extractBankCsv(encode(`Date,Amount\n${'2026-09-06,1\n'.repeat(100001)}`), metadata, signed)), 'CSV_ROW_LIMIT');
  const manyColumns = Array.from({ length: 101 }, (_, i) => `H${i}`).join(',');
  const manyCells = Array.from({ length: 101 }, () => '1').join(',');
  assert.equal(await codeOf(() => extractBankCsv(encode(`${manyColumns}\n${`${manyCells}\n`.repeat(10000)}`), metadata, signed)), 'CSV_CELL_LIMIT');
});
