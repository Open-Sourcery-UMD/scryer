export class StorageError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'StorageError';
    this.code = code;
  }
}

export const STORAGE_VERSION = 1;

export function storageFault(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const name = error instanceof DOMException ? error.name :
    (typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '');
  if (name === 'QuotaExceededError') return new StorageError('STORAGE_QUOTA');
  if (name === 'SecurityError' || name === 'NotAllowedError') return new StorageError('STORAGE_DENIED');
  if (name === 'VersionError') return new StorageError('UNSUPPORTED_STORAGE_VERSION');
  if (name === 'InvalidStateError') return new StorageError('STORAGE_CLOSED');
  return new StorageError('STORAGE_ABORTED');
}

export function indexedDbApi(): IDBFactory {
  if (typeof globalThis.indexedDB === 'undefined' || !globalThis.indexedDB) {
    throw new StorageError('STORAGE_UNAVAILABLE');
  }
  return globalThis.indexedDB;
}

export async function openDatabase(dbName: string): Promise<IDBDatabase> {
  if (typeof dbName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(dbName)) {
    throw new StorageError('INVALID_STORAGE_NAME');
  }
  const api = indexedDbApi();
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = api.open(dbName, STORAGE_VERSION); }
    catch (error) { reject(storageFault(error)); return; }
    let settled = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('accounts')) db.createObjectStore('accounts', { keyPath: 'accountId' });
      if (!db.objectStoreNames.contains('cases')) db.createObjectStore('cases', { keyPath: ['accountId', 'caseId'] });
      if (!db.objectStoreNames.contains('anchors')) db.createObjectStore('anchors', { keyPath: ['accountId', 'caseId'] });
      if (!db.objectStoreNames.contains('budgets')) db.createObjectStore('budgets', {
        keyPath: ['accountId', 'caseId', 'keyGeneration', 'deviceId'],
      });
      if (!db.objectStoreNames.contains('outbox')) {
        const store = db.createObjectStore('outbox', { keyPath: ['accountId', 'operationId'] });
        store.createIndex('byCase', ['accountId', 'caseId']);
      }
    };
    request.onerror = () => {
      if (!settled) { settled = true; reject(storageFault(request.error)); }
    };
    request.onblocked = () => {
      if (!settled) { settled = true; reject(new StorageError('STORAGE_BLOCKED')); }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

export function transactionResult<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  begin: (tx: IDBTransaction, finish: (value: T) => void, fail: (error: StorageError) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(stores, mode); }
    catch (error) { reject(storageFault(error)); return; }
    let result: T | undefined;
    let finished = false;
    let failure: StorageError | null = null;
    const finish = (value: T): void => { result = value; finished = true; };
    const fail = (error: StorageError): void => {
      failure = error;
      try { tx.abort(); } catch { /* A completed/aborted transaction will settle via its events. */ }
    };
    tx.oncomplete = () => {
      if (finished) resolve(result as T);
      else reject(new StorageError('STORAGE_ABORTED'));
    };
    tx.onabort = () => reject(failure ?? storageFault(tx.error));
    tx.onerror = () => { /* The abort event supplies the final typed failure. */ };
    try { begin(tx, finish, fail); }
    catch (error) { fail(storageFault(error)); }
  });
}
