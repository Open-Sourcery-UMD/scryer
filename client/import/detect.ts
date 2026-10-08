import { CSV_LIMITS, parseBoundedCsv } from './csv.ts';
import { ImportError } from './errors.ts';
import type { SourceDetection } from './types.ts';

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

function looksLikePdf(bytes: Uint8Array): boolean {
  for (let start = 0; start <= Math.min(bytes.length - PDF_MAGIC.length, 1024); start++) {
    if (PDF_MAGIC.every((value, offset) => bytes[start + offset] === value)) return true;
  }
  return false;
}

export function detectSource(bytes: Uint8Array): SourceDetection {
  if (!(bytes instanceof Uint8Array)) {
    return { outcome: 'UNSUPPORTED_INPUT', adapter: null, reasonCode: 'INVALID_INPUT' };
  }
  if (bytes.byteLength > CSV_LIMITS.inputBytes) {
    return { outcome: 'UNSUPPORTED_INPUT', adapter: null, reasonCode: 'INPUT_TOO_LARGE' };
  }
  if (bytes.byteLength === 0) {
    return { outcome: 'UNSUPPORTED_INPUT', adapter: null, reasonCode: 'EMPTY_INPUT' };
  }
  if (looksLikePdf(bytes)) {
    return { outcome: 'MANUAL_REQUIRED', adapter: null, reasonCode: 'PDF_LAYOUT_UNVERIFIED' };
  }
  try {
    const rows = parseBoundedCsv(bytes);
    if ((rows[0]?.length ?? 0) < 2) {
      return { outcome: 'UNSUPPORTED_INPUT', adapter: null, reasonCode: 'UNKNOWN_TEXT_FORMAT' };
    }
    return { outcome: 'SUPPORTED_CSV', adapter: 'generic-bank-csv-1', reasonCode: 'MAPPING_REQUIRED' };
  } catch (error) {
    if (error instanceof ImportError) {
      return { outcome: 'UNSUPPORTED_INPUT', adapter: null, reasonCode: error.code };
    }
    throw error;
  }
}
