import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicMode = process.argv.includes("--public");
const sourceMode = process.argv.includes("--source");
if (publicMode && sourceMode) throw new Error("Choose either --source or --public, not both.");
const findings = [];
const internalReleaseDocs = [
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
  "DEPENDENCIES.md",
  "docs/privacy-and-security.md",
  "docs/data-backup-and-recovery.md",
  "docs/release-installation.md",
  "docs/release-process.md",
  "docs/public-release-readiness.md"
];
const publicSourceDocs = [
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md"
];
const requiredDocs = sourceMode ? publicSourceDocs : internalReleaseDocs;

for (const relativePath of requiredDocs) {
  if (!await exists(path.join(projectRoot, relativePath))) add("ERROR", "MISSING_RELEASE_DOCUMENT", relativePath);
}

const rootPackage = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const windowsPackage = JSON.parse(await readFile(path.join(projectRoot, "apps/windows/package.json"), "utf8"));
const pwaPackage = JSON.parse(await readFile(path.join(projectRoot, "apps/pwa/package.json"), "utf8"));
const androidGradle = await readFile(path.join(projectRoot, "apps/android/app/build.gradle.kts"), "utf8");
const androidVersion = androidGradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1];
if (rootPackage.version !== windowsPackage.version || rootPackage.version !== pwaPackage.version || rootPackage.version !== androidVersion) {
  add("ERROR", "VERSION_MISMATCH", `root=${rootPackage.version}, windows=${windowsPackage.version}, pwa=${pwaPackage.version}, android=${androidVersion ?? "missing"}`);
}
const licenseReady = rootPackage.license === "GPL-3.0-only" && await exists(path.join(projectRoot, "LICENSE"));
if (!licenseReady) add(publicMode || sourceMode ? "ERROR" : "WARN", "LICENSE_DECISION_REQUIRED", "GPL-3.0-only LICENSE and package metadata");

await validateCycloneDx("WINDOWS_SBOM", path.join(projectRoot, "output/release-metadata/windows-sbom.cdx.json"));
await validateCycloneDx("ANDROID_SBOM", path.join(projectRoot, "output/release-metadata/android-sbom.cdx.json"));

await scanTrackedFilesForSecrets();

if (publicMode) {
  add("ERROR", "WINDOWS_CODE_SIGNING_REQUIRED", "Windows release signing");
  add("ERROR", "ANDROID_RELEASE_SIGNING_REQUIRED", "Android release signing");
  add("ERROR", "MACOS_DEVELOPER_ID_AND_NOTARIZATION_REQUIRED", "macOS Developer ID signing and notarization");
  if (!await hasFinalAppIcons()) add("ERROR", "FINAL_APP_ICON_REQUIRED", "Approved Windows and Android icon assets");
}

const outputDir = path.join(projectRoot, "output", "release-metadata");
await mkdir(outputDir, { recursive: true });
const report = {
  schemaVersion: 1,
  mode: publicMode ? "public-binary" : sourceMode ? "public-source" : "private-alpha",
  generatedAt: new Date().toISOString(),
  status: findings.some((finding) => finding.level === "ERROR") ? "NOT_READY" : "READY",
  findings
};
await writeFile(path.join(outputDir, "release-readiness.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

for (const finding of findings) console.log(`${finding.level} ${finding.code}: ${finding.detail}`);
console.log(`RELEASE_GATE_MODE=${report.mode}`);
console.log(`RELEASE_GATE_STATUS=${report.status}`);
if (report.status !== "READY") process.exitCode = 1;

function add(level, code, detail) {
  findings.push({ level, code, detail });
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function hasFinalAppIcons() {
  const required = [
    "apps/windows/assets/mathnotes.ico",
    "apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml",
    "apps/android/app/src/main/res/drawable/ic_launcher_monochrome.xml",
    "apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
    "apps/android/app/src/main/res/mipmap-anydpi-v33/ic_launcher.xml",
    "apps/android/marketing/play-icon-512.png",
    "docs/app-icon-spec.md"
  ];
  if (!(await Promise.all(required.map((relativePath) => exists(path.join(projectRoot, relativePath))))).every(Boolean)) return false;
  const spec = await readFile(path.join(projectRoot, "docs/app-icon-spec.md"), "utf8");
  return spec.includes("正式图标方向已于 2026-07-15 由用户确认");
}

async function scanTrackedFilesForSecrets() {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true
  });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  const dangerousNames = /(^|\/)(\.env($|\.)|[^/]+\.(jks|keystore|p12|pfx|pem|key))$/i;
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/
  ];
  for (const relativePath of listed.stdout.split("\0").filter(Boolean)) {
    const normalized = relativePath.replaceAll("\\", "/");
    const absolutePath = path.join(projectRoot, relativePath);
    // `git ls-files --cached` also reports tracked files deleted in the current
    // worktree. They are not part of the release candidate and cannot contain
    // a current secret, so omit them from the filesystem scan.
    if (!await exists(absolutePath)) continue;
    if (dangerousNames.test(normalized)) {
      add("ERROR", "TRACKED_SECRET_FILE", normalized);
      continue;
    }
    if (/\.(png|jpe?g|gif|webp|ico|zip|apk|aab|pdf|woff2?|ttf|jar|class)$/i.test(normalized)) continue;
    const metadata = await stat(absolutePath);
    if (metadata.size > 4 * 1024 * 1024) continue;
    const contents = (await readFile(absolutePath, "utf8"))
      .replaceAll("sk-test-secret-1234567890", "ALLOWLISTED_TEST_SECRET");
    if (secretPatterns.some((pattern) => pattern.test(contents))) add("ERROR", "POSSIBLE_COMMITTED_SECRET", normalized);
  }
}

async function validateCycloneDx(label, target) {
  try {
    const document = JSON.parse(await readFile(target, "utf8"));
    if (document.bomFormat !== "CycloneDX" || !Array.isArray(document.components)) {
      add("ERROR", `${label}_INVALID`, path.relative(projectRoot, target));
    }
  } catch (error) {
    add("ERROR", `${label}_MISSING`, error?.code === "ENOENT" ? path.relative(projectRoot, target) : String(error));
  }
}
