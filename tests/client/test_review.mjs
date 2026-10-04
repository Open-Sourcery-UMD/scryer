import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractBankCsv } from '../../client/import/bank.ts';
import { ImportError } from '../../client/import/errors.ts';
import { reviewImport } from '../../client/import/review.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const binary = join(root, 'engine', 'build', 'scryer-native');
const fixture = new URL('../reference/fixtures/golden-case.json', import.meta.url);
const originalCase = () => JSON.parse(readFileSync(fixture, 'utf8'));
const emptyLedger = () => ({ schemaVersion: '1', reviews: [] });
const metadata = { accountRefId: 'bank-a', observedAt: '2026-09-09T10:00:00Z' };
const mapping = { kind: 'signed', dateColumn: 'Date', amountColumn: 'Amount', mappingVersion: 'map-1' };
const command = { commandId: 'import-command-1', recordedAt: '2026-09-10T10:00:00Z', baseHead: 'event-bank-credit' };
const bytes = (text) => new TextEncoder().encode(text);

async function batch(text = 'Date,Amount\n2026-09-08,90.00\n2026-09-08,90.00\n2026-09-08,-4.00\n') {
  return extractBankCsv(bytes(text), metadata, mapping);
}

function decisionsFor(value) {
  return [
    { proposalId: value.proposals[1].proposalId, action: 'edit', amountMinor: '9001', factId: 'import-fact-2', eventId: 'import-event-2', reviewId: 'review-import-2' },
    { proposalId: value.proposals[2].proposalId, action: 'exclude' },
    { proposalId: value.proposals[0].proposalId, action: 'approve', factId: 'import-fact-1', eventId: 'import-event-1', reviewId: 'review-import-1' },
  ];
}

async function nativeValidate(value) {
  const result = spawnSync(binary, [], {
    input: JSON.stringify({ schemaVersion: '1', operation: 'validate', case: value }),
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new ImportError(JSON.parse(result.stderr).error.code);
  }
}

async function codeOf(action) {
  try { await action(); return null; } catch (error) { return error.code; }
}

test('review creates only approved events in source order and native case validation passes', async () => {
  const source = await batch();
  const original = originalCase();
  const ledger = emptyLedger();
  const before = JSON.stringify(original);
  const result = await reviewImport(original, ledger, source, decisionsFor(source), command, nativeValidate);
  assert.equal(result.applied, true);
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.case.artifacts.length, original.artifacts.length + 1);
  assert.equal(result.case.proposals.length, original.proposals.length + 3);
  assert.equal(result.case.events.length, original.events.length + 2);
  assert.deepEqual(result.case.events.slice(-2).map((event) => event.eventId), ['import-event-1', 'import-event-2']);
  assert.deepEqual(result.case.events.slice(-2).map((event) => event.parents), [['event-bank-credit'], ['import-event-1']]);
  assert.deepEqual(result.case.events.slice(-2).map((event) => event.fact.amountMinor), ['9000', '9001']);
  assert.deepEqual(result.case.events.slice(-2).map((event) => event.fact.proposalId), source.proposals.slice(0, 2).map((item) => item.proposalId));
  assert.equal(result.case.events.at(-1).fact.source.location, 'row:3:col:2');
  assert.equal(result.case.proposals[original.proposals.length + 1].proposedAmountMinor, '9000');
  assert.equal(result.ledger.reviews.length, 1);
  assert.match(result.ledger.reviews[0].decisionDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.ledger.reviews[0].decisions.map((item) => item.proposalId), source.proposals.map((item) => item.proposalId));
  await nativeValidate(result.case);
  source.proposals[0].rawValue = 'tampered-after-review';
  assert.equal(result.case.proposals[original.proposals.length].rawValue, '90.00');
});

