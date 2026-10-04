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
  artifact: Artifact;
  proposals: readonly Proposal[];
  candidates: readonly Candidate[];
};
