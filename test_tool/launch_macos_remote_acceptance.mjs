import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { build } from "esbuild";

const repository = process.cwd();
const root = await mkdtemp(path.join(tmpdir(), "mathnotes-remote-acceptance-"));
const app = path.join(root, "MathNotes.app");
const catalogConflict = process.argv.includes("--catalog-conflict");
// Optional read-only archive of an upstream host revision, for cross-version UI acceptance.
const hostSource = path.resolve(process.argv.find(arg => arg.startsWith("--host-source="))?.slice("--host-source=".length) ?? repository);
const hostCore = path.join(hostSource, "packages/core-server/src");
const fixture = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? "output/macos-feature-demo-6e5f0dd");
await cp("output/macos-native/bundle/MathNotes.app", app, { recursive: true });
await cp(fixture, path.join(root, "local/notes"), { recursive: true });
await cp(fixture, path.join(root, "host/notes"), { recursive: true });
const bundleID = `com.mathnotes.remote-acceptance.${randomUUID().toLowerCase()}`;
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
}
run(process.execPath, ["test_tool/build_macos_sidecar.mjs"]);
await cp("output/macos-sidecar/core-server.mjs", path.join(app, "Contents/Resources/MathNotesRuntime/core-server.mjs"));
const sourceRoot = "apps/macos/Sources/MathNotesMac";
const sources = (await readdir(sourceRoot)).filter(name => name.endsWith(".swift") && name !== "MathNotesMacApp.swift").map(name => path.join(sourceRoot, name));
run("swiftc", ["-parse-as-library", "-target", "arm64-apple-macosx14.0", ...sources,
  "apps/macos/.build/debug/MathNotesMac.build/DerivedSources/resource_bundle_accessor.swift",
  "test_tool/macos_remote_acceptance.swift", "-o", path.join(app, "Contents/MacOS/MathNotes")]);
run("plutil", ["-replace", "CFBundleIdentifier", "-string", bundleID, path.join(app, "Contents/Info.plist")]);
run("codesign", ["--force", "--sign", "-", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
await build({ stdin: { resolveDir: repository, loader: "ts", contents: `
  import { NetworkApiServer } from ${JSON.stringify(path.join(hostCore, "api/networkApiServer"))};
  import { WorkspaceSyncService } from ${JSON.stringify(path.join(hostCore, "sync/workspaceSyncService"))};
  import { WorkspaceCatalogSyncService } from ${JSON.stringify(path.join(hostCore, "sync/workspaceCatalogSyncService"))};
  import { SessionWriteCoordinator } from ${JSON.stringify(path.join(hostCore, "session/sessionWriteCoordinator"))};
  import { ReplicaWorkspaceService } from './packages/core-server/src/sync/replicaWorkspaceService';
  import { createWorkspaceNotebook, createWorkspaceSession } from './packages/core-server/src/catalog/workspaceCommandService';
  import { SessionEditService } from './packages/core-server/src/session/sessionEditService';
  import { readReadonlySessionBlock } from './packages/core-server/src/session/sessionReadService';
  import { writeFile } from 'node:fs/promises';
  import { randomUUID } from 'node:crypto';
  async function main() {
    const root = process.argv[2], notes = root + '/host/notes', state = root + '/host/state';
    const writes = new SessionWriteCoordinator();
    const host = new WorkspaceSyncService(notes, state, (n,s,op) => writes.run(n,s,op));
    const catalog = new WorkspaceCatalogSyncService(notes, state, writes);
    await catalog.recover();
    const token = randomUUID() + randomUUID();
    const server = new NetworkApiServer({host:'127.0.0.1',port:0,token,workspaceSync:host,workspaceCatalog:catalog});
    const ready = await server.start();
    const connection = {origin:ready.url,token,hostId:(await host.identity()).hostId};
    if (${catalogConflict}) {
      const {notebookId} = await createWorkspaceNotebook({rootDir:notes,title:'目录冲突验收（主机）'});
      const {sessionId} = await createWorkspaceSession({rootDir:notes,notebookId,title:'冲突中保留的笔记'});
      const replicaRoot = root + '/RemoteLibraries/' + connection.hostId;
      const replica = new ReplicaWorkspaceService(replicaRoot + '/notes', replicaRoot + '/data/replica-state', new SessionWriteCoordinator());
      await replica.sync(connection);
      await replica.manageWorkspace({action:'rename',notebookId,title:'Mac 离线改名'});
      const block = await readReadonlySessionBlock({rootDir:notes,notebookId,sessionId,blockId:'0001'});
      if (block.content.kind !== 'markdown') throw new Error('Unexpected synthetic block');
      const markdown = '## 主机更新保留验收\\n\\n采用主机版本后应看到这段内容。\\n';
      await new SessionEditService(notes, undefined, writes).saveMarkdownBlock({notebookId,sessionId,blockId:'0001',markdown,baseRevision:block.content.baseRevision});
      const result = await replica.sync(connection);
      if (!result.catalogOperations?.some(item => item.status === 'conflict')) throw new Error('Missing synthetic conflict');
      await writeFile(root + '/conflict-fixture.json', JSON.stringify({notebookId,sessionId,markdown}));
    }
    await writeFile(root + '/host-ready.json', JSON.stringify(connection), {mode:0o600});
    for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => void server.stop().then(() => process.exit(0)));
  }
  main().catch(error => { console.error(error); process.exit(1); });
` }, outfile: path.join(root, "host.cjs"), bundle: true, platform: "node", format: "cjs",
  alias: { "@mathnotes/shared": path.join(repository, "packages/shared/src/index.ts") } });
const host = spawn(process.execPath, [path.join(root, "host.cjs"), root], { detached: true, stdio: "ignore" });
host.unref();
const deadline = Date.now() + 10000;
while (true) {
  try { await readFile(path.join(root, "host-ready.json")); break; }
  catch { assert(Date.now() < deadline, "Synthetic host did not start"); await new Promise(resolve => setTimeout(resolve, 50)); }
}
run("/usr/bin/open", ["-n", app, "--env", `MATHNOTES_ACCEPTANCE_ROOT=${root}`, "--env", `MATHNOTES_PHASE1A_ROOT=${root}`,
  "--stdout", path.join(root, "app.stdout.log"), "--stderr", path.join(root, "app.stderr.log")]);
await mkdir("output/macos-local-debug", { recursive: true });
const report = { root, app, bundleID, hostPID: host.pid, hostSource, scope: "synthetic localhost host and native product views; no Keychain or real notes; not Windows OS acceptance" };
await writeFile("output/macos-local-debug/remote-acceptance.json", JSON.stringify(report, null, 2));
await writeFile(path.join(root, "README.txt"), "This is a synthetic native UI acceptance fixture, not an installed product.\nAll remote traffic is to a temporary localhost host. Credentials never touch Keychain.\nClose the acceptance app when finished, then stop the recorded hostPID after verifying it still points to this root's host.cjs.\nThe production Settings scene is deliberately outside this harness; verify it in the packaged app.\n");
console.log(JSON.stringify(report, null, 2));
