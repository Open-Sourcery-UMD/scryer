import { csvParseRows } from '../vendor/d3-dsv/src/csv.js';

import { ImportError } from './errors.ts';

export const CSV_LIMITS = {
  inputBytes: 20 * 1024 * 1024,
  rows: 100_000,
  columns: 256,
  fieldBytes: 65_536,
  cells: 1_000_000,
} as const;

function scan(text: string): void {
  if (text.length === 0) throw new ImportError('INVALID_CSV');
  let state: 'start' | 'unquoted' | 'quoted' | 'afterQuote' = 'start';
  let row = 0;
  let columns = 1;
  let headerColumns = 0;
  let cells = 0;
  let fieldChars = 0;
  let afterRecord = false;

  const field = (): void => {
    if (fieldChars > CSV_LIMITS.fieldBytes) throw new ImportError('CSV_FIELD_LIMIT');
    fieldChars = 0;
    state = 'start';
  };
  const record = (): void => {
    cells += columns;
    if (cells > CSV_LIMITS.cells) throw new ImportError('CSV_CELL_LIMIT');
    if (row === 0) {
      headerColumns = columns;
    } else if (columns !== headerColumns) {
      throw new ImportError('INVALID_CSV');
    }
    row++;
    if (row - 1 > CSV_LIMITS.rows) throw new ImportError('CSV_ROW_LIMIT');
    columns = 1;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\0') throw new ImportError('INVALID_CSV');
    if (state === 'quoted') {
      if (char === '"') {
        if (text[index + 1] === '"') {
          index++;
          fieldChars++;
        } else {
          state = 'afterQuote';
        }
      } else if (char === '\r') {
        if (text[index + 1] !== '\n') throw new ImportError('INVALID_CSV');
        index++;
        fieldChars += 2;
      } else {
        fieldChars++;
      }
    } else if (char === ',') {
      field();
      columns++;
      if (columns > CSV_LIMITS.columns) throw new ImportError('CSV_COLUMN_LIMIT');
      afterRecord = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r') {
        if (text[index + 1] !== '\n') throw new ImportError('INVALID_CSV');
        index++;
      }
      field();
      record();
      afterRecord = true;
    } else if (state === 'afterQuote') {
      throw new ImportError('INVALID_CSV');
    } else if (char === '"') {
      if (state !== 'start') throw new ImportError('INVALID_CSV');
      state = 'quoted';
      afterRecord = false;
    } else {
      state = 'unquoted';
      fieldChars++;
      afterRecord = false;
    }
    if (fieldChars > CSV_LIMITS.fieldBytes) throw new ImportError('CSV_FIELD_LIMIT');
  }
  if (state === 'quoted') throw new ImportError('INVALID_CSV');
  if (!afterRecord) {
    field();
    record();
  }
}

export function parseBoundedCsv(bytes: Uint8Array): string[][] {
  if (bytes.byteLength > CSV_LIMITS.inputBytes) throw new ImportError('INPUT_TOO_LARGE');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ImportError('UNSUPPORTED_ENCODING');
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  scan(text);
  const rows = csvParseRows(text);
  if (rows.length === 0) throw new ImportError('INVALID_CSV');
  const headers = rows[0];
  if (headers === undefined || headers.length === 0) throw new ImportError('INVALID_CSV');
  const seen = new Set<string>();
  for (const header of headers) {
    if (header === '') throw new ImportError('INVALID_CSV');
    if (seen.has(header)) throw new ImportError('DUPLICATE_HEADER');
    seen.add(header);
  }
  const encoder = new TextEncoder();
  for (const row of rows) {
    for (const value of row) {
      if (encoder.encode(value).byteLength > CSV_LIMITS.fieldBytes) throw new ImportError('CSV_FIELD_LIMIT');
    }
  }
  return rows;
}
