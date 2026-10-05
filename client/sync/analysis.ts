import { exactKeys, validId } from '../crypto/codec.ts';
import { sha256Hex } from '../import/hash.ts';
import { maximalHeads } from '../import/case-shape.ts';
import type { CaseEvent, CaseV1, CaseValidator } from '../import/types.ts';
import { validInstant } from '../import/validation.ts';
import type { ConflictPreview } from './conflict.ts';

type IssueCode = 'EVENT_ID_COLLISION' | 'FACT_ID_COLLISION' |
  'CONCURRENT_CORRECTION' | 'CONCURRENT_MATCH_DECISION';
export type ConflictIssue = { code: IssueCode; ids: string[] };
export type ConflictAnalysis = { caseId: string; sharedEventIds: string[];
  localOnlyEventIds: string[]; remoteOnlyEventIds: string[];
  differentCaseFields: string[]; differentLedger: boolean; issues: ConflictIssue[] };
export type BaseRetention = { missingBaseEventIds: string[]; changedBaseEventIds: string[];
  changedCaseFields: string[]; changedLedgerPrefix: boolean; baseContentRetained: boolean };
export type AncestorCandidateAnalysis =
  | { status: 'not_requested' | 'unavailable' }
  | { status: 'available'; baseRevisionId: string;
      local: BaseRetention; remote: BaseRetention };
export type ApprovalUnionProposal =
  | { status: 'candidate'; requiresReview: true; case: CaseV1;
      ledger: ConflictPreview['local']['ledger']; localOnlyEventIds: string[];
      remoteOnlyEventIds: string[] }
  | { status: 'refused'; reason: 'NO_BASE_CANDIDATE' | 'BASE_CONTENT_DIVERGED' |
      'EVENT_CONFLICT' | 'METADATA_DIVERGED' | 'NON_APPROVAL_CHANGE' |
      'SOURCE_IDENTITY_COLLISION' | 'NO_BRANCH_DIVERGENCE' };
export type ApprovalJoinReviewCommand = {
  caseId: string; pendingOperationId: string; pendingRevisionId: string;
  pendingManifestDigest: string;
  localRevisionId: string; remoteRevisionId: string; baseRevisionId: string;
  localHead: string; remoteHead: string;
  localOnlyEventIds: string[]; remoteOnlyEventIds: string[];
  candidateDigest: string; eventId: string; reviewId: string; recordedAt: string;
};
export type PreparedApprovalJoin = { case: CaseV1;
  ledger: ConflictPreview['local']['ledger']; joinEventId: string; parentHeads: string[] };

const CASE_FIELDS = ['institutions', 'accountRefs', 'terms', 'aidItems',
  'artifacts', 'proposals'] as const;

export class ConflictAnalysisError extends Error {
  readonly code = 'INVALID_CONFLICT_PREVIEW';
  constructor() { super('INVALID_CONFLICT_PREVIEW'); this.name = 'ConflictAnalysisError'; }
}

export class ConflictJoinError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ConflictJoinError'; this.code = code; }
}

function canonicalJson(value: unknown, depth = 0, seen = new WeakSet<object>()): string {
  if (depth > 64) throw new ConflictAnalysisError();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || seen.has(value)) throw new ConflictAnalysisError();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, depth + 1, seen)).join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) throw new ConflictAnalysisError();
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key], depth + 1, seen)}`).join(',')}}`;
  } finally { seen.delete(value); }
}

function eventIndex(caseData: CaseV1, expectedCaseId: string): Map<string, CaseEvent> {
  if (!caseData || caseData.schemaVersion !== '1' ||
      caseData.caseId !== expectedCaseId || caseData.currency !== 'USD' ||
      !Array.isArray(caseData.events) ||
      CASE_FIELDS.some((field) => !Array.isArray(caseData[field]))) {
    throw new ConflictAnalysisError();
  }
  const indexed = new Map<string, CaseEvent>();
  for (const item of caseData.events) {
    if (!item || !validId(item.eventId) || indexed.has(item.eventId) ||
        typeof item.kind !== 'string' || !Array.isArray(item.parents) ||
        item.parents.some((parent: unknown) => !validId(parent))) throw new ConflictAnalysisError();
    canonicalJson(item);
    indexed.set(item.eventId, item);
  }
  return indexed;
}

