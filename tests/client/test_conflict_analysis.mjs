import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeConflictPreview } from '../../client/sync/analysis.ts';

const at = '2026-10-05T00:00:00Z';
const event = (eventId, kind, detail, parents = ['event-base']) => ({
  eventId, parents, recordedAt: at, kind, ...detail,
});
const base = event('event-base', 'approve_fact', {
  fact: { factId: 'fact-base', reviewId: 'review-base', proposalId: null,
    amountMinor: '100', currency: 'USD' },
}, []);

function branch(events, additions = {}) {
  return { revisionId: 'rev-branch', heads: [], ledger: { schemaVersion: '1', reviews: [] },
    case: { schemaVersion: '1', caseId: 'case-analysis', currency: 'USD',
      institutions: [], accountRefs: [], terms: [], aidItems: [], artifacts: [],
      proposals: [], events, ...additions } };
}

function preview(local, remote) {
  return { caseId: 'case-analysis', pendingOperationId: 'op-analysis',
    pendingRevisionId: 'rev-local', pendingManifestDigest: '0'.repeat(64),
    pendingExpectedServerRevision: 'rev-base', local, remote };
}

test('read-only branch analysis separates shared history from each device without order dependence', () => {
  const local = branch([base, event('event-local', 'approve_fact', {
    fact: { factId: 'fact-local', reviewId: 'review-local', proposalId: null },
  })]);
  const sameBaseOtherKeyOrder = { kind: 'approve_fact', recordedAt: at,
    parents: [], eventId: 'event-base', fact: { currency: 'USD', amountMinor: '100',
      proposalId: null, reviewId: 'review-base', factId: 'fact-base' } };
  const remote = branch([event('event-remote', 'approve_fact', {
    fact: { factId: 'fact-remote', reviewId: 'review-remote', proposalId: null },
  }), sameBaseOtherKeyOrder]);
  const result = analyzeConflictPreview(preview(local, remote));
  assert.deepEqual(result, { caseId: 'case-analysis',
    sharedEventIds: ['event-base'], localOnlyEventIds: ['event-local'],
    remoteOnlyEventIds: ['event-remote'], differentCaseFields: [],
    differentLedger: false, issues: [] });
  assert.deepEqual(local.case.events.map((item) => item.eventId), ['event-base', 'event-local']);
  assert.deepEqual(remote.case.events.map((item) => item.eventId), ['event-remote', 'event-base']);
});

test('branch analysis flags identity and concurrent decision hazards without exposing financial values', () => {
  const local = branch([base,
    event('event-same-id', 'approve_fact', { fact: { factId: 'fact-a', reviewId: 'review-a',
      proposalId: null, amountMinor: '700', rawValue: 'synthetic_private_source_local' } }),
    event('event-local-fact', 'approve_fact', { fact: { factId: 'fact-shared',
      reviewId: 'review-local-fact', proposalId: null } }),
    event('event-local-correction', 'correct_fact', { correction: { factId: 'fact-base',
      reviewId: 'review-local-correction', cancelled: false, replacementAmountMinor: '150' } }),
    event('event-local-match', 'decide_match', { decision: { refundFactId: 'refund-a',
      bankFactId: 'bank-a', reviewId: 'review-local-match', action: 'confirm',
      allocatedMinor: '400' } }),
  ], { artifacts: [{ artifactId: 'artifact-local', sha256: 'a'.repeat(64), accountRefId: null }] });
  const remote = branch([base,
    event('event-same-id', 'approve_fact', { fact: { factId: 'fact-a', reviewId: 'review-a',
      proposalId: null, amountMinor: '900' } }),
    event('event-remote-fact', 'approve_fact', { fact: { factId: 'fact-shared',
      reviewId: 'review-remote-fact', proposalId: null } }),
    event('event-remote-correction', 'correct_fact', { correction: { factId: 'fact-base',
      reviewId: 'review-remote-correction', cancelled: true, replacementAmountMinor: null } }),
    event('event-remote-match', 'decide_match', { decision: { refundFactId: 'refund-a',
      bankFactId: 'bank-b', reviewId: 'review-remote-match', action: 'confirm',
      allocatedMinor: '300' } }),
  ]);
  remote.ledger = { schemaVersion: '1', reviews: [{ commandId: 'command-remote' }] };
  const result = analyzeConflictPreview(preview(local, remote));
  assert.deepEqual(result.sharedEventIds, ['event-base']);
  assert.deepEqual(result.localOnlyEventIds,
    ['event-local-correction', 'event-local-fact', 'event-local-match']);
  assert.deepEqual(result.remoteOnlyEventIds,
    ['event-remote-correction', 'event-remote-fact', 'event-remote-match']);
  assert.deepEqual(result.differentCaseFields, ['artifacts']);
  assert.equal(result.differentLedger, true);
  assert.deepEqual(result.issues, [
    { code: 'CONCURRENT_CORRECTION', ids: ['fact-base'] },
    { code: 'CONCURRENT_MATCH_DECISION', ids: ['refund-a'] },
    { code: 'EVENT_ID_COLLISION', ids: ['event-same-id'] },
    { code: 'FACT_ID_COLLISION', ids: ['fact-shared'] },
  ]);
  assert.equal(JSON.stringify(result).includes('700'), false);
  assert.equal(JSON.stringify(result).includes('900'), false);
  assert.equal(JSON.stringify(result).includes('synthetic_private_source_local'), false);
  const swapped = analyzeConflictPreview(preview(remote, local));
  assert.deepEqual(swapped.issues, result.issues);
});

test('branch analysis refuses inconsistent or repeated event identities', () => {
  const duplicated = branch([base, base]);
  const ordinary = branch([base]);
  assert.throws(() => analyzeConflictPreview(preview(duplicated, ordinary)),
    { code: 'INVALID_CONFLICT_PREVIEW' });
  const wrongCase = branch([base], { caseId: 'case-other' });
  assert.throws(() => analyzeConflictPreview(preview(wrongCase, ordinary)),
    { code: 'INVALID_CONFLICT_PREVIEW' });
});
