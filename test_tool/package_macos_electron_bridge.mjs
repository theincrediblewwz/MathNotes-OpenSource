import { createHash } from "node:crypto";
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { listPackage } from "@electron/asar";
import { inspectMacosBridge } from "./macos_bridge_readiness_lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(projectRoot, "apps", "windows");
const outputRoot = path.join(projectRoot, "output", "macos-electron-bridge");
const stageRoot = path.join(outputRoot, "stage");
const bundleRoot = path.join(outputRoot, "bundle");
const releaseRoot = path.join(projectRoot, "output", "releases");
const prepareOnly = process.argv.includes("--prepare-only");
const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const electronPackage = JSON.parse(await readFile(path.join(projectRoot, "node_modules", "electron", "package.json"), "utf8"));
const archiveName = `MathNotes-macOS-arm64-${desktopPackage.version}-unsigned.zip`;
const archivePath = path.join(releaseRoot, archiveName);

const readiness = await inspectMacosBridge(projectRoot);
if (!readiness.ready) throw new Error(`macOS bridge readiness failed: ${readiness.blockers.join("; ")}`);

await rm(stageRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
await cp(path.join(desktopRoot, "dist"), path.join(stageRoot, "dist"), { recursive: true });
await cp(path.join(desktopRoot, "electron-dist"), path.join(stageRoot, "electron-dist"), { recursive: true });
await cp(path.join(desktopRoot, "assets"), path.join(stageRoot, "assets"), { recursive: true });

const stagedPdfJsRoot = path.join(stageRoot, "node_modules", "pdfjs-dist");
const sourcePdfJsRoot = path.join(projectRoot, "node_modules", "pdfjs-dist");
await mkdir(path.join(stagedPdfJsRoot, "legacy", "build"), { recursive: true });
await copyFile(path.join(sourcePdfJsRoot, "package.json"), path.join(stagedPdfJsRoot, "package.json"));
await copyFile(path.join(sourcePdfJsRoot, "legacy", "build", "pdf.mjs"), path.join(stagedPdfJsRoot, "legacy", "build", "pdf.mjs"));
await copyFile(
  path.join(sourcePdfJsRoot, "legacy", "build", "pdf.worker.mjs"),
  path.join(stagedPdfJsRoot, "legacy", "build", "pdf.worker.mjs")
);
await writeFile(path.join(stageRoot, "package.json"), JSON.stringify({
  name: "mathnotes",
  productName: "MathNotes",
  version: desktopPackage.version,
  main: "electron-dist/main.cjs",
  private: true,
  license: "GPL-3.0-only",
  dependencies: { "pdfjs-dist": desktopPackage.dependencies["pdfjs-dist"] }
}, null, 2));
await writeFile(path.join(outputRoot, "target.json"), `${JSON.stringify({
  platform: "darwin",
  arch: "arm64",
  signed: false,
  hostPlatform: process.platform,
  preparedAt: new Date().toISOString()
}, null, 2)}\n`, "utf8");

if (prepareOnly) {
  console.log(`MACOS_BRIDGE_STAGE=${stageRoot}`);
  console.log("MACOS_BRIDGE_PACKAGE=NOT_BUILT_PREPARE_ONLY");
  process.exit(0);
}

if (process.platform !== "darwin") {
  throw new Error("MACOS_HOST_REQUIRED: run npm run package:macos:bridge on a real Mac. Windows may only run prepare:macos:bridge.");
}

await rm(bundleRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true });
await rm(archivePath, { force: true });
await rm(`${archivePath}.sha256`, { force: true });
const packagedPaths = await packager({
  dir: stageRoot,
  out: bundleRoot,
  name: "MathNotes",
  platform: "darwin",
  arch: "arm64",
  electronVersion: electronPackage.version,
  appVersion: desktopPackage.version,
  appBundleId: "com.mathnotes.desktop",
  appCategoryType: "public.app-category.productivity",
  asar: true,
  overwrite: true,
  prune: false
});
if (packagedPaths.length !== 1) throw new Error(`Expected one packaged app, received ${packagedPaths.length}`);

const packagedRoot = packagedPaths[0];
const appPath = path.join(packagedRoot, "MathNotes.app");
const packagedAsar = path.join(appPath, "Contents", "Resources", "app.asar");
await access(packagedAsar);
const packagedFiles = await listPackage(packagedAsar);
if (!packagedFiles.some((entry) => entry.replaceAll("\\", "/").endsWith("/node_modules/pdfjs-dist/legacy/build/pdf.mjs"))) {
  throw new Error("macOS bridge is missing the pdfjs-dist runtime");
}

const archive = spawnSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archivePath], {
  cwd: projectRoot,
  encoding: "utf8"
});
if (archive.status !== 0) throw new Error(`Unable to create macOS ZIP: ${archive.stderr || archive.stdout}`);
const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex");
await writeFile(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`, "utf8");

console.log(`MACOS_BRIDGE_APP=${appPath}`);
console.log(`MACOS_BRIDGE_ZIP=${archivePath}`);
console.log(`MACOS_BRIDGE_SHA256=${digest}`);
console.log("MACOS_BRIDGE_SIGNING=UNSIGNED_DEVELOPMENT_BRIDGE");
