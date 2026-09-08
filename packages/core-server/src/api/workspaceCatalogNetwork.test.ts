// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import { DeviceIdentityService } from "../device/deviceIdentityService";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";
import { replicaRevision, WorkspaceSyncService, type ReplicaSnapshot } from "../sync/workspaceSyncService";
import { WorkspaceCatalogSyncService, type CatalogOperation } from "../sync/workspaceCatalogSyncService";
import { NetworkApiServer, type NetworkApiServerOptions } from "./networkApiServer";

const roots: string[] = [], servers: NetworkApiServer[] = [];
const headers = { authorization: "Bearer synthetic-catalog-host", "content-type": "application/json" };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "catalog-http-")); roots.push(root);
  const writes = new SessionWriteCoordinator(), state = join(root, "state");
  const sync = new WorkspaceSyncService(root, state, (n, s, op) => writes.run(n, s, op));
  const catalog = new WorkspaceCatalogSyncService(root, state, writes);
  const identities = new DeviceIdentityService({ filePath: join(state, "devices.json") }); await identities.start();
  const changes: unknown[] = [];
  async function start(extra: Partial<NetworkApiServerOptions> = {}) {
    const server = new NetworkApiServer({ host: "127.0.0.1", port: 0, token: "synthetic-catalog-host", workspaceSync: sync, workspaceCatalog: catalog, deviceIdentityService: identities, onWorkspaceChanged: e => changes.push(e), ...extra });
    servers.push(server);
    for (let i = 0; i < 8; i++) {
      const url = (await server.start()).url;
      try { await fetch(`${url}/api/v1/health`); return { url, server }; }
      catch (error) { if (!(error instanceof Error && error.cause instanceof Error && error.cause.message === "bad port")) throw error; await server.stop(); }
    }
    throw new Error("No fetch-safe port");
  }
  return { root, writes, sync, catalog, identities, changes, start };
}
async function post(url: string, operation: CatalogOperation) {
  return fetch(`${url}/api/v3/workspace/catalog-operation`, { method: "POST", headers, body: JSON.stringify(operation) });
}

