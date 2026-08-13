import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const icoPath = path.join(projectRoot, "apps", "windows", "assets", "mathnotes.ico");
const windowsMainPath = path.join(projectRoot, "apps", "windows", "electron", "main.ts");
const windowsPackagerPath = path.join(projectRoot, "test_tool", "package_windows_portable.mjs");
const ico = await readFile(icoPath);
const windowsMain = await readFile(windowsMainPath, "utf8");
const windowsPackager = await readFile(windowsPackagerPath, "utf8");
if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error("Invalid ICO header");
const count = ico.readUInt16LE(4);
if (count !== 7) throw new Error(`Expected 7 ICO images, got ${count}`);
const sizes = [];
for (let index = 0; index < count; index += 1) {
  const offset = 6 + index * 16;
  sizes.push(ico.readUInt8(offset) || 256);
}
const expected = [16, 24, 32, 48, 64, 128, 256];
if (sizes.join(",") !== expected.join(",")) throw new Error(`Unexpected ICO sizes: ${sizes.join(",")}`);
if (!windowsMain.includes('app.setAppUserModelId("com.mathnotes.windows")')) {
  throw new Error("Windows AppUserModelID is missing");
}
if (!windowsMain.includes('../assets/mathnotes.ico')) {
  throw new Error("BrowserWindow does not use the MathNotes icon");
}
if (!windowsPackager.includes('assets", "mathnotes.ico"')) {
  throw new Error("Windows packager does not embed the MathNotes icon");
}
if (!windowsPackager.includes("assertWindowsExecutableBrand")) {
  throw new Error("Windows packager does not verify the final executable resources");
}
if (windowsPackager.includes("PACKAGER_OFFLINE_FALLBACK=")) {
  throw new Error("Windows packager still contains the unbranded offline fallback");
}

const playIcon = await readFile(path.join(projectRoot, "apps", "android", "marketing", "play-icon-512.png"));
if (playIcon.toString("ascii", 1, 4) !== "PNG") throw new Error("Play icon is not a PNG");
if (playIcon.readUInt32BE(16) !== 512 || playIcon.readUInt32BE(20) !== 512) throw new Error("Play icon must be 512x512");
if (playIcon.length > 1024 * 1024) throw new Error("Play icon exceeds the 1 MB store limit");

const manifest = await readFile(path.join(projectRoot, "apps", "android", "app", "src", "main", "AndroidManifest.xml"), "utf8");
for (const required of ['android:icon="@mipmap/ic_launcher"', 'android:roundIcon="@mipmap/ic_launcher_round"']) {
  if (!manifest.includes(required)) throw new Error(`Android manifest is missing ${required}`);
}
const adaptiveV26 = await readFile(path.join(projectRoot, "apps", "android", "app", "src", "main", "res", "mipmap-anydpi-v26", "ic_launcher.xml"), "utf8");
for (const layer of ["background", "foreground"]) {
  if (!adaptiveV26.includes(`<${layer}`)) throw new Error(`Adaptive icon is missing ${layer}`);
}
const adaptiveV33 = await readFile(path.join(projectRoot, "apps", "android", "app", "src", "main", "res", "mipmap-anydpi-v33", "ic_launcher.xml"), "utf8");
if (!adaptiveV33.includes("<monochrome")) throw new Error("Themed icon is missing monochrome layer");
const foregroundVector = await readFile(path.join(projectRoot, "apps", "android", "app", "src", "main", "res", "drawable", "ic_launcher_foreground.xml"), "utf8");
const monochromeVector = await readFile(path.join(projectRoot, "apps", "android", "app", "src", "main", "res", "drawable", "ic_launcher_monochrome.xml"), "utf8");
for (const vector of [foregroundVector, monochromeVector]) {
  for (const required of ['strokeWidth="13"', 'strokeWidth="10"', 'strokeWidth="9"', 'strokeWidth="14"', 'M244,148 C221,138']) {
    if (!vector.includes(required)) throw new Error(`Android vector does not match the approved optical master: ${required}`);
  }
}
const preview = await stat(path.join(projectRoot, "docs", "assets", "brand", "mathnotes-icon-system.png"));
if (preview.size < 10_000) throw new Error("Brand preview was not rendered correctly");

console.log(`BRAND_ASSETS_OK ico_sizes=${sizes.join(",")} play_bytes=${playIcon.length} preview_bytes=${preview.size}`);
