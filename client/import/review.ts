import { extractBankCsv } from './bank.ts';
import { maximalHeads, validCaseShape } from './case-shape.ts';
import { CSV_LIMITS } from './csv.ts';
import { ImportError } from './errors.ts';
import { sha256Hex } from './hash.ts';
import { isPositiveMinor } from './money.ts';
import type {
  CaseEvent, CaseV1, CaseValidator, ExtractedBatch, ImportLedger, ImportReview,
  ReviewCommand, ReviewDecision, ReviewResult,
} from './types.ts';
import { exactKeys, validId, validInstant } from './validation.ts';

const SHA256 = /^[0-9a-f]{64}$/;

function validLedger(ledger: ImportLedger): void {
  if (!ledger || !exactKeys(ledger, ['schemaVersion', 'reviews']) ||
      ledger.schemaVersion !== '1' || !Array.isArray(ledger.reviews)) {
    throw new ImportError('INVALID_LEDGER');
  }
  const seenArtifacts = new Set<string>();
  const seenCommands = new Set<string>();
  for (const review of ledger.reviews) {
    if (!review || !validId(review.artifactId) || !validId(review.commandId) ||
        !SHA256.test(review.sha256) || !SHA256.test(review.decisionDigest) ||
        !Array.isArray(review.decisions) || seenArtifacts.has(review.artifactId) ||
        seenCommands.has(review.commandId)) {
      throw new ImportError('INVALID_LEDGER');
    }
    seenArtifacts.add(review.artifactId);
    seenCommands.add(review.commandId);
  }
}

function validBatch(batch: ExtractedBatch): void {
  if (!batch || !(batch.sourceBytes instanceof Uint8Array) || !batch.mapping ||
      !batch.artifact || !Array.isArray(batch.proposals) ||
      !Array.isArray(batch.candidates) || batch.proposals.length !== batch.candidates.length ||
      batch.proposals.length > 100_000 || batch.artifact.kind !== 'bank_transactions' ||
      !validId(batch.artifact.artifactId) || !validId(batch.artifact.accountRefId) ||
      !SHA256.test(batch.artifact.sha256) || !validInstant(batch.artifact.observedAt)) {
    throw new ImportError('INVALID_BATCH');
  }
  const seen = new Set<string>();
  for (let index = 0; index < batch.proposals.length; index++) {
    const proposal = batch.proposals[index];
    const candidate = batch.candidates[index];
    const expectedLocationPrefix = `row:${index + 2}:col:`;
    if (!proposal || !candidate || !Array.isArray(candidate.rawFields) ||
        !Array.isArray(candidate.warningCodes) || typeof proposal.sourceLocation !== 'string' ||
        !validId(proposal.proposalId) ||
        proposal.artifactId !== batch.artifact.artifactId ||
        proposal.proposalId !== candidate.proposalId ||
        proposal.sourceLocation !== candidate.sourceLocation ||
        !proposal.sourceLocation.startsWith(expectedLocationPrefix) ||
        !/^[1-9][0-9]*$/.test(proposal.sourceLocation.slice(expectedLocationPrefix.length)) ||
        proposal.proposalId !== `p_${batch.artifact.artifactId.slice(2, 50)}_${(index + 2).toString(36)}` ||
        proposal.parserVersion !== 'bank-csv-1' ||
        proposal.proposedAmountMinor !== candidate.amountMinor ||
        (candidate.direction === 'credit' && (!isPositiveMinor(candidate.amountMinor) || candidate.effectiveDate === null)) ||
        (candidate.direction !== 'credit' && proposal.proposedAmountMinor !== null) ||
        seen.has(proposal.proposalId)) {
      throw new ImportError('INVALID_BATCH');
    }
    seen.add(proposal.proposalId);
  }
}

function sameExtractedBatch(left: ExtractedBatch, right: ExtractedBatch): boolean {
  const a = left.artifact;
  const b = right.artifact;
  if (a.artifactId !== b.artifactId || a.sha256 !== b.sha256 || a.kind !== b.kind ||
      a.accountRefId !== b.accountRefId || a.observedAt !== b.observedAt ||
      left.proposals.length !== right.proposals.length || left.candidates.length !== right.candidates.length) {
    return false;
  }
  for (let index = 0; index < left.proposals.length; index++) {
    const first = left.proposals[index];
    const second = right.proposals[index];
    const firstCandidate = left.candidates[index];
    const secondCandidate = right.candidates[index];
    if (!first || !second || !firstCandidate || !secondCandidate ||
        first.proposalId !== second.proposalId || first.artifactId !== second.artifactId ||
        first.sourceLocation !== second.sourceLocation || first.rawValue !== second.rawValue ||
        first.parserVersion !== second.parserVersion || first.mappingVersion !== second.mappingVersion ||
        first.proposedAmountMinor !== second.proposedAmountMinor ||
        firstCandidate.proposalId !== secondCandidate.proposalId ||
        firstCandidate.sourceLocation !== secondCandidate.sourceLocation ||
        firstCandidate.effectiveDate !== secondCandidate.effectiveDate ||
        firstCandidate.direction !== secondCandidate.direction ||
        firstCandidate.amountMinor !== secondCandidate.amountMinor ||
        firstCandidate.rawFields.length !== secondCandidate.rawFields.length ||
        firstCandidate.warningCodes.length !== secondCandidate.warningCodes.length ||
        firstCandidate.rawFields.some((value, position) => value !== secondCandidate.rawFields[position]) ||
        firstCandidate.warningCodes.some((value, position) => value !== secondCandidate.warningCodes[position])) {
      return false;
    }
  }
  return true;
}