describe("catalog protocol HTTP integration", () => {
  it("does not reuse an older in-flight Companion read after catalog publication", async () => {
    const f = await fixture();
    const make = (revision: string) => ({ version: 1 as const, notebookId: "book", sessionId: "s", title: revision, revision, updatedAt: "2026-09-08T00:00:00Z", blockCount: 0, markdown: revision, html: revision, assets: [] });
    let release!: (value: ReturnType<typeof make>) => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const slow = new Promise<ReturnType<typeof make>>(resolve => { release = resolve; });
    const getCompanionSession = vi.fn().mockImplementationOnce(() => { entered(); return slow; }).mockResolvedValue(make("new"));
    const { server, url } = await f.start({ getPairingTargets: async () => [{ notebookId: "book", sessionId: "s", title: "test" }], getCompanionSession });
    const route = `${url}/api/v2/companion/session/manifest?notebookId=book&sessionId=s`;
    const old = fetch(route, { headers }); await ready;
    const created = await post(url, { operationId: randomUUID(), action: "create_notebook", notebookId: "book", title: "book", baseRevision: null });
    expect(created.status).toBe(200);
    expect(await (await fetch(route, { headers })).json()).toMatchObject({ revision: "new" });
    release(make("old")); await old;
    expect(await (await fetch(route, { headers })).json()).toMatchObject({ revision: "new" });
    expect(getCompanionSession).toHaveBeenCalledTimes(2);
    await server.stop();
  });
  it("does not grant ordinary paired phones directory access and advertises only installed capability", async () => {
    const f = await fixture(); const { url } = await f.start();
    const challenge = await f.identities.createChallenge();
    const phone = await f.identities.exchangeChallenge({ ...challenge, deviceLabel: "synthetic phone" });
    for (const route of ["catalog-state", "catalog-operation"]) {
      for (const token of [undefined, "wrong", phone.token]) {
        const response = await fetch(`${url}/api/v3/workspace/${route}`, { method: route.endsWith("operation") ? "POST" : "GET", headers: token ? { authorization: `Bearer ${token}` } : {} });
        expect(response.status).toBe(401);
      }
    }
    expect(await (await fetch(`${url}/api/v3/workspace/identity`, { headers })).json()).toMatchObject({ capabilities: ["catalog-operations-v1"] });
    const old = await f.start({ workspaceCatalog: undefined });
    expect(await (await fetch(`${old.url}/api/v3/workspace/identity`, { headers })).json()).not.toHaveProperty("capabilities");
    for (const route of ["catalog-state", "catalog-operation"]) {
      const response = await fetch(`${old.url}/api/v3/workspace/${route}`, { method: route.endsWith("operation") ? "POST" : "GET", headers });
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "workspace_catalog_unavailable" });
    }
  });

  it("recovers before listening and does not start when recovery fails", async () => {
    const f = await fixture(); const recover = vi.spyOn(f.catalog, "recover").mockRejectedValue(new Error("injected recovery failure"));
    await expect(f.start()).rejects.toThrow("injected recovery failure"); expect(recover).toHaveBeenCalledOnce();
  });

  it("creates exact encoded image assets, publishes invalidation, rejects old deletion and returns the first retry result", async () => {
    const f = await fixture(); let { url, server } = await f.start();
    const notebookId = "论文阅读", sessionId = "讨论课";
    const createBook: CatalogOperation = { operationId: randomUUID(), action: "create_notebook", notebookId, title: "广义函数讨论班", baseRevision: null };
    const response = await post(url, createBook); expect(response.status).toBe(200);
    const book = await response.json();
    const operationId = randomUUID(), bytes = Buffer.from("synthetic image bytes");
    const assetPath = "assets/中文 (期末) #50% literal%23.png";
    const stage = await fetch(`${url}/api/v3/workspace/asset`, { method: "POST", headers, body: JSON.stringify({ operationId, sha256: digest(bytes), base64: bytes.toString("base64") }) });
    expect(stage.status).toBe(200);
    const session = createSessionRecord({ id: sessionId, title: "第一课", createdAt: "2026-09-08T00:00:00Z" });
    session.blocks.push(createBlockRef({ id: "0001", type: "markdown", path: "blocks/1.md", source: "user", createdAt: session.createdAt }));
    const snapshot: ReplicaSnapshot = { version: 1, notebookId, session, markdown: { "blocks/1.md": `![图](../${assetPath.split("/").map(encodeURIComponent).join("/")})\r\n` }, assets: [{ path: assetPath, sha256: digest(bytes), byteLength: bytes.length }], revision: "" };
    snapshot.revision = replicaRevision(snapshot);
    const createSession: CatalogOperation = { operationId, action: "create_session", notebookId, sessionId, baseRevision: null, snapshot };
    const created = await post(url, createSession); expect(created.status).toBe(200);
    const first = await created.json();
    const params = new URLSearchParams({ notebookId, sessionId, path: assetPath, sha256: digest(bytes) });
    const downloaded = await fetch(`${url}/api/v3/workspace/asset?${params}`, { headers });
    expect(downloaded.status).toBe(200); expect(Buffer.from(await downloaded.arrayBuffer()).equals(bytes)).toBe(true);
    const raw = await f.sync.snapshot(notebookId, sessionId);
    raw.markdown[raw.session.blocks[0].path] += "新的内容\r\n";
    const pushed = await fetch(`${url}/api/v3/workspace/push`, { method: "POST", headers, body: JSON.stringify({ operationId: randomUUID(), baseRevision: raw.revision, snapshot: raw }) });
    expect(pushed.status).toBe(200);
    const staleDelete = await post(url, { operationId: randomUUID(), action: "trash", notebookId, baseRevision: book.target.revision });
    expect(staleDelete.status).toBe(409);
    await server.stop(); ({ url, server } = await f.start());
    expect(await (await post(url, createSession)).json()).toEqual(first);
    expect((await f.sync.snapshot(notebookId, sessionId)).markdown).not.toEqual(first.target.snapshot.markdown);
    expect(f.changes).toContainEqual({ notebookId, sessionId, catalogChanged: true });
    const reused = await post(url, { ...createBook, title: "changed request" }); expect(reused.status).toBe(409);
  });
});
