import { CSV_LIMITS } from './csv.ts';
import { ImportError } from './errors.ts';
import type {
  BankCsvMapping, BankCsvMetadata, ExtractedBatch, ImportWorkerRequest, SourceDetection,
} from './types.ts';

export type ImportSource = File | Uint8Array;
export type WorkerOptions = { signal?: AbortSignal; timeoutMs?: number };

let nextRequestId = 1;

function aborted(signal: AbortSignal): ImportError {
  return new ImportError(signal.reason === 'TIMED_OUT' ? 'TIMED_OUT' : 'CANCELLED');
}

function readFile(file: File, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const onAbort = (): void => reader.abort();
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    reader.onload = (): void => {
      cleanup();
      if (signal.aborted) reject(aborted(signal));
      else if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new ImportError('FILE_READ_FAILED'));
    };
    reader.onerror = (): void => { cleanup(); reject(new ImportError('FILE_READ_FAILED')); };
    reader.onabort = (): void => { cleanup(); reject(aborted(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { cleanup(); reject(aborted(signal)); return; }
    try {
      reader.readAsArrayBuffer(file);
    } catch {
      cleanup();
      reject(new ImportError('FILE_READ_FAILED'));
    }
  });
}

async function bytesFrom(source: ImportSource, signal: AbortSignal): Promise<Uint8Array> {
  if (source instanceof Uint8Array) {
    if (source.byteLength > CSV_LIMITS.inputBytes) throw new ImportError('INPUT_TOO_LARGE');
    return new Uint8Array(source);
  }
  if (!(source instanceof File)) throw new ImportError('INVALID_INPUT');
  if (source.size > CSV_LIMITS.inputBytes) throw new ImportError('INPUT_TOO_LARGE');
  return readFile(source, signal);
}

function responseFor<T>(operation: 'detect' | 'extractBankCsv', bytes: Uint8Array,
  signal: AbortSignal, metadata?: BankCsvMetadata, mapping?: BankCsvMapping): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted(signal)); return; }
    const requestId = nextRequestId++;
    if (nextRequestId > Number.MAX_SAFE_INTEGER) nextRequestId = 1;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch {
      reject(new ImportError('WORKER_FAILURE'));
      return;
    }
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
    };
    const finish = (error: ImportError | null, result?: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result as T);
    };
    const onAbort = (): void => finish(aborted(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onerror = (): void => finish(new ImportError('WORKER_FAILURE'));
    worker.onmessage = (event: MessageEvent<unknown>): void => {
      const response = event.data;
      if (typeof response !== 'object' || response === null ||
          !('schemaVersion' in response) || response.schemaVersion !== '1' ||
          !('requestId' in response) || response.requestId !== requestId ||
          !('status' in response)) {
        finish(new ImportError('WORKER_PROTOCOL'));
        return;
      }
      if (response.status === 'error' && 'errorCode' in response &&
          typeof response.errorCode === 'string') {
        finish(new ImportError(response.errorCode));
      } else if (response.status === 'ok' && 'result' in response &&
          'operation' in response && response.operation === operation) {
        finish(null, response.result as T);
      } else {
        finish(new ImportError('WORKER_PROTOCOL'));
      }
    };
    const transferred = bytes.buffer;
    if (!(transferred instanceof ArrayBuffer)) {
      finish(new ImportError('INVALID_INPUT'));
      return;
    }
    try {
      const request: ImportWorkerRequest = operation === 'detect' ?
        { schemaVersion: '1', requestId, operation, bytes: transferred } :
        { schemaVersion: '1', requestId, operation, bytes: transferred,
          metadata: metadata as BankCsvMetadata, mapping: mapping as BankCsvMapping };
      worker.postMessage(request, [transferred]);
    } catch {
      finish(new ImportError('WORKER_FAILURE'));
    }
  });
}

async function run<T>(operation: 'detect' | 'extractBankCsv', source: ImportSource,
  options: WorkerOptions, metadata?: BankCsvMetadata, mapping?: BankCsvMapping): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new ImportError('INVALID_TIMEOUT');
  }
  if (options.signal?.aborted) throw new ImportError('CANCELLED');
  const controller = new AbortController();
  const onAbort = (): void => controller.abort('CANCELLED');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort('TIMED_OUT'), timeoutMs);
  try {
    const bytes = await bytesFrom(source, controller.signal);
    if (controller.signal.aborted) throw aborted(controller.signal);
    return await responseFor<T>(operation, bytes, controller.signal, metadata, mapping);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function extractBankFile(source: ImportSource, metadata: BankCsvMetadata,
  mapping: BankCsvMapping, options: WorkerOptions = {}): Promise<ExtractedBatch> {
  const result = await run<ExtractedBatch>('extractBankCsv', source, options, metadata, mapping);
  if (!result || !(result.sourceBytes instanceof Uint8Array) || !result.artifact ||
      !Array.isArray(result.proposals) || !Array.isArray(result.candidates)) {
    throw new ImportError('WORKER_PROTOCOL');
  }
  return result;
}

export async function detectFile(source: ImportSource, options: WorkerOptions = {}): Promise<SourceDetection> {
  const result = await run<SourceDetection>('detect', source, options);
  if (!result || !['SUPPORTED_CSV', 'MANUAL_REQUIRED', 'UNSUPPORTED_INPUT'].includes(result.outcome)) {
    throw new ImportError('WORKER_PROTOCOL');
  }
  return result;
}
