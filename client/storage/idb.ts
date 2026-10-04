export class StorageError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'StorageError';
    this.code = code;
  }
}

export const STORAGE_VERSION = 2;

export type UpgradeProof = { expectedCases: Array<{ accountId: string; caseId: string;
  revisionId: string; digest: string }>; expectedAccounts: Array<{
    accountId: string; recoveryEnvelopeJson: string }>; backupDigest: string };

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

export async function openDatabase(dbName: string, proof?: UpgradeProof): Promise<IDBDatabase> {
  if (typeof dbName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(dbName)) {
    throw new StorageError('INVALID_STORAGE_NAME');
  }
  const api = indexedDbApi();
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = api.open(dbName, STORAGE_VERSION); }
    catch (error) { reject(storageFault(error)); return; }
    let settled = false;
    let upgradeFailure: StorageError | null = null;
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;
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
      const migrationStore = db.objectStoreNames.contains('migrations') ?
        request.transaction!.objectStore('migrations') :
        db.createObjectStore('migrations', { keyPath: 'id' });
      const outbox = request.transaction!.objectStore('outbox');
      if (!outbox.indexNames.contains('byCaseSequence')) {
        outbox.createIndex('byCaseSequence', ['accountId', 'caseId', 'localSequence']);
      }
      const marker = { id: 'schema', version: STORAGE_VERSION,
        migratedFrom: oldVersion, backupDigest: proof?.backupDigest ?? null };
      if (oldVersion !== 1) {
        migrationStore.put(marker);
        return;
      }
      const cases = request.transaction!.objectStore('cases');
      const accounts = request.transaction!.objectStore('accounts');
      let storedAccounts: Array<{ accountId: string; recoveryEnvelope: unknown }> = [];
      const accountCheck = accounts.getAll();
      const check = cases.getAll();
      accountCheck.onsuccess = () => {
        storedAccounts = accountCheck.result as Array<{ accountId: string; recoveryEnvelope: unknown }>;
      };
      check.onsuccess = () => {
        const stored = check.result as Array<{ accountId: string; caseId: string;
          revisionId: string; digest: string }>;
        if ((stored.length > 0 || storedAccounts.length > 0) && !proof) {
          upgradeFailure = new StorageError('MIGRATION_REQUIRED');
          request.transaction!.abort();
          return;
        }
        if (proof) {
          const identity = (item: { accountId: string; caseId: string;
            revisionId: string; digest: string }) =>
            `${item.accountId}\u0000${item.caseId}\u0000${item.revisionId}\u0000${item.digest}`;
          const actual = stored.map(identity).sort();
          const expected = proof.expectedCases.map(identity).sort();
          const actualAccounts = storedAccounts.map((item) =>
            `${item.accountId}\u0000${JSON.stringify(item.recoveryEnvelope)}`).sort();
          const expectedAccounts = proof.expectedAccounts.map((item) =>
            `${item.accountId}\u0000${item.recoveryEnvelopeJson}`).sort();
          if (JSON.stringify(actual) !== JSON.stringify(expected) ||
              JSON.stringify(actualAccounts) !== JSON.stringify(expectedAccounts)) {
            upgradeFailure = new StorageError('STALE_MIGRATION_BACKUP');
            request.transaction!.abort();
            return;
          }
        }
        migrationStore.put(marker);
      };
    };
    request.onerror = () => {
      if (!settled) { settled = true; reject(upgradeFailure ?? storageFault(request.error)); }
    };
    request.onblocked = () => {
      if (!settled) { settled = true; reject(new StorageError('STORAGE_BLOCKED')); }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      if (db.version !== STORAGE_VERSION ||
          ['accounts', 'cases', 'anchors', 'budgets', 'outbox', 'migrations']
            .some((name) => !db.objectStoreNames.contains(name))) {
        db.close(); reject(new StorageError('CORRUPT_RECORD')); return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

export async function openLegacyV1(dbName: string): Promise<IDBDatabase> {
  const api = indexedDbApi();
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = api.open(dbName, 1); }
    catch (error) { reject(storageFault(error)); return; }
    request.onerror = () => reject(storageFault(request.error));
    request.onsuccess = () => {
      const db = request.result;
      if (db.version !== 1 || !db.objectStoreNames.contains('accounts') ||
          !db.objectStoreNames.contains('cases') || !db.objectStoreNames.contains('anchors')) {
        db.close(); reject(new StorageError('UNSUPPORTED_STORAGE_VERSION')); return;
      }
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
