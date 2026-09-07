// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import { DeviceIdentityService } from "../device/deviceIdentityService";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";
import { WorkspaceSyncService, type ReplicaSnapshot, type ReplicaPush } from "../sync/workspaceSyncService";
import { NetworkApiServer } from "./networkApiServer";

const routes = [
  ["GET", "identity"], ["GET", "catalog"], ["GET", "snapshot"],
  ["GET", "asset"], ["POST", "asset"], ["POST", "push"]
] as const;
const headers = { Authorization: "Bearer synthetic-host-token", "Content-Type": "application/json" };
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("trusted-host workspace synchronization over HTTP", () => {
  const servers: NetworkApiServer[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.stop()));
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  async function directory() {
    const root = await mkdtemp(join(tmpdir(), "mathnotes-workspace-http-"));
    roots.push(root);
    return root;
  }
  async function start(options: Partial<ConstructorParameters<typeof NetworkApiServer>[0]> = {}) {
    const server = new NetworkApiServer({ host: "127.0.0.1", port: 0, token: "synthetic-host-token", ...options });
    servers.push(server);
    for (let attempt = 0; attempt < 8; attempt++) {
      const url = (await server.start()).url;
      try { if ((await fetch(`${url}/api/v1/health`)).ok) return { server, url }; }
      catch (error) { if (!(error instanceof Error && error.cause instanceof Error && error.cause.message === "bad port")) throw error; }
      await server.stop();
    }
    throw new Error("No fetch-safe port");
  }
  async function fixture() {
    const root = await directory();
    const state = join(root, "state");
    const sessionDir = join(root, "notebooks", "论文阅读", "sessions", "讨论一");
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await mkdir(join(sessionDir, "assets"));
    const session = createSessionRecord({ id: "讨论一", title: "合成笔记", createdAt: "2026-09-08T00:00:00.000Z" });
    session.blocks.push(createBlockRef({ id: "0001", type: "markdown", path: "blocks/original.md", source: "user", createdAt: session.createdAt }));
    await writeFile(join(sessionDir, "blocks/original.md"), "# A\r\n\r\n原始中文 😀\r\n");
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(session));
    const coordinator = new SessionWriteCoordinator();
    const sync = new WorkspaceSyncService(root, state, (n, s, task) => coordinator.run(n, s, task));
    return { root, state, sessionDir, sync, coordinator };
  }

  it("rejects missing, wrong and valid ordinary phone credentials on all six routes", async () => {
    const root = await directory();
    const identities = new DeviceIdentityService({ filePath: join(root, "devices.json") });
    await identities.start();
    const challenge = await identities.createChallenge();
    const phone = await identities.exchangeChallenge({ challengeId: challenge.challengeId, userCode: challenge.userCode, deviceLabel: "synthetic phone" });
    const { url } = await start({ deviceIdentityService: identities });
    for (const [method, route] of routes) {
      for (const credential of [undefined, "wrong-token", phone.token]) {
        const result = await fetch(`${url}/api/v3/workspace/${route}`, { method, headers: credential ? { Authorization: `Bearer ${credential}` } : undefined });
        expect(result.status).toBe(401);
      }
      const unavailable = await fetch(`${url}/api/v3/workspace/${route}`, { method, headers });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ error: "workspace_sync_unavailable" });
    }
  });

  it("round-trips exact snapshots and staged assets, then handles lost-response retries after restart", async () => {
    const f = await fixture();
    const changes: {notebookId: string; sessionId: string}[] = [];
    const { server, url } = await start({ workspaceSync: f.sync, onWorkspaceChanged: target => changes.push(target) });
    const get = async (route: string) => fetch(`${url}/api/v3/workspace/${route}`, { headers });
    const identity = await (await get("identity")).json();
    expect(identity.hostId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await get("catalog")).status).toBe(200);
    const query = new URLSearchParams({ notebookId: "论文阅读", sessionId: "讨论一" });
    const original: ReplicaSnapshot = await (await get(`snapshot?${query}`)).json();
    expect(original.markdown["blocks/original.md"]).toBe("# A\r\n\r\n原始中文 😀\r\n");
    expect(original.revision).toBe(digest(JSON.stringify([original.session, Object.entries(original.markdown).sort(([a],[b])=>a.localeCompare(b)), original.assets])));
    const body: ReplicaPush = { operationId: randomUUID(), baseRevision: original.revision, snapshot: structuredClone(original) };
    const asset = Buffer.from("synthetic processed image bytes");
    body.snapshot.markdown["blocks/original.md"] = "# B\r\n\r\n![中文图](../assets/图%20一.png)\r\n";
    body.snapshot.assets.push({ path: "assets/图 一.png", sha256: digest(asset), byteLength: asset.length });
    const stage = await fetch(`${url}/api/v3/workspace/asset`, { method: "POST", headers, body: JSON.stringify({ operationId: body.operationId, sha256: digest(asset), base64: asset.toString("base64") }) });
    expect(stage.status).toBe(200);
    const push = await fetch(`${url}/api/v3/workspace/push`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(push.status).toBe(200);
    const accepted: ReplicaSnapshot = await push.json();
    expect(changes).toEqual([{ notebookId: "论文阅读", sessionId: "讨论一" }]);
    expect(accepted.markdown[accepted.session.blocks[0].path]).toBe(body.snapshot.markdown["blocks/original.md"]);
    expect(await readFile(join(f.sessionDir, "blocks/original.md"), "utf8")).toBe(original.markdown["blocks/original.md"]);
    const assetQuery = new URLSearchParams({ notebookId: "论文阅读", sessionId: "讨论一", path: "assets/图 一.png", sha256: digest(asset) });
    const download = await get(`asset?${assetQuery}`);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(asset);
    assetQuery.set("sha256", "0".repeat(64));
    expect((await get(`asset?${assetQuery}`)).status).toBe(409);
    const stale = await fetch(`${url}/api/v3/workspace/push`, { method: "POST", headers, body: JSON.stringify({ ...body, operationId: randomUUID() }) });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "revision_conflict" });
    const reused = await fetch(`${url}/api/v3/workspace/push`, { method: "POST", headers, body: JSON.stringify({ ...body, baseRevision: accepted.revision }) });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({ error: "operation_reused" });
    await server.stop();
    const sync = new WorkspaceSyncService(f.root, f.state, (n,s,task)=>f.coordinator.run(n,s,task));
    const restarted = await start({ workspaceSync: sync });
    expect(await (await fetch(`${restarted.url}/api/v3/workspace/identity`, { headers })).json()).toEqual(identity);
    const retry = await fetch(`${restarted.url}/api/v3/workspace/push`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(accepted);
  });

  it("returns bounded JSON errors and a 413 before accepting oversized declared bodies", async () => {
    const { sync } = await fixture();
    const { url } = await start({ workspaceSync: sync });
    for (const [route, limit] of [["push", 32], ["asset", 73]] as const) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(`${url}/api/v3/workspace/${route}`, { method: "POST", agent: false, headers: { ...headers, "Connection": "close", "Content-Length": limit * 1024 * 1024 + 1 } }, response => {
          response.resume();
          response.once("end", () => resolve(response.statusCode!));
        });
        req.on("error", reject);
        req.end("{}");
      });
      expect(status).toBe(413);
      for (const body of ["{", "[]", "null"]) {
        const result = await fetch(`${url}/api/v3/workspace/${route}`, { method: "POST", headers, body });
        expect(result.status).toBe(400);
        expect(await result.json()).toEqual({ error: "invalid_request" });
      }
    }
  });
});
