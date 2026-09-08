import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceNotebook, createWorkspaceSession } from "../catalog/workspaceCommandService";
import { SessionEditService } from "../session/sessionEditService";
import { readReadonlySessionBlock } from "../session/sessionReadService";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";
import { NetworkApiServer } from "../api/networkApiServer";
import { WorkspaceSyncService } from "./workspaceSyncService";
import { ReplicaWorkspaceService } from "./replicaWorkspaceService";
const roots: string[] = []; const servers: NetworkApiServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => server.stop()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-replica-")); roots.push(root);
  const remoteRoot = join(root, "host"); const localRoot = join(root, "replica");
  const notebook = await createWorkspaceNotebook({ rootDir: remoteRoot, title: "Remote notebook" });
  const session = await createWorkspaceSession({ rootDir: remoteRoot, notebookId: notebook.notebookId, title: "Remote session" });
  const hostWrites = new SessionWriteCoordinator();
  const host = new WorkspaceSyncService(remoteRoot, join(root, "host-state"), (n, s, op) => hostWrites.run(n, s, op));
  const token = "test-host-credential";
  const server = new NetworkApiServer({ host: "127.0.0.1", port: 0, token, workspaceSync: host }); servers.push(server);
  const started = await server.start();
  const connection = { origin: started.url, token, hostId: (await host.identity()).hostId };
  const writes = new SessionWriteCoordinator();
  const stateDir = join(root, "replica-state");
  const replica = new ReplicaWorkspaceService(localRoot, stateDir, writes);
  return { root, remoteRoot, localRoot, host, replica, writes, stateDir, connection, server, notebookId: notebook.notebookId, sessionId: session.sessionId };
}
async function edit(rootDir: string, notebookId: string, sessionId: string, text: string, writes?: SessionWriteCoordinator) {
  const block = await readReadonlySessionBlock({ rootDir, notebookId, sessionId, blockId: "0001" });
  if (block.content.kind !== "markdown") throw new Error("fixture");
  await new SessionEditService(rootDir, undefined, writes).saveMarkdownBlock({ notebookId, sessionId, blockId: "0001", markdown: text, baseRevision: block.content.baseRevision });
}
async function text(rootDir: string, notebookId: string, sessionId: string) {
  const block = await readReadonlySessionBlock({ rootDir, notebookId, sessionId, blockId: "0001" });
  if (block.content.kind !== "markdown") throw new Error("fixture"); return block.content.markdown;
}
describe("isolated local replicas", () => {
  it("downloads real editable notes, pushes local edits and pulls later host changes", async () => {
    const f = await fixture();
    expect((await f.replica.sync(f.connection)).sessions[0].status).toBe("synced");
    expect(await text(f.localRoot, f.notebookId, f.sessionId)).toBe(await text(f.remoteRoot, f.notebookId, f.sessionId));
    await edit(f.localRoot, f.notebookId, f.sessionId, "Mac edit", f.writes);
    expect((await f.replica.sync(f.connection)).sessions[0].status).toBe("synced");
    expect(await text(f.remoteRoot, f.notebookId, f.sessionId)).toBe("Mac edit");
    await edit(f.remoteRoot, f.notebookId, f.sessionId, "Windows edit");
    expect((await f.replica.sync(f.connection)).sessions[0].status).toBe("synced");
    expect(await text(f.localRoot, f.notebookId, f.sessionId)).toBe("Windows edit");
  });
  it("recovers a durable pending operation after the host applied it but the response was lost", async () => {
    const f = await fixture(); await f.replica.sync(f.connection);
    await edit(f.localRoot, f.notebookId, f.sessionId, "Offline-safe edit", f.writes);
    const fetch = globalThis.fetch;
    let lost = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]).endsWith("/workspace/push") && !lost) { lost = true; throw new Error("response lost"); }
      return response;
    });
    expect((await f.replica.sync(f.connection)).sessions[0].status).toBe("pending");
    expect(await text(f.localRoot, f.notebookId, f.sessionId)).toBe("Offline-safe edit");
    expect(await text(f.remoteRoot, f.notebookId, f.sessionId)).toBe("Offline-safe edit");
    const revision = (await f.host.snapshot(f.notebookId, f.sessionId)).revision;
    vi.restoreAllMocks();
    const restarted = new ReplicaWorkspaceService(f.localRoot, f.stateDir, f.writes);
    expect((await restarted.sync(f.connection)).sessions[0].status).toBe("synced");
    expect((await f.host.snapshot(f.notebookId, f.sessionId)).revision).toBe(revision);
  });
  it("preserves later local edits while replaying an older pending operation", async () => {
    const f = await fixture(); await f.replica.sync(f.connection);
    await edit(f.localRoot, f.notebookId, f.sessionId, "First local edit", f.writes);
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/workspace/push")) throw new Error("offline");
      return fetch(...args);
    });
    expect((await f.replica.sync(f.connection)).sessions[0].status).toBe("pending");
    await edit(f.localRoot, f.notebookId, f.sessionId, "Second local edit", f.writes);
    vi.restoreAllMocks();
    expect((await f.replica.sync(f.connection)).sessions[0].status).toBe("pending");
    expect(await text(f.localRoot, f.notebookId, f.sessionId)).toBe("Second local edit");
    expect((await f.replica.sync(f.connection)).sessions[0].status).toBe("synced");
    expect(await text(f.remoteRoot, f.notebookId, f.sessionId)).toBe("Second local edit");
  });
  it("does not rebase later local edits over newer host work when replay returns the current host snapshot", async () => {
    const f = await fixture(); await f.replica.sync(f.connection);
    await edit(f.localRoot, f.notebookId, f.sessionId, "First sent edit", f.writes);
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]).endsWith("/workspace/push")) throw new Error("lost reply");
      return response;
    });
    expect((await f.replica.sync(f.connection)).sessions[0].status).toBe("pending");
    vi.restoreAllMocks();
    await edit(f.remoteRoot, f.notebookId, f.sessionId, "New host work after first push");
    await edit(f.localRoot, f.notebookId, f.sessionId, "Later local draft", f.writes);
    expect((await f.replica.sync(f.connection)).sessions[0].status).toBe("conflict");
    expect(await text(f.remoteRoot, f.notebookId, f.sessionId)).toBe("New host work after first push");
    expect(await text(f.localRoot, f.notebookId, f.sessionId)).toBe("Later local draft");
  });
  it.each(["local", "remote"] as const)("keeps both sides of a conflict until explicit %s resolution", async choice => {
    const f = await fixture(); await f.replica.sync(f.connection);
    await edit(f.localRoot, f.notebookId, f.sessionId, "Mac conflict", f.writes);
    await edit(f.remoteRoot, f.notebookId, f.sessionId, "Windows conflict");
    expect((await f.replica.sync(f.connection)).sessions[0].status).toBe("conflict");
    expect(await text(f.localRoot, f.notebookId, f.sessionId)).toBe("Mac conflict");
    expect(await text(f.remoteRoot, f.notebookId, f.sessionId)).toBe("Windows conflict");
    expect(await f.replica.conflicts()).toHaveLength(1);
    await f.replica.resolve({ notebookId: f.notebookId, sessionId: f.sessionId, choice });
    expect((await f.replica.sync(f.connection)).sessions[0].status).toBe("synced");
    expect(await text(f.localRoot, f.notebookId, f.sessionId)).toBe(choice === "local" ? "Mac conflict" : "Windows conflict");
    const saved = await readdir(join(f.stateDir, "resolved"));
    const archive = await readFile(join(f.stateDir, "resolved", saved[0]), "utf8");
    expect(archive).toContain("Mac conflict"); expect(archive).toContain("Windows conflict");
  });
  it("keeps disconnected replicas readable and refuses to bind a different host to their folder", async () => {
    const a = await fixture(); const b = await fixture();
    await a.replica.sync(a.connection);
    await expect(a.replica.sync(b.connection)).rejects.toMatchObject({ code: "replica_host_mismatch" });
    await a.server.stop();
    await expect(a.replica.sync(a.connection)).rejects.toThrow();
    expect(await text(a.localRoot, a.notebookId, a.sessionId)).toContain("新 Session");
    const metadata = await readFile(join(a.stateDir, "host.json"), "utf8");
    expect(metadata).not.toContain(a.connection.token);
  });

  it("isolates hosts even when their notebook and session IDs are identical", async () => {
    const a = await fixture(); const b = await fixture();
    // Both are disposable fixtures. Clone IDs to exercise the collision users
    // encounter when two computers originally copied the same note library.
    await rm(join(b.remoteRoot, "notebooks"), { recursive: true });
    await cp(join(a.remoteRoot, "notebooks"), join(b.remoteRoot, "notebooks"), { recursive: true });
    await edit(a.remoteRoot, a.notebookId, a.sessionId, "Host A original");
    await edit(b.remoteRoot, a.notebookId, a.sessionId, "Host B original");
    expect(a.connection.hostId).not.toBe(b.connection.hostId);
    await Promise.all([a.replica.sync(a.connection), b.replica.sync(b.connection)]);
    expect(await text(a.localRoot, a.notebookId, a.sessionId)).toBe("Host A original");
    expect(await text(b.localRoot, a.notebookId, a.sessionId)).toBe("Host B original");
    await edit(a.localRoot, a.notebookId, a.sessionId, "Host A local edit", a.writes);
    await a.replica.sync(a.connection);
    expect(await text(a.remoteRoot, a.notebookId, a.sessionId)).toBe("Host A local edit");
    expect(await text(b.remoteRoot, a.notebookId, a.sessionId)).toBe("Host B original");
    await edit(a.localRoot, a.notebookId, a.sessionId, "Host A local conflict", a.writes);
    await edit(a.remoteRoot, a.notebookId, a.sessionId, "Host A remote conflict");
    expect((await a.replica.sync(a.connection)).sessions[0].status).toBe("conflict");
    const restartedB = new ReplicaWorkspaceService(b.localRoot, b.stateDir, b.writes);
    expect((await restartedB.sync(b.connection)).sessions[0].status).toBe("synced");
    expect(await restartedB.conflicts()).toEqual([]);
    expect(await text(b.localRoot, a.notebookId, a.sessionId)).toBe("Host B original");
  });
});
