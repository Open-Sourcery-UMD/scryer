import { parseBoundedCsv } from './csv.ts';
import { ImportError } from './errors.ts';
import { parseUsAmount } from './money.ts';
import type { BankCsvMapping, BankCsvMetadata, Candidate, ExtractedBatch, Proposal } from './types.ts';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const ISO_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validInstant(value: string): boolean {
  if (!UTC.test(value) || value.startsWith('0000-')) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().replace('.000', '') === value;
}

function validateInputs(metadata: BankCsvMetadata, mapping: BankCsvMapping): void {
  if (!exactKeys(metadata, ['accountRefId', 'observedAt']) ||
      typeof metadata.accountRefId !== 'string' || typeof metadata.observedAt !== 'string' ||
      !ID.test(metadata.accountRefId) || !validInstant(metadata.observedAt)) {
    throw new ImportError('INVALID_METADATA');
  }
  if (typeof mapping !== 'object' || mapping === null ||
      typeof mapping.mappingVersion !== 'string' || typeof mapping.dateColumn !== 'string' ||
      !VERSION.test(mapping.mappingVersion) || mapping.dateColumn.length === 0) {
    throw new ImportError('INVALID_MAPPING');
  }
  if (mapping.kind === 'signed') {
    if (typeof mapping.amountColumn !== 'string' || mapping.amountColumn.length === 0 ||
        mapping.amountColumn === mapping.dateColumn ||
        !exactKeys(mapping, ['amountColumn', 'dateColumn', 'kind', 'mappingVersion'])) {
      throw new ImportError('INVALID_MAPPING');
    }
  } else if (mapping.kind === 'split') {
    if (typeof mapping.creditColumn !== 'string' || typeof mapping.debitColumn !== 'string' ||
        mapping.creditColumn.length === 0 || mapping.debitColumn.length === 0 ||
        new Set([mapping.dateColumn, mapping.creditColumn, mapping.debitColumn]).size !== 3 ||
        !exactKeys(mapping, ['creditColumn', 'dateColumn', 'debitColumn', 'kind', 'mappingVersion'])) {
      throw new ImportError('INVALID_MAPPING');
    }
  } else {
    throw new ImportError('INVALID_MAPPING');
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new ImportError('CRYPTO_UNAVAILABLE');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function column(headers: readonly string[], name: string): number {
  const index = headers.indexOf(name);
  if (index < 0) throw new ImportError('MISSING_HEADER');
  return index;
}

export async function extractBankCsv(
  bytes: Uint8Array,
  metadata: BankCsvMetadata,
  mapping: BankCsvMapping,
): Promise<ExtractedBatch> {
  if (!(bytes instanceof Uint8Array)) throw new ImportError('INVALID_INPUT');
  validateInputs(metadata, mapping);
  const rows = parseBoundedCsv(bytes);
  const headers = rows[0];
  if (headers === undefined) throw new ImportError('INVALID_CSV');
  const dateIndex = column(headers, mapping.dateColumn);
  const amountIndex = mapping.kind === 'signed' ? column(headers, mapping.amountColumn) :
    column(headers, mapping.creditColumn);
  const debitIndex = mapping.kind === 'split' ? column(headers, mapping.debitColumn) : -1;
  const rawDigest = await sha256Hex(bytes);
  const idDigest = await sha256Hex(new TextEncoder().encode(`scryer:artifact-id:v1\0${metadata.accountRefId}\0${rawDigest}`));
  const artifactId = `a_${idDigest.slice(0, 62)}`;
  const proposals: Proposal[] = [];
  const candidates: Candidate[] = [];

  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    if (row === undefined) throw new ImportError('INVALID_CSV');
    const rawDate = row[dateIndex];
    if (rawDate === undefined) throw new ImportError('INVALID_CSV');
    const date = validDate(rawDate) ? rawDate : null;
    const warnings: string[] = [];
    if (date === null) warnings.push('INVALID_DATE');
    let sourceColumn = amountIndex;
    let rawAmount = row[amountIndex];
    if (rawAmount === undefined) throw new ImportError('INVALID_CSV');
    let amount = null;
    let direction: Candidate['direction'] = 'unresolved';

    if (mapping.kind === 'split') {
      const rawDebit = row[debitIndex];
      if (rawDebit === undefined) throw new ImportError('INVALID_CSV');
      const hasCredit = rawAmount.trim() !== '';
      const hasDebit = rawDebit.trim() !== '';
      if (hasCredit && hasDebit) {
        warnings.push('AMBIGUOUS_AMOUNT');
      } else if (!hasCredit && !hasDebit) {
        warnings.push('MISSING_AMOUNT');
      } else {
        if (hasDebit) {
          sourceColumn = debitIndex;
          rawAmount = rawDebit;
        }
        amount = parseUsAmount(rawAmount);
        if (amount === null || amount.sign !== 1) {
          warnings.push('INVALID_AMOUNT');
        } else if (hasDebit) {
          direction = 'debit';
          warnings.push('DEBIT_NOT_SUPPORTED');
        } else {
          direction = 'credit';
        }
      }
    } else if (rawAmount.trim() === '') {
      warnings.push('MISSING_AMOUNT');
    } else {
      amount = parseUsAmount(rawAmount);
      if (amount === null) {
        warnings.push('INVALID_AMOUNT');
      } else if (amount.sign === 0) {
        warnings.push('ZERO_AMOUNT');
      } else if (amount.sign === -1) {
        direction = 'debit';
        warnings.push('DEBIT_NOT_SUPPORTED');
      } else {
        direction = 'credit';
      }
    }

    if (date === null) direction = 'unresolved';
    warnings.sort();
    const sourceLocation = `row:${index + 1}:col:${sourceColumn + 1}`;
    const proposalId = `p_${idDigest.slice(0, 48)}_${(index + 1).toString(36)}`;
    const proposedAmountMinor = direction === 'credit' && amount !== null ? amount.minor : null;
    proposals.push({
      proposalId, artifactId, sourceLocation, rawValue: rawAmount,
      parserVersion: 'bank-csv-1', mappingVersion: mapping.mappingVersion,
      proposedAmountMinor,
    });
    candidates.push({
      proposalId, sourceLocation, rawFields: [...row], effectiveDate: date,
      direction, amountMinor: proposedAmountMinor, warningCodes: warnings,
    });
  }

  return {
    artifact: {
      artifactId, sha256: rawDigest, kind: 'bank_transactions',
      observedAt: metadata.observedAt, accountRefId: metadata.accountRefId,
    },
    proposals,
    candidates,
  };
}
