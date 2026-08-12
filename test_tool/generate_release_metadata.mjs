import { createHash } from "node:crypto";
import { copyFile, readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(projectRoot, "output", "release-metadata");
const rootPackage = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const windowsPackage = JSON.parse(await readFile(path.join(projectRoot, "apps", "windows", "package.json"), "utf8"));
const pwaPackage = JSON.parse(await readFile(path.join(projectRoot, "apps", "pwa", "package.json"), "utf8"));
const androidGradle = await readFile(path.join(projectRoot, "apps", "android", "app", "build.gradle.kts"), "utf8");
const androidVersionName = requiredMatch(androidGradle, /versionName\s*=\s*"([^"]+)"/, "Android versionName");
const androidVersionCode = Number(requiredMatch(androidGradle, /versionCode\s*=\s*(\d+)/, "Android versionCode"));
const windowsOnly = process.argv.includes("--windows-only");
const finalIconReady = await hasFinalAppIcons();

await mkdir(outputDir, { recursive: true });

const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmArguments = process.platform === "win32"
  ? ["/d", "/s", "/c", "npm sbom --sbom-format cyclonedx --package-lock-only"]
  : ["sbom", "--sbom-format", "cyclonedx", "--package-lock-only"];
const npmSbom = spawnSync(npmCommand, npmArguments, {
  cwd: projectRoot,
  encoding: "utf8",
  windowsHide: true,
  maxBuffer: 32 * 1024 * 1024
});
if (npmSbom.status !== 0) {
  throw new Error(`npm SBOM generation failed: ${npmSbom.error?.message || npmSbom.stderr || npmSbom.stdout || `exit ${npmSbom.status}`}`);
}
const windowsSbomPath = path.join(outputDir, "windows-sbom.cdx.json");
await writeFile(windowsSbomPath, `${npmSbom.stdout.trim()}\n`, "utf8");

const sbom = JSON.parse(npmSbom.stdout);
const thirdParty = (sbom.components ?? []).map((component) => ({
  name: component.name,
  version: component.version,
  licenses: (component.licenses ?? []).map((entry) => entry.license?.id ?? entry.license?.name ?? "UNKNOWN")
}));
await writeFile(
  path.join(outputDir, "third-party-licenses.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), components: thirdParty }, null, 2)}\n`,
  "utf8"
);

const androidSbom = windowsOnly
  ? await existingAndroidSbomStatus()
  : await generateAndroidSbom();

const gitCommit = runGit(["rev-parse", "HEAD"]);
const gitDirty = runGit(["status", "--porcelain"]).length > 0;
const artifacts = await collectArtifacts([
  path.join(projectRoot, "output", "releases"),
  path.join(projectRoot, "apps", "android", "app", "build", "outputs", "apk"),
  path.join(projectRoot, "apps", "android", "app", "build", "outputs", "bundle")
]);
const generatedAt = new Date().toISOString();
const manifest = {
  schemaVersion: 1,
  product: "MathNotes",
  releaseChannel: "public-source-alpha",
  generatedAt,
  git: { commit: gitCommit, dirty: gitDirty },
  versions: {
    root: rootPackage.version,
    windows: windowsPackage.version,
    macos: rootPackage.version,
    pwa: pwaPackage.version,
    android: { versionName: androidVersionName, versionCode: androidVersionCode }
  },
  sbom: {
    windows: { status: "READY", format: "CycloneDX", path: "windows-sbom.cdx.json" },
    android: androidSbom
  },
  artifacts,
  publicReleaseBlockers: [
    "LICENSE_DECISION_REQUIRED",
    "WINDOWS_CODE_SIGNING_REQUIRED",
    "ANDROID_RELEASE_SIGNING_REQUIRED",
    "MACOS_DEVELOPER_ID_AND_NOTARIZATION_REQUIRED",
    ...(androidSbom.status === "READY" ? [] : ["ANDROID_SBOM_REQUIRED"]),
    ...(finalIconReady ? [] : ["FINAL_APP_ICON_REQUIRED"])
  ]
};
await writeFile(path.join(outputDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`RELEASE_METADATA=${outputDir}`);
console.log(`WINDOWS_SBOM_COMPONENTS=${thirdParty.length}`);
console.log(`ANDROID_SBOM_STATUS=${androidSbom.status}`);
console.log(`RELEASE_ARTIFACTS=${artifacts.length}`);
console.log("PUBLIC_RELEASE_STATUS=NOT_READY");

function requiredMatch(source, pattern, label) {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`Unable to read ${label}`);
  return match[1];
}

async function hasFinalAppIcons() {
  const required = [
    "apps/windows/assets/mathnotes.ico",
    "apps/android/app/src/main/res/drawable/ic_launcher_foreground.xml",
    "apps/android/app/src/main/res/drawable/ic_launcher_monochrome.xml",
    "apps/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
    "apps/android/app/src/main/res/mipmap-anydpi-v33/ic_launcher.xml",
    "apps/android/marketing/play-icon-512.png"
  ];
  for (const relativePath of required) {
    try {
      await stat(path.join(projectRoot, relativePath));
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

function runGit(args) {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function generateAndroidSbom() {
  const wrapper = path.join(projectRoot, "apps", "android", "gradlew.bat");
  const initScript = path.join(projectRoot, "test_tool", "cyclonedx.init.gradle.kts");
  const output = path.join(projectRoot, "apps", "android", "build", "reports", "cyclonedx", "bom.json");
  const invocation = `"${wrapper}" -p "${path.join(projectRoot, "apps", "android")}" cyclonedxBom --init-script "${initScript}" --no-daemon`;
  const result = spawnSync(invocation, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: true,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    return {
      status: "NOT_READY",
      reason: firstDiagnostic(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`)
    };
  }
  try {
    const document = JSON.parse(await readFile(output, "utf8"));
    if (document.bomFormat !== "CycloneDX") throw new Error("Generated document is not CycloneDX");
    await copyFile(output, path.join(outputDir, "android-sbom.cdx.json"));
    return { status: "READY", format: "CycloneDX", path: "android-sbom.cdx.json" };
  } catch (error) {
    return { status: "NOT_READY", reason: firstDiagnostic(error instanceof Error ? error.message : String(error)) };
  }
}

async function existingAndroidSbomStatus() {
  const target = path.join(outputDir, "android-sbom.cdx.json");
  try {
    const document = JSON.parse(await readFile(target, "utf8"));
    return document.bomFormat === "CycloneDX"
      ? { status: "READY", format: "CycloneDX", path: "android-sbom.cdx.json" }
      : { status: "NOT_READY", reason: "Existing Android SBOM is invalid." };
  } catch {
    return { status: "NOT_READY", reason: "Run the full release:metadata command to generate Android SBOM." };
  }
}

function firstDiagnostic(value) {
  const lines = String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? "unknown error").slice(0, 400);
}

async function collectArtifacts(roots) {
  const artifacts = [];
  for (const root of roots) {
    await visit(root, artifacts);
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

async function visit(target, artifacts) {
  let metadata;
  try {
    metadata = await stat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isDirectory()) {
    for (const entry of await readdir(target)) await visit(path.join(target, entry), artifacts);
    return;
  }
  if (!/\.(zip|apk|aab)$/i.test(target)) return;
  const contents = await readFile(target);
  artifacts.push({
    path: path.relative(projectRoot, target).replaceAll("\\", "/"),
    size: metadata.size,
    sha256: createHash("sha256").update(contents).digest("hex")
  });
}