function issueForSharedTarget(local: readonly CaseEvent[], remote: readonly CaseEvent[],
  kind: string, code: IssueCode, target: (event: CaseEvent) => string[] | null): ConflictIssue[] {
  const localTargets = new Map<string, string[]>();
  for (const item of local.filter((entry) => entry.kind === kind)) {
    const ids = target(item);
    if (!ids || ids.some((id) => !validId(id))) throw new ConflictAnalysisError();
    localTargets.set(ids.join('\u0000'), ids);
  }
  const issues: ConflictIssue[] = [];
  const seen = new Set<string>();
  for (const item of remote.filter((entry) => entry.kind === kind)) {
    const ids = target(item);
    if (!ids || ids.some((id) => !validId(id))) throw new ConflictAnalysisError();
    const key = ids.join('\u0000');
    if (localTargets.has(key) && !seen.has(key)) {
      issues.push({ code, ids });
      seen.add(key);
    }
  }
  return issues;
}

export function analyzeConflictPreview(preview: ConflictPreview): ConflictAnalysis {
  if (!preview || !validId(preview.caseId) || !preview.local || !preview.remote ||
      preview.local.ledger?.schemaVersion !== '1' ||
      preview.remote.ledger?.schemaVersion !== '1' ||
      !Array.isArray(preview.local.ledger.reviews) ||
      !Array.isArray(preview.remote.ledger.reviews)) throw new ConflictAnalysisError();
  const local = eventIndex(preview.local.case, preview.caseId);
  const remote = eventIndex(preview.remote.case, preview.caseId);
  const sharedEventIds: string[] = [];
  const localOnlyEventIds: string[] = [];
  const remoteOnlyEventIds: string[] = [];
  const issues: ConflictIssue[] = [];
  for (const [id, item] of local) {
    const other = remote.get(id);
    if (!other) localOnlyEventIds.push(id);
    else if (canonicalJson(item) === canonicalJson(other)) sharedEventIds.push(id);
    else issues.push({ code: 'EVENT_ID_COLLISION', ids: [id] });
  }
  for (const id of remote.keys()) if (!local.has(id)) remoteOnlyEventIds.push(id);
  const localOnly = localOnlyEventIds.map((id) => local.get(id)!);
  const remoteOnly = remoteOnlyEventIds.map((id) => remote.get(id)!);
  issues.push(...issueForSharedTarget(localOnly, remoteOnly, 'approve_fact',
    'FACT_ID_COLLISION', (item) => item.fact ? [item.fact.factId] : null));
  issues.push(...issueForSharedTarget(localOnly, remoteOnly, 'correct_fact',
    'CONCURRENT_CORRECTION', (item) => item.correction ?
      [item.correction.factId as string] : null));
  issues.push(...issueForSharedTarget(localOnly, remoteOnly, 'decide_match',
    'CONCURRENT_MATCH_DECISION', (item) => item.decision ?
      [(item.decision as Record<string, unknown>).refundFactId as string] : null));
  const differentCaseFields = CASE_FIELDS.filter((field) => canonicalJson(
    preview.local.case[field]) !== canonicalJson(preview.remote.case[field]));
  const differentLedger = canonicalJson(preview.local.ledger) !== canonicalJson(preview.remote.ledger);
  sharedEventIds.sort(); localOnlyEventIds.sort(); remoteOnlyEventIds.sort();
  differentCaseFields.sort();
  issues.sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 :
    a.ids.join('\u0000') < b.ids.join('\u0000') ? -1 :
      a.ids.join('\u0000') > b.ids.join('\u0000') ? 1 : 0);
  return { caseId: preview.caseId, sharedEventIds, localOnlyEventIds,
    remoteOnlyEventIds, differentCaseFields, differentLedger, issues };
}

