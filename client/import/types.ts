export type BankCsvMetadata = {
  accountRefId: string;
  observedAt: string;
};

export type SignedMapping = {
  kind: 'signed';
  dateColumn: string;
  amountColumn: string;
  mappingVersion: string;
};

export type SplitMapping = {
  kind: 'split';
  dateColumn: string;
  creditColumn: string;
  debitColumn: string;
  mappingVersion: string;
};

export type BankCsvMapping = SignedMapping | SplitMapping;

export type Artifact = {
  artifactId: string;
  sha256: string;
  kind: 'bank_transactions';
  observedAt: string;
  accountRefId: string;
};

export type Proposal = {
  proposalId: string;
  artifactId: string;
  sourceLocation: string;
  rawValue: string;
  parserVersion: 'bank-csv-1';
  mappingVersion: string;
  proposedAmountMinor: string | null;
};

export type Candidate = {
  proposalId: string;
  sourceLocation: string;
  rawFields: readonly string[];
  effectiveDate: string | null;
  direction: 'credit' | 'debit' | 'unresolved';
  amountMinor: string | null;
  warningCodes: readonly string[];
};

export type ExtractedBatch = {
  sourceBytes: Uint8Array;
  mapping: BankCsvMapping;
  artifact: Artifact;
  proposals: readonly Proposal[];
  candidates: readonly Candidate[];
};

export type CaseEvent = {
  eventId: string;
  parents: readonly string[];
  recordedAt: string;
  kind: string;
  fact?: { factId: string; reviewId: string; proposalId: string | null; [key: string]: unknown };
  correction?: { reviewId: string; [key: string]: unknown };
  coverage?: { reviewId: string };
  retraction?: { reviewId: string };
  decision?: { reviewId: string };
};

export type CaseV1 = {
  schemaVersion: '1';
  caseId: string;
  currency: 'USD';
  institutions: readonly unknown[];
  accountRefs: readonly { accountRefId: string; kind: string; [key: string]: unknown }[];
  terms: readonly unknown[];
  aidItems: readonly unknown[];
  artifacts: readonly { artifactId: string; sha256: string; accountRefId: string | null; [key: string]: unknown }[];
  proposals: readonly Proposal[];
  events: readonly CaseEvent[];
};

export type ApproveDecision = {
  proposalId: string;
  action: 'approve';
  factId: string;
  eventId: string;
  reviewId: string;
};

export type EditDecision = {
  proposalId: string;
  action: 'edit';
  amountMinor: string;
  factId: string;
  eventId: string;
  reviewId: string;
};

export type DeclineDecision =
  | { proposalId: string; action: 'reject' }
  | { proposalId: string; action: 'exclude' };
export type ReviewDecision = ApproveDecision | EditDecision | DeclineDecision;

export type ReviewCommand = {
  commandId: string;
  recordedAt: string;
  baseHead: string | null;
};

export type ImportReview = {
  artifactId: string;
  sha256: string;
  accountRefId: string;
  commandId: string;
  recordedAt: string;
  baseHead: string | null;
  decisions: readonly ReviewDecision[];
  decisionDigest: string;
};

export type ImportLedger = { schemaVersion: '1'; reviews: readonly ImportReview[] };
export type ReviewResult = { case: CaseV1; ledger: ImportLedger; applied: boolean };
export type CaseValidator = (caseData: CaseV1) => Promise<void>;

export type ManualRole = 'school_credit' | 'school_charge' | 'refund_issued' | 'bank_credit_observed';
export type RecipientKind = 'student' | 'parent' | 'third_party' | 'unknown';
export type ManualFactInput = {
  eventId: string;
  factId: string;
  reviewId: string;
  sourceEntryId: string;
  recordedAt: string;
  baseHead: string | null;
  role: ManualRole;
  termId: string | null;
  accountRefId: string;
  recipientKind: RecipientKind | null;
  amountMinor: string;
  effectiveDate: string | null;
};
export type ManualCorrectionInput = {
  eventId: string;
  reviewId: string;
  sourceEntryId: string;
  factId: string;
  recordedAt: string;
  baseHead: string | null;
  cancelled: boolean;
  replacementAmountMinor: string | null;
};

export type SourceDetection =
  | { outcome: 'SUPPORTED_CSV'; adapter: 'generic-bank-csv-1'; reasonCode: 'MAPPING_REQUIRED' }
  | { outcome: 'MANUAL_REQUIRED'; adapter: null; reasonCode: 'PDF_LAYOUT_UNVERIFIED' }
  | { outcome: 'UNSUPPORTED_INPUT'; adapter: null; reasonCode: string };
