import { ImportError } from './errors.ts';
import { maximalHeads, validCaseShape } from './case-shape.ts';
import { isNonnegativeMinor, isPositiveMinor } from './money.ts';
import type { CaseV1, CaseValidator, ManualCorrectionInput, ManualFactInput } from './types.ts';
import { exactKeys, validDate, validId, validInstant } from './validation.ts';

const RECIPIENT_KINDS = new Set(['student', 'parent', 'third_party', 'unknown']);
const ROLES = new Set(['school_credit', 'school_charge', 'refund_issued', 'bank_credit_observed']);

function validBaseFields(input: {
  eventId: string; reviewId: string; sourceEntryId: string; recordedAt: string; baseHead: string | null;
}): boolean {
  return validId(input.eventId) && validId(input.reviewId) && validId(input.sourceEntryId) &&
    validInstant(input.recordedAt) && (input.baseHead === null || validId(input.baseHead));
}

async function prepare(caseData: CaseV1, baseHead: string | null, validateCase: CaseValidator): Promise<CaseV1> {
  validCaseShape(caseData);
  await validateCase(structuredClone(caseData));
  const heads = maximalHeads(caseData.events);
  if (heads.length > 1) throw new ImportError('AMBIGUOUS_HEADS');
  if ((heads[0] ?? null) !== baseHead) throw new ImportError('STALE_HEAD');
  return caseData;
}

function copyInputs<T>(caseData: CaseV1, input: T): { caseData: CaseV1; input: T } {
  try {
    return { caseData: structuredClone(caseData), input: structuredClone(input) };
  } catch {
    throw new ImportError('INVALID_INPUT');
  }
}

export async function manualFact(
  caseData: CaseV1, input: ManualFactInput, validateCase: CaseValidator,
): Promise<CaseV1> {
  if (typeof validateCase !== 'function') throw new ImportError('VALIDATOR_REQUIRED');
  ({ caseData, input } = copyInputs(caseData, input));
  if (!exactKeys(input, [
    'eventId', 'factId', 'reviewId', 'sourceEntryId', 'recordedAt', 'baseHead',
    'role', 'termId', 'accountRefId', 'recipientKind', 'amountMinor', 'effectiveDate',
  ]) || !validBaseFields(input) || !validId(input.factId) || !validId(input.accountRefId) ||
      (input.termId !== null && !validId(input.termId)) ||
      (input.effectiveDate !== null && !validDate(input.effectiveDate))) {
    throw new ImportError('INVALID_MANUAL_FACT');
  }
  if (!ROLES.has(input.role)) throw new ImportError('UNSUPPORTED_MANUAL_ROLE');
  if (!isPositiveMinor(input.amountMinor)) throw new ImportError('INVALID_MONEY');
  if (input.role === 'bank_credit_observed') {
    if (input.termId !== null || input.recipientKind !== null) throw new ImportError('INVALID_MANUAL_FACT');
  } else if (input.termId === null) {
    throw new ImportError('INVALID_MANUAL_FACT');
  }
  if (input.role === 'refund_issued') {
    if (!RECIPIENT_KINDS.has(input.recipientKind ?? '')) throw new ImportError('INVALID_MANUAL_FACT');
  } else if (input.recipientKind !== null) {
    throw new ImportError('INVALID_MANUAL_FACT');
  }
  await prepare(caseData, input.baseHead, validateCase);
  const next = structuredClone(caseData);
  next.events = [...next.events, {
    eventId: input.eventId, parents: input.baseHead === null ? [] : [input.baseHead],
    recordedAt: input.recordedAt, kind: 'approve_fact',
    fact: {
      factId: input.factId, termId: input.termId, accountRefId: input.accountRefId,
      aidItemId: null, currency: 'USD', role: input.role, recipientKind: input.recipientKind,
      amountMinor: input.amountMinor, proposalId: null, effectiveDate: input.effectiveDate,
      source: { kind: 'manual', entryId: input.sourceEntryId }, reviewId: input.reviewId,
    },
  }];
  await validateCase(structuredClone(next));
  return next;
}

export async function manualCorrection(
  caseData: CaseV1, input: ManualCorrectionInput, validateCase: CaseValidator,
): Promise<CaseV1> {
  if (typeof validateCase !== 'function') throw new ImportError('VALIDATOR_REQUIRED');
  ({ caseData, input } = copyInputs(caseData, input));
  if (!exactKeys(input, [
    'eventId', 'reviewId', 'sourceEntryId', 'factId', 'recordedAt', 'baseHead',
    'cancelled', 'replacementAmountMinor',
  ]) || !validBaseFields(input) || !validId(input.factId) ||
      typeof input.cancelled !== 'boolean' ||
      (input.cancelled && input.replacementAmountMinor !== null) ||
      (!input.cancelled && !isNonnegativeMinor(input.replacementAmountMinor))) {
    throw new ImportError('INVALID_MANUAL_CORRECTION');
  }
  await prepare(caseData, input.baseHead, validateCase);
  const next = structuredClone(caseData);
  const approvalEvent = next.events.find((event) => event.kind === 'approve_fact' &&
    event.fact?.factId === input.factId);
  if (!approvalEvent) throw new ImportError('MISSING_FACT');
  const parents = input.baseHead === null ? [] : [input.baseHead];
  if (!parents.includes(approvalEvent.eventId)) parents.push(approvalEvent.eventId);
  next.events = [...next.events, {
    eventId: input.eventId, parents,
    recordedAt: input.recordedAt, kind: 'correct_fact',
    correction: {
      factId: input.factId, replacementAmountMinor: input.replacementAmountMinor,
      cancelled: input.cancelled, source: { kind: 'manual', entryId: input.sourceEntryId },
      reviewId: input.reviewId,
    },
  }];
  await validateCase(structuredClone(next));
  return next;
}