test('exact repeat is inert, changed review conflicts, and a missing ledger is explicit', async () => {
  const source = await batch();
  const decisions = decisionsFor(source);
  const first = await reviewImport(originalCase(), emptyLedger(), source, decisions, command, nativeValidate);
  let validations = 0;
  const repeated = await reviewImport(first.case, first.ledger, source, [...decisions].reverse(), command, async (value) => {
    validations++;
    await nativeValidate(value);
  });
  assert.equal(repeated.applied, false);
  assert.equal(validations, 1);
  assert.deepEqual(repeated.case, first.case);
  assert.deepEqual(repeated.ledger, first.ledger);
  const changed = decisions.map((item) => item.action === 'edit' ? { ...item, amountMinor: '9002' } : item);
  assert.equal(await codeOf(() => reviewImport(first.case, first.ledger, source, changed, command, nativeValidate)), 'IMPORT_CONFLICT');
  const changedMapping = await extractBankCsv(source.sourceBytes, metadata, { ...mapping, mappingVersion: 'map-2' });
  assert.equal(await codeOf(() => reviewImport(first.case, first.ledger, changedMapping, decisions, command, nativeValidate)), 'IMPORT_CONFLICT');
  const tamperedLedger = structuredClone(first.ledger);
  tamperedLedger.reviews[0].decisions[0].action = 'reject';
  assert.equal(await codeOf(() => reviewImport(first.case, tamperedLedger, source, decisions, command, nativeValidate)), 'INVALID_LEDGER');
  const missingApprovedEvent = structuredClone(first.case);
  missingApprovedEvent.events.pop();
  await nativeValidate(missingApprovedEvent);
  assert.equal(await codeOf(() => reviewImport(missingApprovedEvent, first.ledger, source, decisions, command, nativeValidate)), 'INVALID_LEDGER');
  const changedApprovedAmount = structuredClone(first.case);
  changedApprovedAmount.events.at(-1).fact.amountMinor = '9002';
  await nativeValidate(changedApprovedAmount);
  assert.equal(await codeOf(() => reviewImport(changedApprovedAmount, first.ledger, source, decisions, command, nativeValidate)), 'INVALID_LEDGER');
  assert.equal(await codeOf(() => reviewImport(first.case, emptyLedger(), source, decisions, command, nativeValidate)), 'IMPORT_LEDGER_MISSING');
});

test('incomplete or invalid decisions and stale heads leave both inputs unchanged', async () => {
  const source = await batch();
  const original = originalCase();
  const ledger = emptyLedger();
  const before = JSON.stringify({ original, ledger });
  const decisions = decisionsFor(source);
  assert.equal(await codeOf(() => reviewImport(original, ledger, source, decisions.slice(0, 2), command, nativeValidate)), 'INCOMPLETE_REVIEW');
  assert.equal(await codeOf(() => reviewImport(original, ledger, source, [...decisions, decisions[0]], command, nativeValidate)), 'DUPLICATE_DECISION');
  assert.equal(await codeOf(() => reviewImport(original, ledger, source, decisions, { ...command, baseHead: 'event-extra-charge' }, nativeValidate)), 'STALE_HEAD');
  assert.equal(await codeOf(() => reviewImport(original, ledger, source, decisions, { ...command, commandId: 'bad id' }, nativeValidate)), 'INVALID_REVIEW_COMMAND');
  assert.equal(await codeOf(() => reviewImport(original, ledger, source, decisions, { ...command, recordedAt: '2026-09-31T10:00:00Z' }, nativeValidate)), 'INVALID_REVIEW_COMMAND');
  assert.equal(await codeOf(() => reviewImport(original, ledger, source, decisions,
    { ...command, recordedAt: '2026-09-08T10:00:00Z' }, nativeValidate)), 'INVALID_REVIEW_COMMAND');
  const duplicateIds = decisions.map((item) => item.action === 'approve' ? { ...item, eventId: 'event-bank-credit' } : item);
  assert.equal(await codeOf(() => reviewImport(original, ledger, source, duplicateIds, command, nativeValidate)), 'DUPLICATE_ID');
  const divergent = JSON.parse(readFileSync(new URL('../reference/fixtures/ambiguous-case.json', import.meta.url), 'utf8'));
  assert.equal(await codeOf(() => reviewImport(divergent, ledger, source, decisions, command, nativeValidate)), 'AMBIGUOUS_HEADS');
  const debitApproval = decisions.map((item) => item.action === 'exclude' ?
    { ...item, action: 'approve', factId: 'debit-fact', eventId: 'debit-event', reviewId: 'debit-review' } : item);
  assert.equal(await codeOf(() => reviewImport(original, ledger, source, debitApproval, command, nativeValidate)), 'UNAPPROVABLE_CANDIDATE');
  const badEdit = decisions.map((item) => item.action === 'edit' ? { ...item, amountMinor: '9.01' } : item);
  assert.equal(await codeOf(() => reviewImport(original, ledger, source, badEdit, command, nativeValidate)), 'INVALID_MONEY');
  assert.equal(JSON.stringify({ original, ledger }), before);
});

