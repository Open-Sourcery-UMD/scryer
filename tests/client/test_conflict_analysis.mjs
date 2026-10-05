import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import * as conflictAnalysis from '../../client/sync/analysis.ts';

const { analyzeConflictPreview } = conflictAnalysis;

const at = '2026-10-05T00:00:00Z';
const event = (eventId, kind, detail, parents = ['event-base']) => ({
  eventId, parents, recordedAt: at, kind, ...detail,
});
const base = event('event-base', 'approve_fact', {
  fact: { factId: 'fact-base', reviewId: 'review-base', proposalId: null,
    amountMinor: '100', currency: 'USD' },
}, []);
const binary = fileURLToPath(new URL('../../engine/build/scryer-native', import.meta.url));
const bankAccount = { accountRefId: 'account-bank', kind: 'bank',
  institutionId: null, holderKind: 'student' };
function approved(eventId, factId, amountMinor, parents = ['event-base']) {
  return event(eventId, 'approve_fact', { fact: {
    factId, termId: null, accountRefId: 'account-bank', aidItemId: null,
    currency: 'USD', role: 'bank_credit_observed', recipientKind: null,
    amountMinor, proposalId: null, effectiveDate: '2026-10-01',
    source: { kind: 'manual', entryId: `entry-${factId}` },
    reviewId: `review-${factId}`,
  } }, parents);
}
function validBranch(events, additions = {}) {
  return branch(events, { accountRefs: [bankAccount], ...additions });
}
function artifact(artifactId, sha256) {
  return { artifactId, sha256, kind: 'bank_statement', observedAt: at,
    accountRefId: 'account-bank' };
}
function review(artifactId, sha256, commandId) {
  return { artifactId, sha256, accountRefId: 'account-bank', commandId,
    recordedAt: at, baseHead: null, decisions: [], decisionDigest: 'c'.repeat(64) };
}
function nativeValidate(caseData) {
  const checked = spawnSync(binary, [], { input: JSON.stringify({ schemaVersion: '1',
    operation: 'validate', case: caseData }), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (checked.error) throw checked.error;
  assert.equal(checked.status, 0, checked.stderr);
}

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

test('candidate base content is retained by both divergent branches without leaking values', () => {
  const baseEvent = approved('event-base', 'fact-base', '77771', []);
  const baseArtifact = artifact('artifact-base', 'a'.repeat(64));
  const baseReview = review('artifact-base', baseArtifact.sha256, 'command-base');
  const candidate = validBranch([baseEvent], { artifacts: [baseArtifact] });
  candidate.revisionId = 'rev-base';
  candidate.ledger.reviews = [baseReview];
  const reorderedBaseEvent = { kind: baseEvent.kind, fact: { ...baseEvent.fact },
    recordedAt: baseEvent.recordedAt, parents: [], eventId: baseEvent.eventId };
  const localArtifact = artifact('artifact-local', 'b'.repeat(64));
  const local = validBranch([approved('event-local', 'fact-local', '200'),
    reorderedBaseEvent], { artifacts: [baseArtifact, localArtifact] });
  local.ledger.reviews = [baseReview,
    review('artifact-local', localArtifact.sha256, 'command-local')];
  const remoteArtifact = artifact('artifact-remote', 'd'.repeat(64));
  const remote = validBranch([baseEvent, approved('event-remote', 'fact-remote', '300')],
    { artifacts: [baseArtifact, remoteArtifact] });
  remote.ledger.reviews = [baseReview,
    review('artifact-remote', remoteArtifact.sha256, 'command-remote')];
  for (const branch of [candidate, local, remote]) nativeValidate(branch.case);
  const input = { ...preview(local, remote), ancestor: { status: 'available', branch: candidate } };
  const before = JSON.stringify(input);
  const result = conflictAnalysis.analyzeAncestorCandidate(input);
  const retained = { missingBaseEventIds: [], changedBaseEventIds: [],
    changedCaseFields: [], changedLedgerPrefix: false, baseContentRetained: true };
  assert.deepEqual(result, { status: 'available', baseRevisionId: 'rev-base',
    local: retained, remote: retained });
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(result).includes('77771'), false);
  assert.equal(JSON.stringify(result).includes(baseArtifact.sha256), false);
});

test('candidate base analysis identifies missing and changed history without suggesting a merge', () => {
  const baseEvent = approved('event-base', 'fact-base', '100', []);
  const second = approved('event-base-second', 'fact-second', '150');
  const baseArtifact = artifact('artifact-base', 'a'.repeat(64));
  const candidate = validBranch([baseEvent, second], { artifacts: [baseArtifact] });
  candidate.revisionId = 'rev-base';
  candidate.ledger.reviews = [review('artifact-base', baseArtifact.sha256, 'command-base')];
  const local = validBranch([{ ...baseEvent, fact: { ...baseEvent.fact, amountMinor: '999' } }],
    { artifacts: [baseArtifact] });
  local.ledger.reviews = [review('artifact-base', baseArtifact.sha256, 'command-base')];
  const changedArtifact = { ...baseArtifact, sha256: 'b'.repeat(64) };
  const remote = validBranch([second, baseEvent], { artifacts: [changedArtifact] });
  remote.ledger.reviews = [review('artifact-base', changedArtifact.sha256, 'command-replaced')];
  for (const branch of [candidate, local, remote]) nativeValidate(branch.case);
  const result = conflictAnalysis.analyzeAncestorCandidate({ ...preview(local, remote),
    ancestor: { status: 'available', branch: candidate } });
  assert.deepEqual(result, { status: 'available', baseRevisionId: 'rev-base',
    local: { missingBaseEventIds: ['event-base-second'], changedBaseEventIds: ['event-base'],
      changedCaseFields: [], changedLedgerPrefix: false, baseContentRetained: false },
    remote: { missingBaseEventIds: [], changedBaseEventIds: [],
      changedCaseFields: ['artifacts'], changedLedgerPrefix: true,
      baseContentRetained: false } });
  assert.equal(JSON.stringify(result).includes('999'), false);
});

test('candidate base analysis distinguishes absent bases and refuses mismatched revision', () => {
  const local = branch([base]);
  const remote = branch([base]);
  const current = preview(local, remote);
  assert.deepEqual(conflictAnalysis.analyzeAncestorCandidate({ ...current,
    ancestor: { status: 'unavailable' } }), { status: 'unavailable' });
  assert.deepEqual(conflictAnalysis.analyzeAncestorCandidate({ ...current,
    pendingExpectedServerRevision: null, ancestor: { status: 'not_requested' } }),
  { status: 'not_requested' });
  assert.throws(() => conflictAnalysis.analyzeAncestorCandidate({ ...current,
    ancestor: { status: 'available', branch: branch([base]) } }),
  { code: 'INVALID_CONFLICT_PREVIEW' });
});
