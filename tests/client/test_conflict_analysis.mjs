import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  assert.ok(JSON.stringify(input) === before, 'base analysis mutated the preview');
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

test('disjoint approval union candidate retains both branches for review without mutation', () => {
  const baseEvent = approved('event-base', 'fact-base', '100', []);
  const baseBranch = validBranch([baseEvent]);
  baseBranch.revisionId = 'rev-base';
  const local = validBranch([approved('event-local', 'fact-local', '200'), baseEvent]);
  local.revisionId = 'rev-local';
  const remote = validBranch([baseEvent, approved('event-remote', 'fact-remote', '300')]);
  remote.revisionId = 'rev-remote';
  remote.case.events[0] = { kind: baseEvent.kind, fact: { ...baseEvent.fact },
    recordedAt: baseEvent.recordedAt, parents: [], eventId: baseEvent.eventId };
  remote.case = { events: remote.case.events, ...remote.case };
  for (const branch of [baseBranch, local, remote]) nativeValidate(branch.case);
  const input = { ...preview(local, remote), ancestor: { status: 'available',
    branch: baseBranch } };
  const before = JSON.stringify(input);
  const proposed = conflictAnalysis.proposeDisjointApprovalUnion(input);
  assert.equal(proposed.status, 'candidate');
  assert.deepEqual(proposed.case.events.map((item) => item.eventId),
    ['event-base', 'event-local', 'event-remote']);
  assert.deepEqual(proposed.localOnlyEventIds, ['event-local']);
  assert.deepEqual(proposed.remoteOnlyEventIds, ['event-remote']);
  assert.deepEqual(proposed.ledger, local.ledger);
  nativeValidate(proposed.case);
  assert.ok(JSON.stringify(input) === before, 'proposal mutated the preview');
  const swapped = conflictAnalysis.proposeDisjointApprovalUnion({ ...input,
    local: remote, remote: local });
  assert.equal(swapped.status, 'candidate');
  assert.ok(JSON.stringify(swapped.case) === JSON.stringify(proposed.case),
    'candidate changed when branch and member order changed');
});

