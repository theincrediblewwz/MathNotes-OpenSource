import type { PwaCapabilityReport } from "./capabilities";
import type {
  CachedAsset,
  CachedCatalog,
  CachedSession,
  DeviceCredential,
  UploadTask
} from "./domain";

const DATABASE_NAME = "mathnotes-pwa";
const DATABASE_VERSION = 3;
const META_STORE = "meta";
const CREDENTIAL_STORE = "credentials";
const CATALOG_STORE = "catalogs";
const SESSION_STORE = "sessions";
const ASSET_STORE = "assets";
const UPLOAD_STORE = "uploads";

export type CompanionStorage = Readonly<{
  loadLastProfileId(): Promise<string | undefined>;
  loadCredential(): Promise<DeviceCredential | undefined>;
  saveCredential(credential: DeviceCredential): Promise<void>;
  clearCredential(): Promise<void>;
  loadCatalog(profileId: string): Promise<CachedCatalog | undefined>;
  saveCatalog(catalog: CachedCatalog): Promise<void>;
  loadSession(key: string): Promise<CachedSession | undefined>;
  saveSession(session: CachedSession): Promise<void>;
  deleteSession(key: string): Promise<void>;
  loadSessionAssets(profileId: string, notebookId: string, sessionId: string): Promise<CachedAsset[]>;
  saveAsset(asset: CachedAsset): Promise<void>;
  loadEventCursor(key: string): Promise<string | undefined>;
  saveEventCursor(key: string, cursor: string): Promise<void>;
  loadUploadTask(id: string): Promise<UploadTask | undefined>;
  loadUploadTasks(profileId: string): Promise<UploadTask[]>;
  saveUploadTask(task: UploadTask): Promise<void>;
  deleteUploadTask(id: string): Promise<void>;
}>;

export const companionStorage: CompanionStorage = {
  loadLastProfileId: () => getRecord<string>(META_STORE, "profile:last"),
  loadCredential: () => getRecord<DeviceCredential>(CREDENTIAL_STORE, "active"),
  saveCredential: async (credential) => {
    await putRecord(CREDENTIAL_STORE, credential);
    await putRecord(META_STORE, credential.deviceId, "profile:last");
  },
  clearCredential: () => deleteRecord(CREDENTIAL_STORE, "active"),
  loadCatalog: (profileId) => getRecord<CachedCatalog>(CATALOG_STORE, profileId),
  saveCatalog: (catalog) => putRecord(CATALOG_STORE, catalog),
  loadSession: (key) => getRecord<CachedSession>(SESSION_STORE, key),
  saveSession: (session) => putRecord(SESSION_STORE, session),
  deleteSession: (key) => deleteRecord(SESSION_STORE, key),
  loadSessionAssets: (profileId, notebookId, sessionId) => getAllByIndex<CachedAsset>(
    ASSET_STORE,
    "by-session",
    IDBKeyRange.only([profileId, notebookId, sessionId])
  ),
  saveAsset: (asset) => putRecord(ASSET_STORE, asset),
  loadEventCursor: (key) => getRecord<string>(META_STORE, `event-cursor:${key}`),
  saveEventCursor: (key, cursor) => putRecord(META_STORE, cursor, `event-cursor:${key}`),
  loadUploadTask: (id) => getRecord<UploadTask>(UPLOAD_STORE, id),
  loadUploadTasks: (profileId) => getAllByIndex<UploadTask>(UPLOAD_STORE, "by-profile", profileId),
  saveUploadTask: (task) => putRecord(UPLOAD_STORE, task),
  deleteUploadTask: (id) => deleteRecord(UPLOAD_STORE, id)
};

export async function saveCapabilityReport(report: PwaCapabilityReport): Promise<void> {
  await putRecord(META_STORE, report, "capability:last");
}

async function getRecord<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return withStore<T | undefined>(storeName, "readonly", (store) => requestResult<T | undefined>(store.get(key)));
}

async function putRecord(storeName: string, value: unknown, key?: IDBValidKey): Promise<void> {
  await withStore<void>(storeName, "readwrite", (store) => {
    if (key === undefined) store.put(value);
    else store.put(value, key);
  });
}

async function deleteRecord(storeName: string, key: IDBValidKey): Promise<void> {
  await withStore<void>(storeName, "readwrite", (store) => {
    store.delete(key);
  });
}

async function getAllByIndex<T>(
  storeName: string,
  indexName: string,
  query: IDBValidKey | IDBKeyRange
): Promise<T[]> {
  return withStore<T[]>(storeName, "readonly", (store) => requestResult<T[]>(store.index(indexName).getAll(query)));
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => Promise<T> | T
): Promise<T> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, mode);
    const result = await operation(transaction.objectStore(storeName));
    await transactionDone(transaction);
    return result;
  } finally {
    database.close();
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("MathNotes 本地读取失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("MathNotes 本地写入失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("MathNotes 本地写入已中止"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
      if (!database.objectStoreNames.contains(CREDENTIAL_STORE)) {
        database.createObjectStore(CREDENTIAL_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(CATALOG_STORE)) {
        database.createObjectStore(CATALOG_STORE, { keyPath: "profileId" });
      }
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        const store = database.createObjectStore(SESSION_STORE, { keyPath: "key" });
        store.createIndex("by-profile", "profileId");
      }
      if (!database.objectStoreNames.contains(ASSET_STORE)) {
        const store = database.createObjectStore(ASSET_STORE, { keyPath: "key" });
        store.createIndex("by-session", ["profileId", "notebookId", "sessionId"]);
      }
      if (!database.objectStoreNames.contains(UPLOAD_STORE)) {
        const store = database.createObjectStore(UPLOAD_STORE, { keyPath: "id" });
        store.createIndex("by-profile", "profileId");
        store.createIndex("by-profile-status", ["profileId", "status"]);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开 MathNotes 本地存储"));
    request.onblocked = () => reject(new Error("请关闭其他 MathNotes 页面后重试"));
  });
}