function validCommand(command: ReviewCommand): void {
  if (!exactKeys(command, ['commandId', 'recordedAt', 'baseHead']) ||
      !validId(command.commandId) || !validInstant(command.recordedAt) ||
      (command.baseHead !== null && !validId(command.baseHead))) {
    throw new ImportError('INVALID_REVIEW_COMMAND');
  }
}

function normalizeDecisions(batch: ExtractedBatch, decisions: readonly ReviewDecision[]): ReviewDecision[] {
  if (!Array.isArray(decisions)) {
    throw new ImportError('INCOMPLETE_REVIEW');
  }
  const byId = new Map<string, ReviewDecision>();
  for (const decision of decisions) {
    if (!decision || !validId(decision.proposalId)) throw new ImportError('INVALID_REVIEW_DECISION');
    if (byId.has(decision.proposalId)) throw new ImportError('DUPLICATE_DECISION');
    byId.set(decision.proposalId, decision);
  }
  if (decisions.length !== batch.proposals.length) throw new ImportError('INCOMPLETE_REVIEW');
  const ordered: ReviewDecision[] = [];
  for (let index = 0; index < batch.proposals.length; index++) {
    const proposal = batch.proposals[index];
    const candidate = batch.candidates[index];
    if (!proposal || !candidate) throw new ImportError('INVALID_BATCH');
    const decision = byId.get(proposal.proposalId);
    if (!decision) throw new ImportError('INCOMPLETE_REVIEW');
    if (decision.action === 'reject' || decision.action === 'exclude') {
      if (!exactKeys(decision, ['proposalId', 'action'])) throw new ImportError('INVALID_REVIEW_DECISION');
      ordered.push({ proposalId: decision.proposalId, action: decision.action });
      continue;
    }
    if (decision.action !== 'approve' && decision.action !== 'edit') {
      throw new ImportError('INVALID_REVIEW_DECISION');
    }
    if (candidate.direction !== 'credit' || candidate.effectiveDate === null ||
        !isPositiveMinor(proposal.proposedAmountMinor)) {
      throw new ImportError('UNAPPROVABLE_CANDIDATE');
    }
    if (!validId(decision.factId) || !validId(decision.eventId) || !validId(decision.reviewId)) {
      throw new ImportError('INVALID_REVIEW_DECISION');
    }
    if (decision.action === 'approve') {
      if (!exactKeys(decision, ['proposalId', 'action', 'factId', 'eventId', 'reviewId'])) {
        throw new ImportError('INVALID_REVIEW_DECISION');
      }
      ordered.push({ proposalId: decision.proposalId, action: 'approve',
        factId: decision.factId, eventId: decision.eventId, reviewId: decision.reviewId });
    } else {
      if (!exactKeys(decision, ['proposalId', 'action', 'amountMinor', 'factId', 'eventId', 'reviewId'])) {
        throw new ImportError('INVALID_REVIEW_DECISION');
      }
      if (!isPositiveMinor(decision.amountMinor)) throw new ImportError('INVALID_MONEY');
      ordered.push({ proposalId: decision.proposalId, action: 'edit', amountMinor: decision.amountMinor,
        factId: decision.factId, eventId: decision.eventId, reviewId: decision.reviewId });
    }
  }
  if (byId.size !== ordered.length) throw new ImportError('INVALID_REVIEW_DECISION');
  return ordered;
}

async function decisionDigest(batch: ExtractedBatch, decisions: readonly ReviewDecision[], command: ReviewCommand): Promise<string> {
  const canonical = JSON.stringify({
    artifactId: batch.artifact.artifactId, sha256: batch.artifact.sha256,
    accountRefId: batch.artifact.accountRefId, parserVersion: 'bank-csv-1',
    commandId: command.commandId, recordedAt: command.recordedAt, baseHead: command.baseHead,
    proposals: batch.proposals.map((proposal) => ({
      proposalId: proposal.proposalId, sourceLocation: proposal.sourceLocation,
      rawValue: proposal.rawValue, parserVersion: proposal.parserVersion,
      mappingVersion: proposal.mappingVersion, proposedAmountMinor: proposal.proposedAmountMinor,
    })),
    decisions,
  });
  return sha256Hex(new TextEncoder().encode(canonical));
}

