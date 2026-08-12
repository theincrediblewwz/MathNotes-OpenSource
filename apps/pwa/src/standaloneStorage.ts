export type StandaloneSession = Readonly<{
  id: string;
  title: string;
  markdown: string;
  createdAt: string;
  updatedAt: string;
}>;

export type StandaloneAsset = Readonly<{
  id: string;
  sessionId: string;
  name: string;
  mimeType: string;
  bytes: Blob;
  createdAt: string;
}>;

export type StandaloneExport = Readonly<{
  format: "mathnotes-standalone-export";
  version: 1;
  exportedAt: string;
  sessions: readonly StandaloneSession[];
  assets: readonly StandaloneExportAsset[];
}>;

export type StandaloneExportAsset = Readonly<{
  id: string;
  sessionId: string;
  name: string;
  mimeType: string;
  createdAt: string;
  dataUrl: string;
}>;

const DATABASE_NAME = "mathnotes-standalone-v1";
const DATABASE_VERSION = 1;
const SESSION_STORE = "sessions";
const ASSET_STORE = "assets";

export async function listStandaloneSessions(): Promise<StandaloneSession[]> {
  return withStore(SESSION_STORE, "readonly", (store) => requestResult(store.getAll()));
}

export async function createStandaloneSession(title = "iPhone 独立笔记"): Promise<StandaloneSession> {
  const now = new Date().toISOString();
  const session: StandaloneSession = {
    id: crypto.randomUUID(),
    title: title.trim() || "iPhone 独立笔记",
    markdown: "# 独立笔记\n\n",
    createdAt: now,
    updatedAt: now
  };
  await withStore(SESSION_STORE, "readwrite", (store) => { store.add(session); });
  return session;
}

export async function saveStandaloneMarkdown(session: StandaloneSession, markdown: string): Promise<StandaloneSession> {
  const next = { ...session, markdown, updatedAt: new Date().toISOString() };
  await withStore(SESSION_STORE, "readwrite", (store) => { store.put(next); });
  return next;
}

export async function addStandaloneAsset(sessionId: string, file: File): Promise<StandaloneAsset> {
  const asset: StandaloneAsset = {
    id: crypto.randomUUID(), sessionId, name: file.name, mimeType: file.type,
    bytes: file, createdAt: new Date().toISOString()
  };
  await withStore(ASSET_STORE, "readwrite", (store) => { store.add(asset); });
  return asset;
}

export async function listStandaloneAssets(sessionId: string): Promise<StandaloneAsset[]> {
  return withStore(ASSET_STORE, "readonly", (store) =>
    requestResult(store.index("by-session").getAll(sessionId))
  );
}

export async function listAllStandaloneAssets(): Promise<StandaloneAsset[]> {
  return withStore(ASSET_STORE, "readonly", (store) => requestResult(store.getAll()));
}

export function serializeStandaloneExport(sessions: readonly StandaloneSession[]): string {
  const payload: StandaloneExport = {
    format: "mathnotes-standalone-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions,
    assets: []
  };
  return JSON.stringify(payload, null, 2);
}

export async function createStandaloneExport(
  sessions: readonly StandaloneSession[],
  assets: readonly StandaloneAsset[]
): Promise<string> {
  const exportedAssets = await Promise.all(assets.map(async ({ bytes, ...asset }) => ({
    ...asset,
    dataUrl: await blobToDataUrl(bytes)
  })));
  return JSON.stringify({
    format: "mathnotes-standalone-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions,
    assets: exportedAssets
  } satisfies StandaloneExport, null, 2);
}

export function parseStandaloneExport(text: string): StandaloneExport {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object") throw new Error("备份包格式无效");
  const candidate = value as Partial<StandaloneExport>;
  if (candidate.format !== "mathnotes-standalone-export" || candidate.version !== 1 || !Array.isArray(candidate.sessions)) {
    throw new Error("这不是受支持的 MathNotes 独立工作区备份");
  }
  for (const session of candidate.sessions) {
    if (!session || typeof session.id !== "string" || typeof session.title !== "string" || typeof session.markdown !== "string") {
      throw new Error("备份中的 Session 数据不完整");
    }
  }
  const assets = candidate.assets ?? [];
  if (!Array.isArray(assets) || assets.some((asset) => !asset || typeof asset.id !== "string" || typeof asset.sessionId !== "string" || typeof asset.dataUrl !== "string")) {
    throw new Error("备份中的图片数据不完整");
  }
  return { ...(candidate as StandaloneExport), assets };
}

export async function restoreStandaloneExport(payload: StandaloneExport): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([SESSION_STORE, ASSET_STORE], "readwrite");
    const sessions = transaction.objectStore(SESSION_STORE);
    const assets = transaction.objectStore(ASSET_STORE);
    payload.sessions.forEach((session) => sessions.put(session));
    payload.assets.forEach(({ dataUrl, ...asset }) => assets.put({ ...asset, bytes: dataUrlToBlob(dataUrl) }));
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("图片备份编码失败"));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(value: string): Blob {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(value);
  if (!match) throw new Error("备份中的图片编码无效");
  const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: match[1] || "application/octet-stream" });
}

async function withStore<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => T | Promise<T>): Promise<T> {
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) database.createObjectStore(SESSION_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(ASSET_STORE)) {
        const assets = database.createObjectStore(ASSET_STORE, { keyPath: "id" });
        assets.createIndex("by-session", "sessionId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开手机独立工作区"));
    request.onblocked = () => reject(new Error("请关闭其他 MathNotes 页面后重试"));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地读取失败"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本地写入失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地写入已中止"));
  });
}