function isCanonicalPrefix(base: readonly unknown[], branch: readonly unknown[]): boolean {
  if (base.length > branch.length) return false;
  return base.every((item, index) => canonicalJson(item) === canonicalJson(branch[index]));
}

function baseRetention(base: ConflictPreview['local'], branch: ConflictPreview['local'],
  baseEvents: Map<string, CaseEvent>, branchEvents: Map<string, CaseEvent>): BaseRetention {
  const missingBaseEventIds: string[] = [];
  const changedBaseEventIds: string[] = [];
  for (const [id, baseEvent] of baseEvents) {
    const current = branchEvents.get(id);
    if (!current) missingBaseEventIds.push(id);
    else if (canonicalJson(baseEvent) !== canonicalJson(current)) changedBaseEventIds.push(id);
  }
  const changedCaseFields = CASE_FIELDS.filter((field) =>
    !isCanonicalPrefix(base.case[field], branch.case[field])).sort();
  const changedLedgerPrefix = !isCanonicalPrefix(base.ledger.reviews, branch.ledger.reviews);
  missingBaseEventIds.sort(); changedBaseEventIds.sort();
  return { missingBaseEventIds, changedBaseEventIds, changedCaseFields,
    changedLedgerPrefix, baseContentRetained: missingBaseEventIds.length === 0 &&
      changedBaseEventIds.length === 0 && changedCaseFields.length === 0 &&
      !changedLedgerPrefix };
}

export function analyzeAncestorCandidate(preview: ConflictPreview): AncestorCandidateAnalysis {
  if (!preview || !validId(preview.caseId) || !preview.ancestor) {
    throw new ConflictAnalysisError();
  }
  if (preview.ancestor.status === 'not_requested') {
    if (preview.pendingExpectedServerRevision !== null) throw new ConflictAnalysisError();
    return { status: 'not_requested' };
  }
  if (preview.ancestor.status === 'unavailable') {
    if (!validId(preview.pendingExpectedServerRevision)) throw new ConflictAnalysisError();
    return { status: 'unavailable' };
  }
  if (preview.ancestor.status !== 'available' ||
      !validId(preview.pendingExpectedServerRevision) ||
      preview.ancestor.branch.revisionId !== preview.pendingExpectedServerRevision ||
      !validId(preview.local?.revisionId) || !validId(preview.remote?.revisionId)) {
    throw new ConflictAnalysisError();
  }
  const base = preview.ancestor.branch;
  const branches = [base, preview.local, preview.remote];
  for (const branch of branches) {
    if (!branch?.ledger || branch.ledger.schemaVersion !== '1' ||
        !Array.isArray(branch.ledger.reviews)) throw new ConflictAnalysisError();
  }
  const baseEvents = eventIndex(base.case, preview.caseId);
  const localEvents = eventIndex(preview.local.case, preview.caseId);
  const remoteEvents = eventIndex(preview.remote.case, preview.caseId);
  return { status: 'available', baseRevisionId: base.revisionId,
    local: baseRetention(base, preview.local, baseEvents, localEvents),
    remote: baseRetention(base, preview.remote, baseEvents, remoteEvents) };
}

function approvalIdentities(event: CaseEvent): string[] {
  const fact = event.fact;
  if (event.kind !== 'approve_fact' || !fact || !validId(fact.factId) ||
      !validId(fact.reviewId) ||
      (fact.proposalId !== null && !validId(fact.proposalId)) ||
      !fact.source || typeof fact.source !== 'object' ||
      !['manual', 'artifact'].includes((fact.source as { kind?: string }).kind ?? '')) {
    throw new ConflictAnalysisError();
  }
  return [`fact:${fact.factId}`, `review:${fact.reviewId}`,
    ...(fact.proposalId === null ? [] : [`proposal:${fact.proposalId}`]),
    `source:${canonicalJson(fact.source)}`];
}