function checkNewIds(caseData: CaseV1, decisions: readonly ReviewDecision[]): void {
  const events = new Set(caseData.events.map((event) => event.eventId));
  const facts = new Set(caseData.events.flatMap((event) => event.fact ? [event.fact.factId] : []));
  const reviews = new Set(caseData.events.flatMap((event) => {
    const payload = event.fact ?? event.correction ?? event.coverage ?? event.retraction ?? event.decision ?? event.resolution;
    return payload ? [payload.reviewId] : [];
  }));
  for (const decision of decisions) {
    if (decision.action === 'reject' || decision.action === 'exclude') continue;
    if (events.has(decision.eventId) || facts.has(decision.factId) || reviews.has(decision.reviewId)) {
      throw new ImportError('DUPLICATE_ID');
    }
    events.add(decision.eventId);
    facts.add(decision.factId);
    reviews.add(decision.reviewId);
  }
}

function verifyPriorReview(caseData: CaseV1, batch: ExtractedBatch, prior: ImportReview): void {
  const artifact = caseData.artifacts.find((item) => item.artifactId === prior.artifactId);
  if (!artifact || artifact.sha256 !== batch.artifact.sha256 ||
      artifact.accountRefId !== batch.artifact.accountRefId ||
      artifact.kind !== batch.artifact.kind || artifact.observedAt !== batch.artifact.observedAt ||
      prior.decisions.length !== batch.proposals.length) {
    throw new ImportError('INVALID_LEDGER');
  }
  let parent = prior.baseHead;
  for (let index = 0; index < batch.proposals.length; index++) {
    const proposal = batch.proposals[index];
    const candidate = batch.candidates[index];
    const decision = prior.decisions[index];
    if (!proposal || !candidate || !decision || decision.proposalId !== proposal.proposalId) {
      throw new ImportError('INVALID_LEDGER');
    }
    const stored = caseData.proposals.find((item) => item.proposalId === proposal.proposalId);
    if (!stored || stored.artifactId !== proposal.artifactId ||
        stored.sourceLocation !== proposal.sourceLocation || stored.rawValue !== proposal.rawValue ||
        stored.parserVersion !== proposal.parserVersion ||
        stored.mappingVersion !== proposal.mappingVersion ||
        stored.proposedAmountMinor !== proposal.proposedAmountMinor) {
      throw new ImportError('INVALID_LEDGER');
    }
    if (decision.action === 'reject' || decision.action === 'exclude') continue;
    if (decision.action !== 'approve' && decision.action !== 'edit') {
      throw new ImportError('INVALID_LEDGER');
    }
    const event = caseData.events.find((item) => item.eventId === decision.eventId);
    const fact = event?.fact;
    const source = fact?.source;
    const expectedAmount = decision.action === 'edit' ? decision.amountMinor : proposal.proposedAmountMinor;
    if (!event || event.kind !== 'approve_fact' || event.recordedAt !== prior.recordedAt ||
        event.parents.length !== (parent === null ? 0 : 1) ||
        (parent !== null && event.parents[0] !== parent) ||
        !fact || fact.factId !== decision.factId || fact.reviewId !== decision.reviewId ||
        fact.proposalId !== proposal.proposalId || fact.role !== 'bank_credit_observed' ||
        fact.accountRefId !== prior.accountRefId || fact.amountMinor !== expectedAmount ||
        fact.effectiveDate !== candidate.effectiveDate ||
        typeof source !== 'object' || source === null || !('kind' in source) ||
        source.kind !== 'artifact' || !('artifactId' in source) ||
        source.artifactId !== prior.artifactId || !('location' in source) ||
        source.location !== proposal.sourceLocation) {
      throw new ImportError('INVALID_LEDGER');
    }
    parent = decision.eventId;
  }
}

