#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { macosBuildRevision } from "./macos_build_info.mjs";
import { probeSidecar } from "./diagnose_macos_connection.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(projectRoot, "output", "macos-native");
const appPath = path.join(outputRoot, "bundle", "MathNotes.app");
const contentsPath = path.join(appPath, "Contents");
const macosPath = path.join(contentsPath, "MacOS");
const resourcesPath = path.join(contentsPath, "Resources");
const runtimePath = path.join(resourcesPath, "MathNotesRuntime");
const pwaPath = path.join(resourcesPath, "MathNotesPWA");
const releaseRoot = path.join(projectRoot, "output", "releases");
const macosRelease = JSON.parse(await readFile(path.join(projectRoot, "deploy/releases/macos-release.json"), "utf8"));
const version = macosRelease.version;
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || macosRelease.tag !== `macos-v${version}`) {
  throw new Error("MACOS_RELEASE_VERSION_MISMATCH");
}
const buildRevision = macosBuildRevision(projectRoot);
const archiveName = `MathNotes-macOS-native-arm64-${version}-${buildRevision}-unsigned.zip`;
const archivePath = path.join(releaseRoot, archiveName);

if (process.platform !== "darwin") {
  throw new Error("MACOS_HOST_REQUIRED: package the native app on a real Mac.");
}

run(process.execPath, [path.join(projectRoot, "test_tool", "build_macos_sidecar.mjs")]);
run("npm", ["run", "build:pwa"]);
run("swift", [
  "build",
  "--package-path", path.join(projectRoot, "apps", "macos"),
  "--configuration", "release",
  "--product", "MathNotesMac"
]);
const binPath = run("swift", [
  "build",
  "--package-path", path.join(projectRoot, "apps", "macos"),
  "--configuration", "release",
  "--show-bin-path"
]).trim();

const sourceExecutable = path.join(binPath, "MathNotesMac");
const sourceSidecar = path.join(projectRoot, "output", "macos-sidecar", "core-server.mjs");
const sourcePwa = path.join(projectRoot, "apps", "pwa", "dist");
const sourceKatex = path.join(projectRoot, "apps", "macos", "Sources", "MathNotesMac", "Resources", "katex");
const sourceAuthorAvatar = path.join(projectRoot, "apps", "macos", "Sources", "MathNotesMac", "Resources", "wwz-sysu-avatar.jpg");
const targetExecutable = path.join(macosPath, "MathNotes");
const targetNode = path.join(runtimePath, "bin", "node");
const targetSidecar = path.join(runtimePath, "core-server.mjs");

await access(sourceExecutable);
await access(sourceSidecar);
await access(path.join(sourcePwa, "index.html"));
await access(path.join(sourceKatex, "katex.min.css"));
await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.dirname(targetNode), { recursive: true });
await mkdir(macosPath, { recursive: true });
await mkdir(releaseRoot, { recursive: true });
await copyFile(sourceExecutable, targetExecutable);
await copyFile(process.execPath, targetNode);
await copyFile(sourceSidecar, targetSidecar);
await cp(sourcePwa, pwaPath, { recursive: true });
await cp(sourceKatex, path.join(resourcesPath, "MathNotesKaTeX"), { recursive: true });
await copyFile(sourceAuthorAvatar, path.join(resourcesPath, "wwz-sysu-avatar.jpg"));
await chmod(targetExecutable, 0o755);
await chmod(targetNode, 0o755);

const executableBytesBeforeStrip = (await stat(targetExecutable)).size;
const nodeBytesBeforeStrip = (await stat(targetNode)).size;
run("strip", ["-x", targetExecutable]);
run("strip", ["-x", targetNode]);
// strip invalidates Node's upstream signature. Resources is not a nested-code
// location: signing the outer app with --deep can leave that stale signature
// untouched, even when --verify --deep succeeds. Sign this executable explicitly
// before running it, then seal the containing app below.
run("codesign", ["--force", "--sign", "-", "--identifier", "com.mathnotes.runtime.node", targetNode]);
run("codesign", ["--verify", "--strict", targetNode]);
const executableBytesAfterStrip = (await stat(targetExecutable)).size;
const nodeBytesAfterStrip = (await stat(targetNode)).size;
const packagedNodeVersion = run(targetNode, ["--version"]).trim();