test('validator failure is atomic and equal movements at different source positions are retained', async () => {
  const source = await batch();
  const original = originalCase();
  const ledger = emptyLedger();
  const decisions = decisionsFor(source);
  const before = JSON.stringify({ original, ledger });
  await assert.rejects(
    () => reviewImport(original, ledger, source, decisions, command, async () => { throw new ImportError('VALIDATOR_REJECTED'); }),
    (error) => error.code === 'VALIDATOR_REJECTED',
  );
  assert.equal(JSON.stringify({ original, ledger }), before);
  const first = await reviewImport(original, ledger, source, decisions, command, nativeValidate);
  const secondSource = await batch('Date,Amount\n2026-09-08,90.00\n2026-09-08,90.00\n');
  const secondDecisions = secondSource.proposals.map((item, index) => ({
    proposalId: item.proposalId, action: 'approve', factId: `second-fact-${index}`,
    eventId: `second-event-${index}`, reviewId: `second-review-${index}`,
  }));
  const second = await reviewImport(first.case, first.ledger, secondSource, secondDecisions,
    { commandId: 'import-command-2', recordedAt: '2026-09-11T10:00:00Z', baseHead: 'import-event-2' }, nativeValidate);
  assert.equal(second.case.events.length, original.events.length + 4);
  assert.equal(second.ledger.reviews.length, 2);
  assert.notEqual(first.case.artifacts.at(-1).artifactId, second.case.artifacts.at(-1).artifactId);
});

test('tampered batch links and invalid base case are rejected before any return value', async () => {
  const source = await batch();
  const decisions = decisionsFor(source);
  const alteredCandidate = structuredClone(source);
  alteredCandidate.candidates[0].amountMinor = '1';
  assert.equal(await codeOf(() => reviewImport(originalCase(), emptyLedger(), alteredCandidate, decisions, command, nativeValidate)), 'INVALID_BATCH');
  const alteredRaw = structuredClone(source);
  alteredRaw.proposals[0].rawValue = '9000.00';
  assert.equal(await codeOf(() => reviewImport(originalCase(), emptyLedger(), alteredRaw, decisions, command, nativeValidate)), 'INVALID_BATCH');
  const alteredBytes = structuredClone(source);
  alteredBytes.sourceBytes[0] = 88;
  assert.equal(await codeOf(() => reviewImport(originalCase(), emptyLedger(), alteredBytes, decisions, command, nativeValidate)), 'INVALID_BATCH');
  const alteredArtifact = structuredClone(source);
  alteredArtifact.artifact.artifactId = 'a_wrong';
  assert.equal(await codeOf(() => reviewImport(originalCase(), emptyLedger(), alteredArtifact, decisions, command, nativeValidate)), 'INVALID_BATCH');
  const invalidCase = originalCase();
  invalidCase.artifacts[0].sha256 = 'invalid';
  const before = JSON.stringify(invalidCase);
  assert.equal(await codeOf(() => reviewImport(invalidCase, emptyLedger(), source, decisions, command, nativeValidate)), 'INVALID_ARTIFACT_HASH');
  assert.equal(JSON.stringify(invalidCase), before);
});
