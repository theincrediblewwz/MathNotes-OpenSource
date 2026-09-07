import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { listFiles, safeRelativePath, sha256, verifyPwaUpdate } from "./verify_pwa_update.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function assertSafeOutputPath(root, target) {
  const canonicalRoot = await realpath(root);
  const resolved = path.resolve(target);
  const relative = path.relative(canonicalRoot, resolved);
  const parts = relative.split(path.sep);
  if (parts.length < 2 || parts[0] !== "output" || parts.includes("..") || path.isAbsolute(relative)) throw new Error(`OUTPUT_BOUNDARY: ${target}`);
  let current = canonicalRoot;
  for (const part of parts) {
    current = path.join(current, part);
    const entry = await lstat(current).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (entry?.isSymbolicLink()) throw new Error(`OUTPUT_SYMLINK: ${current}`);
  }
  return resolved;
}

export async function packagePwaUpdate({ sourceRef = "HEAD", baseRef } = {}) {
  if (!baseRef) throw new Error("Specify --base-ref=<the PWA source baseline commit> so the patch scope is explicit.");
  const sourceCommit = git(["rev-parse", "--verify", `${sourceRef}^{commit}`]).trim();
  const baseCommit = git(["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^[a-f0-9]{40}$/.test(baseCommit)) throw new Error("Commit could not be resolved");
  const pwaPackage = JSON.parse(git(["show", `${sourceCommit}:apps/pwa/package.json`]));
  const version = pwaPackage.version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Invalid PWA package version");
  assertPwaMatchesSource(sourceCommit);
  runNpm(["run", "build", "--workspace", "@mathnotes/pwa"]);
  assertPwaMatchesSource(sourceCommit);

  const outputRoot = await assertSafeOutputPath(projectRoot, path.join(projectRoot, "output", "pwa-update"));
  const directoryName = `MathNotes-PWA-${version}`;
  const stageRoot = path.join(outputRoot, directoryName);
  const archiveName = `MathNotes-PWA-${version}-${sourceCommit.slice(0, 12)}-update.zip`;
  const archivePath = await assertSafeOutputPath(projectRoot, path.join(projectRoot, "output", "releases", archiveName));
  // Never recurse outside this exact worktree's output subtree, including through junctions.
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true }); await mkdir(path.dirname(archivePath), { recursive: true });
  await cp(path.join(projectRoot, "apps/pwa/dist"), path.join(stageRoot, "MathNotesPWA"), { recursive: true, dereference: false });

  const sourceFiles = git(["ls-tree", "-r", "--name-only", sourceCommit, "--", "apps/pwa"]).trim().split("\n").filter(Boolean);
  for (const name of sourceFiles) {
    if (!safeRelativePath(name) || !name.startsWith("apps/pwa/") || /(?:^|\/)(?:node_modules|dist|\.env)(?:\/|$)/.test(name)) throw new Error(`Unsafe PWA source path: ${name}`);
    await writePayload(`source/${name}`, gitBytes(["show", `${sourceCommit}:${name}`]));
  }
  await writePayload("reference/package.json", gitBytes(["show", `${sourceCommit}:package.json`]));
  await writePayload("reference/package-lock.json", gitBytes(["show", `${sourceCommit}:package-lock.json`]));
  await writePayload("patches/pwa-update.patch", gitBytes(["diff", "--no-ext-diff", "--no-color", "--binary", "--full-index", baseCommit, sourceCommit, "--", "apps/pwa"]));
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) await writePayload(name, gitBytes(["show", `${sourceCommit}:${name}`]));
  await writePayload("verify-pwa-update.mjs", await readFile(path.join(projectRoot, "test_tool/verify_pwa_update.mjs")));
  const pwaTree = git(["rev-parse", `${sourceCommit}:apps/pwa`]).trim();
  let instructions = await readFile(path.join(projectRoot, "deploy/pwa/MAC_CODEX_UPDATE.md"), "utf8");
  for (const [key, value] of Object.entries({ PWA_VERSION: version, SOURCE_COMMIT: sourceCommit, BASE_COMMIT: baseCommit, PWA_TREE: pwaTree })) instructions = instructions.replaceAll(`{{${key}}}`, value);
  if (/\{\{[A-Z_]+\}\}/.test(instructions)) throw new Error("Unexpanded handoff placeholder");
  await writePayload("MAC_CODEX_HANDOFF.md", instructions);
  await writePayload("DEPLOYMENT.md", await readFile(path.join(projectRoot, "deploy/pwa/README.md")));
  const files = await Promise.all((await listFiles(stageRoot)).map(async name => {
    const bytes = await readFile(path.join(stageRoot, name));
    return { path: name, bytes: bytes.length, sha256: sha256(bytes) };
  }));
  const manifest = {
    schemaVersion: 1, product: "MathNotes PWA Update", packageVersion: version,
    sourceCommit, sourcePwaTree: pwaTree, patchBaseCommit: baseCommit,
    sourceCommitTime: git(["show", "-s", "--format=%cI", sourceCommit]).trim(),
    staticRoot: "MathNotesPWA", macBundleTarget: "Contents/Resources/MathNotesPWA",
    sourceRoot: "source/apps/pwa", sourceSnapshotEncoding: "committed Git blobs; no Windows newline conversion",
    dependencyReference: "reference/package-lock.json", buildNodeVersion: process.version,
    includesMacNativeCode: false, includesCoreServer: false,
    manifestScope: "all payload files except artifact-manifest.json and SHA256SUMS; archive SHA-256 covers the complete ZIP", files
  };
  await writePayload("artifact-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const checksumLines = await Promise.all([...files.map(file => file.path), "artifact-manifest.json"].sort().map(async name => `${sha256(await readFile(path.join(stageRoot, name)))}  ${name}`));
  await writePayload("SHA256SUMS", `${checksumLines.join("\n")}\n`);
  await verifyPwaUpdate(stageRoot);
  const archiveEntries = await Promise.all((await listFiles(stageRoot)).map(async name => ({ path: `${directoryName}/${name}`, bytes: await readFile(path.join(stageRoot, name)) })));
  const zip = createZip(archiveEntries);
  await writeFile(archivePath, zip);
  await writeFile(`${archivePath}.sha256`, `${sha256(zip)}  ${archiveName}\n`);
  const report = { version, sourceCommit, sourcePwaTree: pwaTree, stageRoot, archivePath, archiveBytes: zip.length, sha256: sha256(zip), payloadFiles: files.length };
  console.log(`PWA_UPDATE_PACKAGE=${JSON.stringify(report)}`);
  return report;

  async function writePayload(name, bytes) {
    if (!safeRelativePath(name)) throw new Error(`Unsafe payload path: ${name}`);
    const target = path.join(stageRoot, ...name.split("/")); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  }
}

