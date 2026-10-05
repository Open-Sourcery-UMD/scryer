import { validId } from '../crypto/codec.ts';
import type { CaseEvent, CaseV1 } from '../import/types.ts';
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

const CASE_FIELDS = ['institutions', 'accountRefs', 'terms', 'aidItems',
  'artifacts', 'proposals'] as const;

export class ConflictAnalysisError extends Error {
  readonly code = 'INVALID_CONFLICT_PREVIEW';
  constructor() { super('INVALID_CONFLICT_PREVIEW'); this.name = 'ConflictAnalysisError'; }
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
