import { CompanionApiError, CompanionApiClient, NotModifiedError } from "./apiClient";
import type { CompanionStorage } from "./appStorage";
import type {
  CachedAsset,
  CachedCatalog,
  CachedSession,
  DeviceCredential,
  PairingTarget,
  SessionAsset,
  SessionManifest
} from "./domain";
import { assetCacheKey, sessionCacheKey } from "./domain";

export type SessionSyncStage = "manifest" | "body" | "assets" | "complete";

export type SessionSyncResult = Readonly<{
  session: CachedSession;
  assetFailures: number;
  fromCache: boolean;
}>;

type SessionApi = Pick<
  CompanionApiClient,
  "verify" | "fetchManifest" | "fetchDocument" | "fetchAsset"
>;

export async function syncCatalog(
  api: SessionApi,
  storage: CompanionStorage,
  credential: DeviceCredential
): Promise<CachedCatalog> {
  const catalog = await api.verify(credential.token);
  const cached: CachedCatalog = {
    profileId: credential.deviceId,
    version: 1,
    activeTarget: catalog.activeTarget,
    targets: catalog.targets,
    capabilities: catalog.capabilities,
    syncedAt: new Date().toISOString()
  };
  await storage.saveCatalog(cached);
  return cached;
}

export async function syncSession(args: {
  api: SessionApi;
  storage: CompanionStorage;
  credential: DeviceCredential;
  target: PairingTarget;
  onStage?: (stage: SessionSyncStage, session?: CachedSession) => void;
}): Promise<SessionSyncResult> {
  const key = sessionCacheKey(args.credential.deviceId, args.target.notebookId, args.target.sessionId);
  const cached = await args.storage.loadSession(key);
  const snapshot = await readConsistentSnapshot(args, cached);
  if ("cached" in snapshot) {
    args.onStage?.("complete", snapshot.cached);
    return { session: snapshot.cached, assetFailures: 0, fromCache: true };
  }
  const { manifest, markdown, html } = snapshot;

  const session: CachedSession = {
    key,
    profileId: args.credential.deviceId,
    version: 1,
    notebookId: manifest.notebookId,
    sessionId: manifest.sessionId,
    title: manifest.title,
    revision: manifest.revision,
    updatedAt: manifest.updatedAt,
    blockCount: manifest.blockCount,
    markdown: markdown.text,
    html: html.text,
    assets: manifest.assets,
    syncedAt: new Date().toISOString()
  };
  await args.storage.saveSession(session);
  args.onStage?.("body", session);

  args.onStage?.("assets", session);
  const results = await mapConcurrent(manifest.assets, 3, async (asset) => {
    const blob = await args.api.fetchAsset(args.credential.token, args.target, asset.path);
    const cachedAsset: CachedAsset = {
      key: assetCacheKey(
        args.credential.deviceId,
        manifest.notebookId,
        manifest.sessionId,
        asset.id
      ),
      profileId: args.credential.deviceId,
      notebookId: manifest.notebookId,
      sessionId: manifest.sessionId,
      assetId: asset.id,
      mimeType: blob.type || asset.mimeType,
      bytes: blob,
      syncedAt: new Date().toISOString()
    };
    await args.storage.saveAsset(cachedAsset);
  });
  const assetFailures = results.filter((result) => result.status === "rejected").length;
  const authenticationFailure = results.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" &&
      result.reason instanceof CompanionApiError &&
      result.reason.status === 401
  );
  if (authenticationFailure) throw authenticationFailure.reason;
  args.onStage?.("complete", session);
  return { session, assetFailures, fromCache: false };
}

const MAX_SNAPSHOT_ATTEMPTS = 3;

async function readConsistentSnapshot(
  args: {
    api: SessionApi;
    credential: DeviceCredential;
    target: PairingTarget;
    onStage?: (stage: SessionSyncStage, session?: CachedSession) => void;
  },
  cached: CachedSession | undefined
): Promise<
  | { cached: CachedSession }
  | {
      manifest: SessionManifest;
      markdown: { text: string; revision: string };
      html: { text: string; revision: string };
    }
> {
  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    args.onStage?.("manifest");
    let manifest: SessionManifest;
    try {
      manifest = await args.api.fetchManifest(
        args.credential.token,
        args.target,
        cached?.revision
      );
    } catch (error) {
      if (error instanceof NotModifiedError && cached) return { cached };
      throw error;
    }

    try {
      const [markdown, html] = await Promise.all([
        args.api.fetchDocument(args.credential.token, args.target, "markdown"),
        args.api.fetchDocument(args.credential.token, args.target, "html")
      ]);
      assertDocument(manifest, markdown, "markdown");
      assertDocument(manifest, html, "html");
      return { manifest, markdown, html };
    } catch (error) {
      if (attempt < MAX_SNAPSHOT_ATTEMPTS && isTransientSnapshotError(error)) continue;
      throw error;
    }
  }
  throw new CompanionApiError("笔记持续发生变化，请稍后重试。", 409, "revision_changed");
}

function isTransientSnapshotError(error: unknown): boolean {
  return error instanceof CompanionApiError &&
    (error.code === "revision_changed" || error.code === "document_truncated");
}

function assertDocument(
  manifest: SessionManifest,
  document: { text: string; revision: string },
  format: "markdown" | "html"
): void {
  if (document.revision !== manifest.revision) {
    throw new CompanionApiError("同步期间笔记发生变化，正在重新读取。", 409, "revision_changed");
  }
  const actualBytes = new TextEncoder().encode(document.text).byteLength;
  const expectedBytes = format === "markdown" ? manifest.markdownBytes : manifest.htmlBytes;
  if (actualBytes !== expectedBytes) {
    throw new CompanionApiError(
      format === "markdown" ? "Markdown 正文接收不完整。" : "阅读预览接收不完整。",
      502,
      "document_truncated"
    );
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      try {
        await task(values[index]!);
        results[index] = { status: "fulfilled", value: undefined };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

export function missingAssetIds(session: CachedSession, assets: readonly CachedAsset[]): string[] {
  const available = new Set(assets.map((asset) => asset.assetId));
  return session.assets.filter((asset: SessionAsset) => !available.has(asset.id)).map((asset) => asset.id);
}