// A read-only browser candidate. Its historical base is content-compatible, not proven
// ancestral; the caller must obtain explicit review and recheck state before any write.
export function proposeDisjointApprovalUnion(preview: ConflictPreview): ApprovalUnionProposal {
  const base = analyzeAncestorCandidate(preview);
  if (base.status !== 'available') return { status: 'refused', reason: 'NO_BASE_CANDIDATE' };
  if (!base.local.baseContentRetained || !base.remote.baseContentRetained) {
    return { status: 'refused', reason: 'BASE_CONTENT_DIVERGED' };
  }
  const analysis = analyzeConflictPreview(preview);
  if (analysis.issues.length > 0) return { status: 'refused', reason: 'EVENT_CONFLICT' };
  if (analysis.differentCaseFields.length > 0 || analysis.differentLedger) {
    return { status: 'refused', reason: 'METADATA_DIVERGED' };
  }
  if (analysis.localOnlyEventIds.length === 0 || analysis.remoteOnlyEventIds.length === 0) {
    return { status: 'refused', reason: 'NO_BRANCH_DIVERGENCE' };
  }
  const local = new Map(preview.local.case.events.map((item) => [item.eventId, item]));
  const remote = new Map(preview.remote.case.events.map((item) => [item.eventId, item]));
  const additions = [
    ...analysis.localOnlyEventIds.map((id) => local.get(id)!),
    ...analysis.remoteOnlyEventIds.map((id) => remote.get(id)!),
  ];
  if (additions.some((item) => item.kind !== 'approve_fact')) {
    return { status: 'refused', reason: 'NON_APPROVAL_CHANGE' };
  }
  const localIdentities = new Set(analysis.localOnlyEventIds.flatMap((id) =>
    approvalIdentities(local.get(id)!)));
  if (analysis.remoteOnlyEventIds.some((id) =>
    approvalIdentities(remote.get(id)!).some((identity) => localIdentities.has(identity)))) {
    return { status: 'refused', reason: 'SOURCE_IDENTITY_COLLISION' };
  }
  const combined = new Map([...local, ...remote]);
  const events = [...combined.keys()].sort().map((id) => combined.get(id)!);
  return { status: 'candidate', requiresReview: true,
    case: JSON.parse(canonicalJson({ ...preview.local.case, events })) as CaseV1,
    ledger: JSON.parse(canonicalJson(preview.local.ledger)) as ConflictPreview['local']['ledger'],
    localOnlyEventIds: analysis.localOnlyEventIds,
    remoteOnlyEventIds: analysis.remoteOnlyEventIds };
}

function availableApprovalUnion(preview: ConflictPreview): Extract<ApprovalUnionProposal, { status: 'candidate' }> {
  const proposal = proposeDisjointApprovalUnion(preview);
  if (proposal.status !== 'candidate') throw new ConflictJoinError('CANDIDATE_REFUSED');
  return proposal;
}

async function approvalUnionDigest(proposal: Extract<ApprovalUnionProposal, { status: 'candidate' }>): Promise<string> {
  const content = canonicalJson({ case: proposal.case, ledger: proposal.ledger });
  return sha256Hex(new TextEncoder().encode(content));
}

// The digest binds the full case and review ledger, including approved amounts and sources.
// A caller must still render those details for human review before supplying the command.
export async function digestDisjointApprovalCandidate(preview: ConflictPreview): Promise<string> {
  return approvalUnionDigest(availableApprovalUnion(preview));
}

