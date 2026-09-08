import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicMaterial, isInternalPublicationPath } from "./public_material_policy.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.argv[2] ?? path.join(projectRoot, "output", "public-source", "MathNotes-OpenSource"));
const allowedOutputParent = path.join(projectRoot, "output", "public-source");
if (outputRoot !== allowedOutputParent && !outputRoot.startsWith(`${allowedOutputParent}${path.sep}`)) {
  throw new Error(`Refusing to replace output outside ${allowedOutputParent}`);
}

const exactRootFiles = new Set([
  ".gitattributes",
  ".gitignore",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "package-lock.json",
  "package.json",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "tsconfig.base.json"
]);
const allowedPrefixes = [
  ".github/",
  "apps/",
  "assets/",
  "contracts/",
  "deploy/",
  "packages/",
  "test_tool/"
];
const excludedPrefixes = [
  "test_tool/README.md",
  "test_tool/check-environment.ps1",
  "test_tool/create-worktree.ps1",
  "test_tool/push-github-backup.ps1",
  "test_tool/redact-transcript.ps1",
  "test_tool/recover-state.ps1",
  "test_tool/run-tests.ps1",
  "test_tool/validate-knowledge.ps1",
  "test_tool/validate-harness.ps1",
  "test_tool/corpus/",
  "test_tool/output/"
];

const status = git(["status", "--porcelain"]);
if (status.trim()) throw new Error("Public source export requires a clean committed worktree.");
const commit = git(["rev-parse", "HEAD"]).trim();
const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean).map(normalize);
const selected = tracked.filter((relativePath) => {
  if (isInternalPublicationPath(relativePath)) return false;
  if (excludedPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(prefix))) return false;
  if (exactRootFiles.has(relativePath)) return true;
  if (allowedPrefixes.some((prefix) => relativePath.startsWith(prefix))) return true;
  return false;
}).sort();

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const manifestFiles = [];
// Export committed blobs, not checkout bytes whose CRLF conversion can differ
// between Windows and macOS. The manifest must describe the published source.
const objects = spawnSync("git", ["cat-file", "--batch"], {
  cwd: projectRoot,
  input: selected.map((relativePath) => `${commit}:${relativePath}\n`).join(""),
  maxBuffer: 256 * 1024 * 1024,
  windowsHide: true
});
if (objects.status !== 0) throw new Error("Unable to read committed public-source blobs.");
let offset = 0;
for (const relativePath of selected) {
  const end = objects.stdout.indexOf(0x0a, offset);
  if (end < 0) throw new Error(`Missing committed blob header: ${relativePath}`);
  const header = objects.stdout.subarray(offset, end).toString("utf8");
  const match = header.match(/^[a-f0-9]+ blob (\d+)$/);
  if (!match) throw new Error(`Only committed blobs may be exported: ${relativePath}`);
  const size = Number(match[1]);
  const bytes = objects.stdout.subarray(end + 1, end + 1 + size);
  offset = end + 1 + size + 1;
  if (bytes.length !== size || objects.stdout[offset - 1] !== 0x0a) {
    throw new Error(`Incomplete committed blob: ${relativePath}`);
  }
  const destination = path.join(outputRoot, relativePath);
  assertPublicMaterial(relativePath, bytes);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  manifestFiles.push({ path: relativePath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}

const manifest = {
  schemaVersion: 1,
  license: "GPL-3.0-only",
  historyPolicy: "sanitized-single-snapshot",
  generatedAt: new Date().toISOString(),
  fileCount: manifestFiles.length,
  snapshotSha256: createHash("sha256").update(manifestFiles.map((entry) => `${entry.path}\0${entry.sha256}`).join("\n")).digest("hex"),
  files: manifestFiles
};
await writeFile(path.join(outputRoot, "PUBLIC_SOURCE_MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const forbiddenPaths = ["TODO.md", "AGENTS.md", "CLAUDE.md", "USER.md", "WORKFLOW.md", "LEARNING.md", "MEMORY.md", "GOVERNANCE.md", "RED-TEAM.md", "ARCHITECTURE.md", "PRD.md", "DEPENDENCIES.md", "dependencies.json", "dependencies.macos.json", "CHANGELOG.md"];
for (const forbidden of forbiddenPaths) {
  if (selected.includes(forbidden)) throw new Error(`Internal project file exported: ${forbidden}`);
}
const dangerousNames = /(^|\/)(\.env($|\.)|[^/]+\.(jks|keystore|p12|pfx|pem|key))$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/
];
for (const entry of manifestFiles) {
  if (dangerousNames.test(entry.path)) throw new Error(`Secret-bearing filename exported: ${entry.path}`);
  if (/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|jar|class)$/i.test(entry.path)) continue;
  const contents = (await readFile(path.join(outputRoot, entry.path), "utf8"))
    .replaceAll("sk-test-secret-1234567890", "ALLOWLISTED_TEST_SECRET");
  if (secretPatterns.some((pattern) => pattern.test(contents))) throw new Error(`Possible secret in export: ${entry.path}`);
  if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.path)) {
    const privatePathPatterns = [
      /C:\\Users\\Administrator/i,
      /\/Users\/wu(?:\/|$)/,
      /E:\\opensourceproject/i,
      /theincrediblewwz\/MathNotes(?!-OpenSource)/i
    ];
    if (privatePathPatterns.some((pattern) => pattern.test(contents))) throw new Error(`Private-machine reference in export: ${entry.path}`);
  }
}

console.log(`PUBLIC_SOURCE_EXPORT_OK commit=${commit} files=${manifestFiles.length} output=${outputRoot}`);

function git(args) {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}
