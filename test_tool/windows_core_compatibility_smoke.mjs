#!/usr/bin/env node
// Run the committed Windows host Core against this checkout's Mac replica client.
// This is a protocol test on the current OS, not Windows/Electron acceptance.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const ref = process.argv[2];
assert(ref && !ref.startsWith("-"), "Pass a fetched Windows commit or branch ref");
const root = process.cwd();
const commit = execFileSync("git", ["rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
const temporary = await mkdtemp(join(tmpdir(), "mathnotes-windows-protocol-"));
const require = createRequire(import.meta.url);
let server;
try {
  const source = join(temporary, "windows-source");
  await mkdir(source);
  const archive = join(temporary, "source.tar");
  execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, commit,
    "packages/core-server", "packages/shared", "packages/sync-contract", "tsconfig.base.json"]);
  execFileSync("tar", ["-xf", archive, "-C", source]);
  async function bundle(directory, name, exports) {
    const outfile = join(temporary, `${name}.cjs`);
    await build({ stdin: { contents: exports, resolveDir: directory, loader: "ts" },
      outfile, bundle: true, platform: "node", format: "cjs", target: "node22",
      nodePaths: [join(root, "node_modules")],
      alias: { "@mathnotes/shared": join(directory, "packages/shared/src/index.ts"),
        "@mathnotes/sync-contract": join(directory, "packages/sync-contract/src/index.ts") } });
    return require(outfile);
  }
  const hostCode = await bundle(source, "host", `
    export { NetworkApiServer } from './packages/core-server/src/api/networkApiServer';
    export { WorkspaceSyncService, replicaRevision } from './packages/core-server/src/sync/workspaceSyncService';
    export { SessionWriteCoordinator } from './packages/core-server/src/session/sessionWriteCoordinator';
  `);
  const mac = await bundle(root, "mac", `
    export { ReplicaWorkspaceService } from './packages/core-server/src/sync/replicaWorkspaceService';
    export { SessionWriteCoordinator } from './packages/core-server/src/session/sessionWriteCoordinator';
    export { createWorkspaceNotebook, createWorkspaceSession } from './packages/core-server/src/catalog/workspaceCommandService';
    export { SessionEditService } from './packages/core-server/src/session/sessionEditService';
    export { readReadonlySessionBlock } from './packages/core-server/src/session/sessionReadService';
  `);
  const hostRoot = join(temporary, "host-notes");
  const replicaRoot = join(temporary, "mac-replica");
  const state = join(temporary, "mac-state");
  const { notebookId } = await mac.createWorkspaceNotebook({ rootDir: hostRoot, title: "Protocol fixture" });
  const { sessionId } = await mac.createWorkspaceSession({ rootDir: hostRoot, notebookId, title: "Cross revision" });
  const hostWrites = new hostCode.SessionWriteCoordinator();
  const host = new hostCode.WorkspaceSyncService(hostRoot, join(temporary, "host-state"),
    (n, s, operation) => hostWrites.run(n, s, operation));
  const token = randomUUID(); // Synthetic, localhost-only test credential.
  server = new hostCode.NetworkApiServer({ host: "127.0.0.1", port: 0, token, workspaceSync: host });
  const started = await server.start();
  const connection = { origin: started.url, token, hostId: (await host.identity()).hostId };
  const writes = new mac.SessionWriteCoordinator();
  let replica = new mac.ReplicaWorkspaceService(replicaRoot, state, writes);
  async function text(directory) {
    const block = await mac.readReadonlySessionBlock({ rootDir: directory, notebookId, sessionId, blockId: "0001" });
    assert.equal(block.content.kind, "markdown"); return block.content.markdown;
  }
  async function edit(directory, markdown) {
    const block = await mac.readReadonlySessionBlock({ rootDir: directory, notebookId, sessionId, blockId: "0001" });
    await new mac.SessionEditService(directory, undefined, directory === replicaRoot ? writes : hostWrites)
      .saveMarkdownBlock({ notebookId, sessionId, blockId: "0001", markdown, baseRevision: block.content.baseRevision });
  }
  async function synced() {
    const result = await replica.sync(connection);
    assert.equal(result.sessions.find(s => s.sessionId === sessionId)?.status, "synced", JSON.stringify(result));
    return result;
  }
  const first = await synced();
  assert.equal(first.catalogManagementAvailable, false, "This Windows revision has no catalog mutation API");
  await edit(replicaRoot, "Mac → Windows 正文 $x^2$\n");
  await synced(); assert.match(await text(hostRoot), /Mac → Windows/);
  await edit(hostRoot, "Windows → Mac 后续修改\n");
  await synced(); assert.match(await text(replicaRoot), /Windows → Mac/);
  console.log("WINDOWS_CORE_BIDIRECTIONAL_CONTENT_OK");
  await edit(replicaRoot, "本地离线修改\n");
  await edit(hostRoot, "主机并发修改\n");
  const conflict = await replica.sync(connection);
  assert.equal(conflict.sessions[0].status, "conflict");
  assert.equal(await text(hostRoot), "主机并发修改\n");
  assert.equal(await text(replicaRoot), "本地离线修改\n");
  await replica.resolve({ notebookId, sessionId, choice: "remote" });
  await synced();
  replica = new mac.ReplicaWorkspaceService(replicaRoot, state, writes);
  await synced();
  console.log("WINDOWS_CORE_CONFLICT_AND_RESTART_OK");

  // A selection may split a Markdown image destination across fixed block fragments.
  const sessionDir = join(hostRoot, "notebooks", notebookId, "sessions", sessionId);
  const sessionFile = join(sessionDir, "session.json");
  const session = JSON.parse(await readFile(sessionFile, "utf8"));
  const bytes = Buffer.from("isolated image fixture bytes");
  const assetPath = "assets/原图 (1).png";
  await mkdir(join(sessionDir, "assets"), { recursive: true });
  await writeFile(join(sessionDir, assetPath), bytes);
  const parts = ["识别图形\n\n![原图](../assets/", "%E5%8E%9F%E5%9B%BE%20", "%281%29.png)\n\n说明\n"];
  session.blocks = parts.map((part, index) => ({ ...session.blocks[0], id: `000${index + 1}`,
    path: `blocks/fragment${index}.md`, continuationGroup: "source-photo-split",
    status: index === 1 ? "locked" : "draft" }));
  session.locks = [];
  for (let index = 0; index < parts.length; index++) await writeFile(join(sessionDir, session.blocks[index].path), parts[index]);
  await writeFile(sessionFile, JSON.stringify(session));
  assert.deepEqual((await host.snapshot(notebookId, sessionId)).assets.map(a => a.path), [assetPath]);
  await synced();
  assert.deepEqual(await readFile(join(replicaRoot, "notebooks", notebookId, "sessions", sessionId, assetPath)), bytes);
  console.log("WINDOWS_CORE_CONTINUATION_IMAGE_DOWNLOAD_OK");
  await edit(replicaRoot, "Mac 追加说明\n" + parts[0]);
  await synced();
  assert.match(await text(hostRoot), /Mac 追加说明/);
  console.log("WINDOWS_CORE_CONTINUATION_IMAGE_PUSH_OK");
  // Exercise the real Windows HTTP error mapping, not just a shared service call.
  const base = await host.snapshot(notebookId, sessionId);
  const changed = structuredClone(base);
  changed.markdown[changed.session.blocks[1].path] = "cannot alter locked fragment";
  const rejected = await fetch(`${started.url}/api/v3/workspace/push`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: randomUUID(), baseRevision: base.revision, snapshot: changed }) });
  assert.equal(rejected.status, 423);
  assert.equal((await host.snapshot(notebookId, sessionId)).revision, base.revision);
  console.log("WINDOWS_CORE_LOCKED_WRITE_HTTP_423_OK");
  // Keep a concrete compatibility report for Windows follow-up. Encoded '#'
  // is a legal filename character and is already supported by Mac source images.
  const special = await mac.createWorkspaceSession({ rootDir: hostRoot, notebookId, title: "Encoded filename" });
  const specialDir = join(hostRoot, "notebooks", notebookId, "sessions", special.sessionId);
  const specialFile = join(specialDir, "session.json");
  const specialSession = JSON.parse(await readFile(specialFile, "utf8"));
  await mkdir(join(specialDir, "assets"), { recursive: true });
  await writeFile(join(specialDir, "assets/photo#50%.png"), bytes);
  await writeFile(join(specialDir, specialSession.blocks[0].path), "![photo](../assets/photo%2350%25.png)\n");
  try {
    assert.equal((await host.snapshot(notebookId, special.sessionId)).assets[0].path, "assets/photo#50%.png");
    console.log("WINDOWS_CORE_ENCODED_HASH_FILENAME_OK");
  } catch (error) {
    if (error?.code !== "unsafe_path") throw error;
    console.log("WINDOWS_CORE_KNOWN_GAP_ENCODED_HASH_FILENAME: Windows rejects literal %23 in an asset filename; no user data used");
  }
  console.log(`WINDOWS_CORE_PROTOCOL_OK commit=${commit} platform=${process.platform}`);
} finally {
  await server?.stop();
  await rm(temporary, { recursive: true, force: true });
}