const iconPath = await createIcon(resourcesPath);
await writeFile(path.join(contentsPath, "Info.plist"), infoPlist(version), "utf8");
await writeFile(path.join(contentsPath, "PkgInfo"), "APPL????", "ascii");
await access(iconPath);

run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
run("codesign", ["--verify", "--deep", "--strict", appPath]);
// Validate the sealed runtime by executing real startup, not just --version or
// static signature checks. The probe uses fresh data and never opens Keychain.
const runtimeProbe = await probeSidecar({
  executable: targetNode, script: targetSidecar, companion: true, pwaRoot: pwaPath
});
if (runtimeProbe.state !== "ready") {
  throw new Error(`MACOS_PACKAGED_RUNTIME_FAILED: ${JSON.stringify(runtimeProbe)}`);
}
console.log("MACOS_PACKAGED_RUNTIME_READY");
await rm(archivePath, { force: true });
await rm(`${archivePath}.sha256`, { force: true });
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archivePath]);

const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex");
await writeFile(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`, "utf8");

console.log(`MACOS_NATIVE_APP=${appPath}`);
console.log(`MACOS_NATIVE_ZIP=${archivePath}`);
console.log(`MACOS_NATIVE_SHA256=${digest}`);
console.log("MACOS_NATIVE_SIGNING=AD_HOC_SELF_USE");
console.log(`MACOS_NATIVE_EXECUTABLE_BYTES_BEFORE_STRIP=${executableBytesBeforeStrip}`);
console.log(`MACOS_NATIVE_EXECUTABLE_BYTES_AFTER_STRIP=${executableBytesAfterStrip}`);
console.log(`MACOS_NATIVE_NODE_BYTES_BEFORE_STRIP=${nodeBytesBeforeStrip}`);
console.log(`MACOS_NATIVE_NODE_BYTES_AFTER_STRIP=${nodeBytesAfterStrip}`);
console.log(`MACOS_NATIVE_PACKAGED_NODE_VERSION=${packagedNodeVersion}`);
console.log(`MACOS_NATIVE_BUILD_REVISION=${buildRevision}`);

async function createIcon(targetResourcesPath) {
  const source = path.join(projectRoot, "apps", "windows", "assets", "mathnotes.png");
  const iconset = path.join(outputRoot, "MathNotes.iconset");
  const target = path.join(targetResourcesPath, "MathNotes.icns");
  await mkdir(iconset, { recursive: true });
  await mkdir(targetResourcesPath, { recursive: true });
  const sizes = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"]
  ];
  for (const [size, name] of sizes) {
    run("sips", ["-z", String(size), String(size), source, "--out", path.join(iconset, name)]);
  }
  run("iconutil", ["-c", "icns", iconset, "-o", target]);
  return target;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed (exit=${result.status}, signal=${result.signal ?? "none"}): ${result.stderr || result.stdout || result.error?.message || "no output"}`);
  }
  return result.stdout;
}

function infoPlist(appVersion) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>MathNotes</string>
  <key>CFBundleExecutable</key><string>MathNotes</string>
  <key>CFBundleIconFile</key><string>MathNotes</string>
  <key>CFBundleIdentifier</key><string>com.mathnotes.native</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>MathNotes</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${appVersion}</string>
  <key>CFBundleVersion</key><string>${appVersion}</string>
  <key>MathNotesBuildRevision</key><string>${buildRevision}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <!-- macOS 14+ requires explicit IP exceptions, including Tailscale CGNAT.
         Keep public HTTP and arbitrary web content subject to ATS. -->
    <key>NSExceptionDomains</key>
    <dict>
      <key>127.0.0.1</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
      <key>::1</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
      <key>10.0.0.0/8</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
      <key>172.16.0.0/12</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
      <key>192.168.0.0/16</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
      <key>169.254.0.0/16</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
      <key>100.64.0.0/10</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
      <key>fc00::/7</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
      <key>fe80::/10</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
    </dict>
  </dict>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSLocalNetworkUsageDescription</key><string>连接同一私有网络中的 MathNotes 服务，用于检查设备连接与同步笔记。</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
`;
}
