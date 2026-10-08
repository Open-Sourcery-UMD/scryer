import { extractBankCsv } from './bank.ts';
import { detectSource } from './detect.ts';
import { ImportError } from './errors.ts';
import type { BankCsvMapping, BankCsvMetadata, ImportWorkerResponse } from './types.ts';
import { exactKeys } from './validation.ts';

type WorkerScope = {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (event) => {
  void handle(event.data);
};

async function handle(data: unknown): Promise<void> {
  if (typeof data !== 'object' || data === null || !('requestId' in data) ||
      typeof data.requestId !== 'number' || !Number.isSafeInteger(data.requestId) ||
      data.requestId < 1 || !('schemaVersion' in data) ||
      data.schemaVersion !== '1' || !('operation' in data) ||
      !('bytes' in data) || !(data.bytes instanceof ArrayBuffer)) {
    return;
  }
  const requestId = data.requestId;
  try {
    if (data.operation === 'detect') {
      if (!exactKeys(data, ['schemaVersion', 'requestId', 'operation', 'bytes'])) {
        throw new ImportError('INVALID_WORKER_REQUEST');
      }
      const result = detectSource(new Uint8Array(data.bytes));
      const response: ImportWorkerResponse = { schemaVersion: '1', requestId,
        operation: 'detect', status: 'ok', result };
      scope.postMessage(response);
    } else if (data.operation === 'extractBankCsv') {
      if (!exactKeys(data, ['schemaVersion', 'requestId', 'operation', 'bytes', 'metadata', 'mapping']) ||
          !('metadata' in data) || !('mapping' in data)) {
        throw new ImportError('INVALID_WORKER_REQUEST');
      }
      const result = await extractBankCsv(new Uint8Array(data.bytes),
        data.metadata as BankCsvMetadata, data.mapping as BankCsvMapping);
      const transfer = result.sourceBytes.buffer instanceof ArrayBuffer ? [result.sourceBytes.buffer] : [];
      const response: ImportWorkerResponse = { schemaVersion: '1', requestId,
        operation: 'extractBankCsv', status: 'ok', result };
      scope.postMessage(response, transfer);
    } else {
      throw new ImportError('INVALID_WORKER_REQUEST');
    }
  } catch (error) {
    const code = error instanceof ImportError ? error.code : 'WORKER_FAILURE';
    const response: ImportWorkerResponse = { schemaVersion: '1', requestId, status: 'error', errorCode: code };
    scope.postMessage(response);
  }
}