function validJoinCommand(command: ApprovalJoinReviewCommand): boolean {
  return exactKeys(command, ['caseId', 'pendingOperationId', 'pendingRevisionId', 'pendingManifestDigest',
    'localRevisionId', 'remoteRevisionId', 'baseRevisionId', 'localHead', 'remoteHead',
    'localOnlyEventIds', 'remoteOnlyEventIds', 'candidateDigest', 'eventId', 'reviewId',
    'recordedAt']) &&
    [command.caseId, command.pendingOperationId, command.pendingRevisionId, command.localRevisionId,
      command.remoteRevisionId, command.baseRevisionId, command.localHead,
      command.remoteHead, command.eventId, command.reviewId].every(validId) &&
    /^[0-9a-f]{64}$/.test(command.pendingManifestDigest) &&
    /^[0-9a-f]{64}$/.test(command.candidateDigest) && validInstant(command.recordedAt) &&
    Array.isArray(command.localOnlyEventIds) && Array.isArray(command.remoteOnlyEventIds) &&
    command.localOnlyEventIds.length <= 200_000 &&
    command.remoteOnlyEventIds.length <= 200_000 &&
    [...command.localOnlyEventIds, ...command.remoteOnlyEventIds].every(validId);
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

// This prepares an in-memory result only. The caller must establish an actual human review
// and use a separate live-state checked atomic storage and publication transaction.
export async function prepareReviewedApprovalJoin(preview: ConflictPreview,
  command: ApprovalJoinReviewCommand, validateCase: CaseValidator): Promise<PreparedApprovalJoin> {
  if (!validJoinCommand(command)) throw new ConflictJoinError('INVALID_JOIN_COMMAND');
  const proposal = availableApprovalUnion(preview);
  if (preview.ancestor.status !== 'available' ||
      command.caseId !== preview.caseId ||
      command.pendingOperationId !== preview.pendingOperationId ||
      command.pendingRevisionId !== preview.pendingRevisionId ||
      command.pendingManifestDigest !== preview.pendingManifestDigest ||
      command.localRevisionId !== preview.local.revisionId ||
      command.remoteRevisionId !== preview.remote.revisionId ||
      command.baseRevisionId !== preview.ancestor.branch.revisionId ||
      !sameIds(command.localOnlyEventIds, proposal.localOnlyEventIds) ||
      !sameIds(command.remoteOnlyEventIds, proposal.remoteOnlyEventIds) ||
      command.candidateDigest !== await approvalUnionDigest(proposal)) {
    throw new ConflictJoinError('REVIEW_MISMATCH');
  }
  const localHeads = maximalHeads(preview.local.case.events);
  const remoteHeads = maximalHeads(preview.remote.case.events);
  const unionHeads = maximalHeads(proposal.case.events);
  const selected = [command.localHead, command.remoteHead].sort();
  if (localHeads.length !== 1 || remoteHeads.length !== 1 || unionHeads.length !== 2 ||
      localHeads[0] !== command.localHead || remoteHeads[0] !== command.remoteHead ||
      !Array.isArray(preview.local.heads) || !Array.isArray(preview.remote.heads) ||
      !sameIds(preview.local.heads, localHeads) || !sameIds(preview.remote.heads, remoteHeads) ||
      !sameIds(unionHeads, selected)) {
    throw new ConflictJoinError('AMBIGUOUS_HEADS');
  }
  const existingEvents = new Set(proposal.case.events.map((event) => event.eventId));
  const existingReviews = new Set(proposal.case.events.map((event) => {
    const payload = event.fact ?? event.correction ?? event.coverage ??
      event.retraction ?? event.decision ?? event.resolution;
    return payload?.reviewId;
  }));
  if (existingEvents.has(command.eventId) || existingReviews.has(command.reviewId)) {
    throw new ConflictJoinError('DUPLICATE_ID');
  }
  const joinEvent: CaseEvent = { eventId: command.eventId, parents: selected,
    recordedAt: command.recordedAt, kind: 'resolve_branches',
    resolution: { reviewId: command.reviewId } };
  const joined: CaseV1 = { ...proposal.case, events: [...proposal.case.events, joinEvent] };
  try {
    await validateCase(structuredClone(preview.ancestor.branch.case));
    await validateCase(structuredClone(preview.local.case));
    await validateCase(structuredClone(preview.remote.case));
    await validateCase(structuredClone(joined));
  } catch { throw new ConflictJoinError('INVALID_JOINED_CASE'); }
  if (!sameIds(maximalHeads(joined.events), [command.eventId])) {
    throw new ConflictJoinError('INVALID_JOINED_CASE');
  }
  return { case: joined, ledger: proposal.ledger,
    joinEventId: command.eventId, parentHeads: selected };
}
