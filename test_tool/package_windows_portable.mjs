import { createHash } from "node:crypto";
import { access, copyFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { createPackage, listPackage } from "@electron/asar";
import { assertWindowsExecutableBrand, brandWindowsExecutable } from "./windows_executable_brand.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windowsRoot = path.join(projectRoot, "apps", "windows");
const pwaRoot = path.join(projectRoot, "apps", "pwa", "dist");
const outputRoot = path.join(projectRoot, "output", "windows-portable");
const stageRoot = path.join(outputRoot, "stage");
const bundleRoot = path.join(outputRoot, "bundle");
const releaseRoot = path.join(projectRoot, "output", "releases");
const windowsPackage = JSON.parse(await readFile(path.join(windowsRoot, "package.json"), "utf8"));
const electronPackage = JSON.parse(await readFile(path.join(projectRoot, "node_modules", "electron", "package.json"), "utf8"));
const version = windowsPackage.version;
const archiveTag = (process.env.MATHNOTES_ARCHIVE_TAG ?? "")
  .trim()
  .replace(/[^a-zA-Z0-9._-]+/g, "-");
const archiveName = `MathNotes-Windows-x64-${version}${archiveTag ? `-${archiveTag}` : ""}.zip`;
const archivePath = path.join(releaseRoot, archiveName);
const metadataScript = path.join(projectRoot, "test_tool", "generate_release_metadata.mjs");

const metadataBeforePackage = spawnSync(process.execPath, [metadataScript, "--windows-only"], {
  cwd: projectRoot,
  encoding: "utf8",
  windowsHide: true
});
if (metadataBeforePackage.status !== 0) {
  throw new Error(`Unable to generate release metadata: ${metadataBeforePackage.stderr || metadataBeforePackage.stdout}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(stageRoot, { recursive: true });
await mkdir(releaseRoot, { recursive: true });
await rm(archivePath, { force: true });
await rm(`${archivePath}.sha256`, { force: true });

await cp(path.join(windowsRoot, "dist"), path.join(stageRoot, "dist"), { recursive: true });
await cp(path.join(windowsRoot, "electron-dist"), path.join(stageRoot, "electron-dist"), { recursive: true });
await cp(path.join(windowsRoot, "assets"), path.join(stageRoot, "assets"), { recursive: true });
const stagedPdfJsRoot = path.join(stageRoot, "node_modules", "pdfjs-dist");
const sourcePdfJsRoot = path.join(projectRoot, "node_modules", "pdfjs-dist");
await mkdir(path.join(stagedPdfJsRoot, "legacy", "build"), { recursive: true });
await copyFile(path.join(sourcePdfJsRoot, "package.json"), path.join(stagedPdfJsRoot, "package.json"));
await copyFile(
  path.join(sourcePdfJsRoot, "legacy", "build", "pdf.mjs"),
  path.join(stagedPdfJsRoot, "legacy", "build", "pdf.mjs")
);
await copyFile(
  path.join(sourcePdfJsRoot, "legacy", "build", "pdf.worker.mjs"),
  path.join(stagedPdfJsRoot, "legacy", "build", "pdf.worker.mjs")
);
await writeFile(path.join(stageRoot, "package.json"), JSON.stringify({
  name: "mathnotes",
  productName: "MathNotes",
  version,
  main: "electron-dist/main.cjs",
  private: true,
  license: "GPL-3.0-only",
  dependencies: {
    "pdfjs-dist": windowsPackage.dependencies["pdfjs-dist"]
  }
}, null, 2));

let packagedPaths;
try {
  packagedPaths = await packager({
    dir: stageRoot,
    out: bundleRoot,
    name: "MathNotes",
    platform: "win32",
    arch: "x64",
    electronVersion: electronPackage.version,
    appVersion: version,
    icon: path.join(windowsRoot, "assets", "mathnotes.ico"),
    asar: true,
    overwrite: true,
    prune: false,
    win32metadata: {
      CompanyName: "MathNotes",
      FileDescription: "MathNotes private mathematics notebook",
      InternalName: "MathNotes",
      OriginalFilename: "MathNotes.exe",
      ProductName: "MathNotes"
    }
  });
} catch (error) {
  const localElectron = path.join(projectRoot, "node_modules", "electron", "dist");
  const localExecutable = path.join(localElectron, "electron.exe");
  await access(localExecutable);
  const fallbackRoot = path.join(bundleRoot, "MathNotes-win32-x64");
  await rm(fallbackRoot, { recursive: true, force: true });
  await cp(localElectron, fallbackRoot, { recursive: true });
  await rename(path.join(fallbackRoot, "electron.exe"), path.join(fallbackRoot, "MathNotes.exe"));
  await rm(path.join(fallbackRoot, "resources", "default_app.asar"), { force: true });
  await createPackage(stageRoot, path.join(fallbackRoot, "resources", "app.asar"));
  await brandWindowsExecutable(path.join(fallbackRoot, "MathNotes.exe"), {
    iconPath: path.join(windowsRoot, "assets", "mathnotes.ico"),
    version
  });
  packagedPaths = [fallbackRoot];
  console.warn(`PACKAGER_OFFLINE_RESOURCE_EDIT_FALLBACK=${error instanceof Error ? error.message : String(error)}`);
}

if (packagedPaths.length !== 1) throw new Error(`Expected one packaged app, received ${packagedPaths.length}`);
const packagedRoot = packagedPaths[0];
const packagedExecutable = path.join(packagedRoot, "MathNotes.exe");
const executableBrand = await assertWindowsExecutableBrand(packagedExecutable, {
  iconPath: path.join(windowsRoot, "assets", "mathnotes.ico"),
  version
});
console.log(`WINDOWS_EXE_BRAND_OK product=${executableBrand.productName} version=${executableBrand.version} icons=${executableBrand.iconCount} sha256=${executableBrand.executableSha256}`);
const packagedLocalesRoot = path.join(packagedRoot, "locales");
const retainedLocales = new Set(["en-US.pak", "zh-CN.pak"]);
for (const localeFile of await readdir(packagedLocalesRoot)) {
  if (!retainedLocales.has(localeFile)) {
    await rm(path.join(packagedLocalesRoot, localeFile), { force: true });
  }
}
const packagedAsar = path.join(packagedRoot, "resources", "app.asar");
const packagedPwaRoot = path.join(packagedRoot, "resources", "MathNotesPWA");
const packagedFiles = await listPackage(packagedAsar);
if (!packagedFiles.some((entry) => entry.replaceAll("\\", "/").endsWith("/node_modules/pdfjs-dist/legacy/build/pdf.mjs"))) {
  throw new Error("Portable package is missing the pdfjs-dist runtime required by local and Android PDF import");
}
await access(path.join(pwaRoot, "index.html"));
await access(path.join(pwaRoot, "sw.js"));
await cp(pwaRoot, packagedPwaRoot, { recursive: true });
await access(path.join(packagedPwaRoot, "index.html"));
await access(path.join(packagedPwaRoot, "sw.js"));
await writeFile(path.join(packagedRoot, "首次运行说明.txt"), [
  "MathNotes Windows 便携版",
  "",
  "1. 解压整个目录后运行 MathNotes.exe，不要只复制 exe。",
  "2. Windows 可能提示发布者未知；本项目当前不提供付费代码签名，请仅从官方仓库下载并自行核对 SHA-256。",
  "3. 软件默认把笔记保存在本机。首次使用前请在设置中确认笔记目录，并定期备份。",
  "4. 如需在 WSL 中调用 Codex，请先在自己的 WSL 发行版中安装并登录 Codex；默认命令为 codex。",
  "5. 许可证、构建方法和已知限制请阅读同目录 README.md 与 SECURITY.md。",
  ""
].join("\r\n"), "utf8");
await copyFile(path.join(projectRoot, "README.md"), path.join(packagedRoot, "README.md"));
await copyFile(path.join(projectRoot, "SECURITY.md"), path.join(packagedRoot, "SECURITY.md"));
await copyFile(path.join(projectRoot, "output", "release-metadata", "windows-sbom.cdx.json"), path.join(packagedRoot, "windows-sbom.cdx.json"));
await copyFile(path.join(projectRoot, "output", "release-metadata", "third-party-licenses.json"), path.join(packagedRoot, "third-party-licenses.json"));
await copyFile(path.join(projectRoot, "output", "release-metadata", "release-manifest.json"), path.join(packagedRoot, "release-manifest.json"));

const tar = spawnSync("tar.exe", ["-a", "-c", "-f", archivePath, "-C", path.dirname(packagedRoot), path.basename(packagedRoot)], {
  cwd: projectRoot,
  encoding: "utf8",
  windowsHide: true
});
if (tar.status !== 0) throw new Error(`Unable to create portable ZIP: ${tar.stderr || tar.stdout}`);

const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex");
await writeFile(`${archivePath}.sha256`, `${digest}  ${archiveName}\n`, "utf8");

const metadataAfterPackage = spawnSync(process.execPath, [metadataScript, "--windows-only"], {
  cwd: projectRoot,
  encoding: "utf8",
  windowsHide: true
});
if (metadataAfterPackage.status !== 0) {
  throw new Error(`Unable to refresh release metadata: ${metadataAfterPackage.stderr || metadataAfterPackage.stdout}`);
}

console.log(`WINDOWS_PORTABLE_DIR=${packagedRoot}`);
console.log(`WINDOWS_PORTABLE_ZIP=${archivePath}`);
console.log(`WINDOWS_PORTABLE_SHA256=${digest}`);