test('explicit review command binds a disjoint approval candidate and produces one native-valid head', async () => {
  const baseEvent = approved('event-base', 'fact-base', '100', []);
  const baseBranch = validBranch([baseEvent]);
  baseBranch.revisionId = 'rev-base';
  baseBranch.heads = ['event-base'];
  const local = validBranch([baseEvent, approved('event-local', 'fact-local', '200')]);
  local.revisionId = 'rev-local';
  local.heads = ['event-local'];
  const remote = validBranch([baseEvent, approved('event-remote', 'fact-remote', '300')]);
  remote.revisionId = 'rev-remote';
  remote.heads = ['event-remote'];
  const input = { ...preview(local, remote), ancestor: { status: 'available', branch: baseBranch } };
  for (const item of [baseBranch, local, remote]) nativeValidate(item.case);
  const before = JSON.stringify(input);
  const digest = await conflictAnalysis.digestDisjointApprovalCandidate(input);
  const command = { caseId: input.caseId, pendingOperationId: input.pendingOperationId,
    pendingRevisionId: input.pendingRevisionId,
    pendingManifestDigest: input.pendingManifestDigest, localRevisionId: local.revisionId,
    remoteRevisionId: remote.revisionId, baseRevisionId: baseBranch.revisionId,
    localHead: 'event-local', remoteHead: 'event-remote',
    localOnlyEventIds: ['event-local'], remoteOnlyEventIds: ['event-remote'],
    candidateDigest: digest, eventId: 'event-join', reviewId: 'review-join',
    recordedAt: '2026-10-05T12:00:00Z' };
  const validate = async (caseData) => nativeValidate(caseData);
  const prepared = await conflictAnalysis.prepareReviewedApprovalJoin(input, command, validate);
  assert.equal(prepared.joinEventId, 'event-join');
  assert.deepEqual(prepared.parentHeads, ['event-local', 'event-remote']);
  assert.deepEqual(prepared.case.events.at(-1), {
    eventId: 'event-join', parents: ['event-local', 'event-remote'],
    recordedAt: command.recordedAt, kind: 'resolve_branches',
    resolution: { reviewId: 'review-join' },
  });
  assert.deepEqual(prepared.case.events.filter((item) => item.kind === 'approve_fact')
    .map((item) => item.fact.amountMinor).sort(), ['100', '200', '300']);
  assert.deepEqual(prepared.ledger, local.ledger);
  nativeValidate(prepared.case);
  assert.equal(JSON.stringify(input), before);
  const reject = async (changedInput, changedCommand, expected) => {
    await assert.rejects(() => conflictAnalysis.prepareReviewedApprovalJoin(
      changedInput, changedCommand, validate), { code: expected });
  };
  await reject(input, { ...command, candidateDigest: 'f'.repeat(64) }, 'REVIEW_MISMATCH');
  await reject(input, { ...command, remoteRevisionId: 'rev-wrong' }, 'REVIEW_MISMATCH');
  await reject(input, { ...command, pendingRevisionId: 'rev-wrong' }, 'REVIEW_MISMATCH');
  await reject(input, { ...command, baseRevisionId: 'rev-wrong' }, 'REVIEW_MISMATCH');
  await reject(input, { ...command, pendingOperationId: 'op-wrong' }, 'REVIEW_MISMATCH');
  await reject(input, { ...command, pendingManifestDigest: 'f'.repeat(64) }, 'REVIEW_MISMATCH');
  await reject(input, { ...command, localOnlyEventIds: [] }, 'REVIEW_MISMATCH');
  await reject(input, { ...command, localHead: 'event-base' }, 'AMBIGUOUS_HEADS');
  await reject(input, { ...command, reviewId: 'review-fact-local' }, 'DUPLICATE_ID');
  await reject(input, { ...command, eventId: 'event-local' }, 'DUPLICATE_ID');
  await reject(input, { ...command, recordedAt: 'bad' }, 'INVALID_JOIN_COMMAND');
  await reject(input, { ...command, note: 'unreviewed' }, 'INVALID_JOIN_COMMAND');
  const changed = structuredClone(input);
  changed.local.case.events.find((item) => item.eventId === 'event-local').fact.amountMinor = '201';
  nativeValidate(changed.local.case);
  await reject(changed, command, 'REVIEW_MISMATCH');
  const changedMetadata = structuredClone(input);
  const extraArtifact = artifact('artifact-extra', 'e'.repeat(64));
  changedMetadata.local.case.artifacts.push(extraArtifact);
  changedMetadata.remote.case.artifacts.push(extraArtifact);
  for (const branch of [changedMetadata.local, changedMetadata.remote]) nativeValidate(branch.case);
  await reject(changedMetadata, command, 'REVIEW_MISMATCH');
  const changedLedger = structuredClone(changedMetadata);
  const addedReview = review(extraArtifact.artifactId, extraArtifact.sha256, 'command-extra');
  changedLedger.local.ledger.reviews.push(addedReview);
  changedLedger.remote.ledger.reviews.push(addedReview);
  await reject(changedLedger, command, 'REVIEW_MISMATCH');
  const multiHead = structuredClone(input);
  multiHead.local.case.events.push(approved('event-local-2', 'fact-local-2', '400'));
  multiHead.local.heads = ['event-local', 'event-local-2'];
  nativeValidate(multiHead.local.case);
  await reject(multiHead, { ...command,
    localOnlyEventIds: ['event-local', 'event-local-2'],
    candidateDigest: await conflictAnalysis.digestDisjointApprovalCandidate(multiHead),
  }, 'AMBIGUOUS_HEADS');
  await reject({ ...input, ancestor: { status: 'unavailable' } }, command, 'CANDIDATE_REFUSED');
  await assert.rejects(() => conflictAnalysis.prepareReviewedApprovalJoin(input, command,
    async () => { throw new Error('synthetic validator refusal'); }), { code: 'INVALID_JOINED_CASE' });
  assert.equal(JSON.stringify(input), before);
});

