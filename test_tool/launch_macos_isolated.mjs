import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Leave this empty-data app running for manual phone pairing. Its data, token,
// logs, and preference domain are separate from the installed MathNotes app.
const source = path.resolve(process.argv[2] ?? "output/macos-native/bundle/MathNotes.app");
// Optional synthetic notes fixture, copied into the isolated data directory.
const notesFixture = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const debugRoot = path.resolve("output/macos-local-debug");
await mkdir(debugRoot, { recursive: true });
// Preview fixtures do not need a persistent Documents data directory. Keeping
// them in temp also avoids a fresh test bundle waiting on Documents access.
const root = await mkdtemp(notesFixture
  ? path.join(tmpdir(), "mathnotes-preview-acceptance-")
  : path.join(debugRoot, "isolated-run."));
const app = path.join(root, "MathNotes.app");
const bundleID = `com.mathnotes.isolated.${randomUUID().toLowerCase()}`;
await cp(source, app, { recursive: true });
await mkdir(path.join(root, "notes"));
if (notesFixture) await cp(notesFixture, path.join(root, "notes"), { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
}
run("plutil", ["-replace", "CFBundleIdentifier", "-string", bundleID, path.join(app, "Contents/Info.plist")]);
run("codesign", ["--force", "--sign", "-", app]);
run("codesign", ["--verify", "--deep", "--strict", app]);
// Seed this isolated bundle's default; a launch argument would override every
// later AppStorage write and make the Local / Remote picker snap back forever.
run("/usr/bin/defaults", ["write", bundleID, "mathnotes.workspace.source.v1", "-string", "local"]);
const environment = {
  MATHNOTES_PHASE1A_ROOT: root,
  MATHNOTES_NOTES_ROOT_DIR: path.join(root, "notes"),
  MATHNOTES_COMPANION_TOKEN_FILE: path.join(root, "companion-token")
};
run("/usr/bin/open", ["-n", app,
  "--stdout", path.join(root, "app.stdout.log"), "--stderr", path.join(root, "app.stderr.log"),
  ...Object.entries(environment).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
  "--args", "-mathnotes.directory.notesRoot.bookmark", "",
  "-mathnotes.directory.notesRoot.path", path.join(root, "notes"),
  ...(notesFixture ? [] : ["-mathnotes.open-phone-connection"])]);
await writeFile(path.join(debugRoot, "last-isolated-run.json"), JSON.stringify({ root, app, bundleID }, null, 2));
console.log(`ISOLATED_APP=${app}`);
console.log(`ISOLATED_DATA=${root}`);
