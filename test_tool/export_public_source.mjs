import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.argv[2] ?? path.join(projectRoot, "output", "public-source", "MathNotes-OpenSource"));
const allowedOutputParent = path.join(projectRoot, "output", "public-source");
if (outputRoot !== allowedOutputParent && !outputRoot.startsWith(`${allowedOutputParent}${path.sep}`)) {
  throw new Error(`Refusing to replace output outside ${allowedOutputParent}`);
}

const exactRootFiles = new Set([
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
  if (excludedPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(prefix))) return false;
  if (exactRootFiles.has(relativePath)) return true;
  if (allowedPrefixes.some((prefix) => relativePath.startsWith(prefix))) return true;
  return false;
}).sort();

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const manifestFiles = [];
for (const relativePath of selected) {
  const source = path.join(projectRoot, relativePath);
  const metadata = await stat(source);
  if (!metadata.isFile()) throw new Error(`Only regular files may be exported: ${relativePath}`);
  const destination = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  const bytes = await readFile(destination);
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