test('disjoint approval union refuses unverifiable or semantically hazardous branches', () => {
  const baseEvent = approved('event-base', 'fact-base', '100', []);
  const baseBranch = validBranch([baseEvent]);
  baseBranch.revisionId = 'rev-base';
  const localEvent = approved('event-local', 'fact-local', '200');
  const remoteEvent = approved('event-remote', 'fact-remote', '300');
  const local = validBranch([baseEvent, localEvent]);
  const remote = validBranch([baseEvent, remoteEvent]);
  const input = { ...preview(local, remote), ancestor: { status: 'available',
    branch: baseBranch } };
  const refuse = (candidate) => {
    const result = conflictAnalysis.proposeDisjointApprovalUnion(candidate);
    assert.equal(result.status, 'refused');
    assert.equal(JSON.stringify(result).includes('200'), false);
    assert.equal(JSON.stringify(result).includes('300'), false);
    return result.reason;
  };
  assert.equal(refuse({ ...input, ancestor: { status: 'unavailable' } }),
    'NO_BASE_CANDIDATE');
  assert.equal(refuse({ ...input, pendingExpectedServerRevision: null,
    ancestor: { status: 'not_requested' } }), 'NO_BASE_CANDIDATE');
  assert.equal(refuse({ ...input, local: baseBranch }), 'NO_BRANCH_DIVERGENCE');
  const independentLocal = validBranch([approved('event-local', 'fact-local', '200', [])]);
  nativeValidate(independentLocal.case);
  assert.equal(refuse({ ...input, local: independentLocal }), 'BASE_CONTENT_DIVERGED');
  assert.equal(refuse({ ...input, remote: validBranch([baseEvent,
    { ...remoteEvent, eventId: 'event-local', fact: {
      ...remoteEvent.fact, amountMinor: '900' } }]) }), 'EVENT_CONFLICT');
  assert.equal(refuse({ ...input, remote: validBranch([baseEvent, remoteEvent],
    { artifacts: [artifact('artifact-remote', 'a'.repeat(64))] }) }),
  'METADATA_DIVERGED');
  const commonArtifact = artifact('artifact-remote', 'a'.repeat(64));
  const withArtifact = (events) => validBranch(events, { artifacts: [commonArtifact] });
  const reviewBase = withArtifact([baseEvent]);
  reviewBase.revisionId = 'rev-base';
  const reviewLocal = withArtifact([baseEvent, localEvent]);
  const reviewRemote = withArtifact([baseEvent, remoteEvent]);
  reviewRemote.ledger.reviews = [review('artifact-remote', commonArtifact.sha256,
    'command-remote')];
  for (const branch of [reviewBase, reviewLocal, reviewRemote]) nativeValidate(branch.case);
  assert.equal(refuse({ ...input, ancestor: { status: 'available', branch: reviewBase },
    local: reviewLocal, remote: reviewRemote }), 'METADATA_DIVERGED');
  const correction = event('event-remote-correction', 'correct_fact', {
    correction: { factId: 'fact-base', replacementAmountMinor: '300', cancelled: false,
      source: { kind: 'manual', entryId: 'entry-correction' }, reviewId: 'review-correction' },
  });
  assert.equal(refuse({ ...input, remote: validBranch([baseEvent, correction]) }),
    'NON_APPROVAL_CHANGE');
  const golden = JSON.parse(readFileSync(new URL('../reference/fixtures/golden-case.json',
    import.meta.url), 'utf8'));
  const bank = golden.events.find((item) => item.eventId === 'event-bank-credit');
  const localGolden = structuredClone(golden);
  localGolden.events.push({ ...bank, eventId: 'event-local-bank',
    parents: ['event-bank-credit'], recordedAt: '2026-10-09T10:00:00Z',
    fact: { ...bank.fact, factId: 'local-bank', reviewId: 'review-local-bank',
      proposalId: null, source: { kind: 'manual', entryId: 'local-bank-entry' } } });
  const remoteGolden = structuredClone(golden);
  remoteGolden.events.push({ eventId: 'event-remote-match',
    parents: ['event-refund-issued', 'event-bank-credit'],
    recordedAt: '2026-10-09T10:00:00Z', kind: 'decide_match',
    decision: { refundFactId: 'issued-refund', bankFactId: 'bank-credit',
      allocatedMinor: '0', action: 'reject', recipientEvidence: null,
      reviewId: 'review-remote-match' } });
  for (const caseData of [golden, localGolden, remoteGolden]) nativeValidate(caseData);
  const goldenBranch = (caseData, revisionId) => ({ case: caseData, revisionId,
    heads: [], ledger: { schemaVersion: '1', reviews: [] } });
  assert.equal(refuse({ ...input, caseId: golden.caseId,
    local: goldenBranch(localGolden, 'rev-local'),
    remote: goldenBranch(remoteGolden, 'rev-remote'),
    ancestor: { status: 'available', branch: goldenBranch(golden, 'rev-base') } }),
  'NON_APPROVAL_CHANGE');
  assert.equal(refuse({ ...input, remote: validBranch([baseEvent,
    { ...remoteEvent, fact: { ...remoteEvent.fact,
      reviewId: localEvent.fact.reviewId } }]) }), 'SOURCE_IDENTITY_COLLISION');
  assert.equal(refuse({ ...input, remote: validBranch([baseEvent,
    { ...remoteEvent, fact: { ...remoteEvent.fact,
      source: localEvent.fact.source } }]) }), 'SOURCE_IDENTITY_COLLISION');
});
