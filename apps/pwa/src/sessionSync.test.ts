import { describe, expect, it, vi } from "vitest";
import type { CompanionStorage } from "./appStorage";
import { CompanionApiError, NotModifiedError } from "./apiClient";
import type { CachedAsset, CachedCatalog, CachedSession, DeviceCredential } from "./domain";
import { syncSession } from "./sessionSync";

const credential: DeviceCredential = {
  id: "active",
  version: 1,
  origin: "https://notes.example.test",
  token: "token",
  deviceId: "phone",
  deviceLabel: "iPhone",
  verifiedAt: "2026-07-25T00:00:00.000Z"
};
const target = { notebookId: "analysis", sessionId: "lecture", title: "第 1 讲" };

describe("syncSession", () => {
  it("publishes validated text before bounded asset completion", async () => {
    const markdown = "# 第 1 讲";
    const html = "<html><head></head><body><img src=\"mathnotes-companion-asset://a\"></body></html>";
    const storage = memoryStorage();
    const stages: string[] = [];
    const api = {
      verify: vi.fn(),
      fetchManifest: vi.fn().mockResolvedValue({
        version: 2,
        notebookId: "analysis",
        sessionId: "lecture",
        title: "第 1 讲",
        revision: "r2",
        updatedAt: "2026-07-25T00:00:00.000Z",
        blockCount: 1,
        markdownBytes: new TextEncoder().encode(markdown).byteLength,
        htmlBytes: new TextEncoder().encode(html).byteLength,
        assets: [{ id: "a", path: "assets/a.png", mimeType: "image/png" }]
      }),
      fetchDocument: vi.fn((_token, _target, format) => Promise.resolve({
        text: format === "markdown" ? markdown : html,
        revision: "r2"
      })),
      fetchAsset: vi.fn().mockRejectedValue(new Error("offline"))
    };
    const result = await syncSession({
      api,
      storage,
      credential,
      target,
      onStage: (stage) => stages.push(stage)
    });
    expect(result.session.markdown).toBe(markdown);
    expect(result.assetFailures).toBe(1);
    expect(stages).toEqual(["manifest", "body", "assets", "complete"]);
    expect(await storage.loadSession(result.session.key)).toMatchObject({ revision: "r2" });
  });

  it("reuses a cached revision and rejects truncated bodies", async () => {
    const storage = memoryStorage();
    const cached = cachedSession();
    await storage.saveSession(cached);
    const unchanged = {
      verify: vi.fn(),
      fetchManifest: vi.fn().mockRejectedValue(new NotModifiedError()),
      fetchDocument: vi.fn(),
      fetchAsset: vi.fn()
    };
    await expect(syncSession({ api: unchanged, storage, credential, target }))
      .resolves.toMatchObject({ fromCache: true, session: { revision: "r1" } });

    const truncated = {
      verify: vi.fn(),
      fetchManifest: vi.fn().mockResolvedValue({
        version: 2,
        notebookId: "analysis",
        sessionId: "lecture",
        title: "第 1 讲",
        revision: "r2",
        updatedAt: "now",
        blockCount: 1,
        markdownBytes: 100,
        htmlBytes: 1,
        assets: []
      }),
      fetchDocument: vi.fn((_token, _target, format) => Promise.resolve({
        text: format === "markdown" ? "x" : "y",
        revision: "r2"
      })),
      fetchAsset: vi.fn()
    };
    await expect(syncSession({ api: truncated, storage, credential, target }))
      .rejects.toMatchObject({ code: "document_truncated" } satisfies Partial<CompanionApiError>);
    expect(truncated.fetchManifest).toHaveBeenCalledTimes(3);
  });

  it("retries a snapshot that changes between manifest and document reads", async () => {
    const storage = memoryStorage();
    const firstMarkdown = "# 正在保存";
    const finalMarkdown = "# 已保存";
    const html = "<h1>已保存</h1>";
    const api = {
      verify: vi.fn(),
      fetchManifest: vi.fn()
        .mockResolvedValueOnce({
          version: 2,
          notebookId: "analysis",
          sessionId: "lecture",
          title: "第 1 讲",
          revision: "r2",
          updatedAt: "now",
          blockCount: 1,
          markdownBytes: new TextEncoder().encode(firstMarkdown).byteLength,
          htmlBytes: new TextEncoder().encode(html).byteLength,
          assets: []
        })
        .mockResolvedValueOnce({
          version: 2,
          notebookId: "analysis",
          sessionId: "lecture",
          title: "第 1 讲",
          revision: "r3",
          updatedAt: "later",
          blockCount: 1,
          markdownBytes: new TextEncoder().encode(finalMarkdown).byteLength,
          htmlBytes: new TextEncoder().encode(html).byteLength,
          assets: []
        }),
      fetchDocument: vi.fn()
        .mockResolvedValueOnce({ text: firstMarkdown, revision: "r3" })
        .mockResolvedValueOnce({ text: html, revision: "r3" })
        .mockResolvedValueOnce({ text: finalMarkdown, revision: "r3" })
        .mockResolvedValueOnce({ text: html, revision: "r3" }),
      fetchAsset: vi.fn()
    };

    await expect(syncSession({ api, storage, credential, target })).resolves.toMatchObject({
      fromCache: false,
      session: { revision: "r3", markdown: finalMarkdown }
    });
    expect(api.fetchManifest).toHaveBeenCalledTimes(2);
    expect(api.fetchDocument).toHaveBeenCalledTimes(4);
  });
});

function memoryStorage(): CompanionStorage {
  let currentCredential: DeviceCredential | undefined;
  const catalogs = new Map<string, CachedCatalog>();
  const sessions = new Map<string, CachedSession>();
  const assets = new Map<string, CachedAsset>();
  return {
    loadLastProfileId: async () => currentCredential?.deviceId,
    loadCredential: async () => currentCredential,
    saveCredential: async (value) => { currentCredential = value; },
    clearCredential: async () => { currentCredential = undefined; },
    loadCatalog: async (key) => catalogs.get(key),
    saveCatalog: async (value) => { catalogs.set(value.profileId, value); },
    loadSession: async (key) => sessions.get(key),
    saveSession: async (value) => { sessions.set(value.key, value); },
    deleteSession: async (key) => { sessions.delete(key); },
    loadSessionAssets: async (profileId, notebookId, sessionId) =>
      [...assets.values()].filter((asset) =>
        asset.profileId === profileId &&
        asset.notebookId === notebookId &&
        asset.sessionId === sessionId),
    saveAsset: async (value) => { assets.set(value.key, value); },
    loadEventCursor: async () => undefined,
    saveEventCursor: async () => undefined,
    loadUploadTask: async () => undefined,
    loadUploadTasks: async () => [],
    saveUploadTask: async () => undefined,
    deleteUploadTask: async () => undefined
  };
}

function cachedSession(): CachedSession {
  return {
    key: "phone\u0000analysis\u0000lecture",
    profileId: "phone",
    version: 1,
    notebookId: "analysis",
    sessionId: "lecture",
    title: "第 1 讲",
    revision: "r1",
    updatedAt: "now",
    blockCount: 1,
    markdown: "old",
    html: "<p>old</p>",
    assets: [],
    syncedAt: "now"
  };
}