function assertPwaMatchesSource(sourceCommit) {
  git(["diff", "--quiet", sourceCommit, "--", "apps/pwa", "package.json", "package-lock.json", "deploy/pwa", "test_tool/verify_pwa_update.mjs"]);
  if (git(["ls-files", "--others", "--exclude-standard", "--", "apps/pwa"]).trim()) throw new Error("PWA has untracked source; commit it before packaging");
}
function gitBytes(args) {
  const result = spawnSync("git", args, { cwd: projectRoot, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.slice(0, 2).join(" ")} failed: ${result.stderr?.toString() || result.error?.message || "PWA source differs from the selected committed revision"}`);
  return result.stdout;
}
function git(args) { return gitBytes(args).toString("utf8"); }
function runNpm(args) {
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
  const result = process.platform === "win32"
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: projectRoot, stdio: "inherit", windowsHide: true })
    : spawnSync("npm", args, { cwd: projectRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error("PWA build failed");
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function createZip(entries) {
  const local = [], central = []; let offset = 0;
  const paths = new Set();
  if (entries.length > 65535) throw new Error("ZIP64 is not supported");
  for (const entry of [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (!safeRelativePath(entry.path) || paths.has(entry.path)) throw new Error(`Unsafe or duplicate ZIP path: ${entry.path}`);
    paths.add(entry.path);
    const name = Buffer.from(entry.path, "utf8"), bytes = Buffer.from(entry.bytes), compressed = deflateRawSync(bytes, { level: 9 });
    if (bytes.length > 0xffffffff || compressed.length > 0xffffffff || name.length > 65535) throw new Error("ZIP entry is too large");
    const crc = crc32(bytes), header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x0021, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(0x0021, 14);
    directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--source-ref=")) options.sourceRef = arg.slice(13);
    else if (arg.startsWith("--base-ref=")) options.baseRef = arg.slice(11);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  await packagePwaUpdate(options);
}
