import { ImportError } from './errors.ts';
import type { CaseEvent, CaseV1 } from './types.ts';
import { validId } from './validation.ts';

export function validCaseShape(caseData: CaseV1): void {
  if (!caseData || caseData.schemaVersion !== '1' || caseData.currency !== 'USD' ||
      !Array.isArray(caseData.accountRefs) || !Array.isArray(caseData.artifacts) ||
      !Array.isArray(caseData.proposals) || !Array.isArray(caseData.events)) {
    throw new ImportError('INVALID_CASE');
  }
  for (const event of caseData.events) {
    if (!event || !validId(event.eventId) || !Array.isArray(event.parents) ||
        event.parents.some((parent: unknown) => !validId(parent))) {
      throw new ImportError('INVALID_CASE');
    }
  }
}

export function maximalHeads(events: readonly CaseEvent[]): string[] {
  const ids = new Set<string>();
  const parents = new Set<string>();
  for (const event of events) {
    ids.add(event.eventId);
    for (const parent of event.parents) parents.add(parent);
  }
  return [...ids].filter((id) => !parents.has(id)).sort();
}