export async function reviewImport(
  caseData: CaseV1,
  ledger: ImportLedger,
  batch: ExtractedBatch,
  decisions: readonly ReviewDecision[],
  command: ReviewCommand,
  validateCase: CaseValidator,
): Promise<ReviewResult> {
  if (typeof validateCase !== 'function') throw new ImportError('VALIDATOR_REQUIRED');
  if (batch?.sourceBytes instanceof Uint8Array && batch.sourceBytes.byteLength > CSV_LIMITS.inputBytes) {
    throw new ImportError('INPUT_TOO_LARGE');
  }
  try {
    caseData = structuredClone(caseData);
    ledger = structuredClone(ledger);
    batch = structuredClone(batch);
    decisions = structuredClone(decisions);
    command = structuredClone(command);
  } catch {
    throw new ImportError('INVALID_INPUT');
  }
  validCaseShape(caseData);
  validLedger(ledger);
  validBatch(batch);
  validCommand(command);
  let replay: ExtractedBatch;
  try {
    replay = await extractBankCsv(batch.sourceBytes, {
      accountRefId: batch.artifact.accountRefId, observedAt: batch.artifact.observedAt,
    }, batch.mapping);
  } catch (error) {
    if (error instanceof ImportError && error.code === 'CRYPTO_UNAVAILABLE') throw error;
    throw new ImportError('INVALID_BATCH');
  }
  if (!sameExtractedBatch(batch, replay)) throw new ImportError('INVALID_BATCH');
  const ordered = normalizeDecisions(batch, decisions);
  const digest = await decisionDigest(batch, ordered, command);
  await validateCase(structuredClone(caseData));

  const prior = ledger.reviews.find((review) => review.artifactId === batch.artifact.artifactId);
  const existingArtifact = caseData.artifacts.find((artifact) => artifact.artifactId === batch.artifact.artifactId);
  if (existingArtifact && !prior) throw new ImportError('IMPORT_LEDGER_MISSING');
  if (prior) {
    if (!existingArtifact || existingArtifact.sha256 !== batch.artifact.sha256 ||
        existingArtifact.accountRefId !== batch.artifact.accountRefId ||
        prior.sha256 !== batch.artifact.sha256 || prior.accountRefId !== batch.artifact.accountRefId ||
        prior.decisionDigest !== digest) {
      throw new ImportError('IMPORT_CONFLICT');
    }
    const priorDigest = await decisionDigest(batch, prior.decisions, {
      commandId: prior.commandId, recordedAt: prior.recordedAt, baseHead: prior.baseHead,
    });
    if (priorDigest !== prior.decisionDigest) throw new ImportError('INVALID_LEDGER');
    verifyPriorReview(caseData, batch, prior);
    return { case: caseData, ledger, applied: false };
  }
  if (ledger.reviews.some((review) => review.commandId === command.commandId) ||
      caseData.artifacts.some((artifact) => artifact.sha256 === batch.artifact.sha256 &&
        artifact.accountRefId === batch.artifact.accountRefId)) {
    throw new ImportError('IMPORT_CONFLICT');
  }
  const heads = maximalHeads(caseData.events);
  if (heads.length > 1) throw new ImportError('AMBIGUOUS_HEADS');
  if ((heads[0] ?? null) !== command.baseHead) throw new ImportError('STALE_HEAD');
  if (batch.artifact.observedAt > command.recordedAt) throw new ImportError('INVALID_REVIEW_COMMAND');
  checkNewIds(caseData, ordered);

  const nextCase = structuredClone(caseData);
  const nextEvents: CaseEvent[] = [...nextCase.events];
  let parent = command.baseHead;
  for (let index = 0; index < ordered.length; index++) {
    const decision = ordered[index];
    if (!decision || decision.action === 'reject' || decision.action === 'exclude') continue;
    const proposal = batch.proposals[index];
    const candidate = batch.candidates[index];
    if (!proposal || !candidate || candidate.effectiveDate === null) throw new ImportError('INVALID_BATCH');
    const amount = decision.action === 'edit' ? decision.amountMinor : proposal.proposedAmountMinor;
    if (!isPositiveMinor(amount)) throw new ImportError('INVALID_MONEY');
    nextEvents.push({
      eventId: decision.eventId, parents: parent === null ? [] : [parent],
      recordedAt: command.recordedAt, kind: 'approve_fact',
      fact: {
        factId: decision.factId, termId: null, accountRefId: batch.artifact.accountRefId,
        aidItemId: null, currency: 'USD', role: 'bank_credit_observed',
        recipientKind: null, amountMinor: amount, proposalId: proposal.proposalId,
        effectiveDate: candidate.effectiveDate,
        source: { kind: 'artifact', artifactId: proposal.artifactId, location: proposal.sourceLocation },
        reviewId: decision.reviewId,
      },
    });
    parent = decision.eventId;
  }
  nextCase.artifacts = [...nextCase.artifacts, batch.artifact];
  nextCase.proposals = [...nextCase.proposals, ...batch.proposals];
  nextCase.events = nextEvents;
  const review: ImportReview = {
    artifactId: batch.artifact.artifactId, sha256: batch.artifact.sha256,
    accountRefId: batch.artifact.accountRefId, commandId: command.commandId,
    recordedAt: command.recordedAt, baseHead: command.baseHead,
    decisions: ordered, decisionDigest: digest,
  };
  const nextLedger: ImportLedger = { schemaVersion: '1', reviews: [...structuredClone(ledger.reviews), review] };
  await validateCase(structuredClone(nextCase));
  return { case: nextCase, ledger: nextLedger, applied: true };
}
