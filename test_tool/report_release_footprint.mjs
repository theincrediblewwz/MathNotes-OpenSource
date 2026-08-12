import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(projectRoot, "output", "release-metadata", "release-footprint.json");
const roots = [
  { id: "pwa-dist", kind: "directory", target: "apps/pwa/dist", delivery: "static PWA payload" },
  { id: "windows-portable", kind: "directory", target: "output/windows-portable/bundle", delivery: "unpacked Electron portable app" },
  { id: "windows-zip", kind: "files", target: "output/releases", pattern: /^MathNotes-Windows-.*\.zip$/i, delivery: "Windows portable ZIP" },
  { id: "macos-zip", kind: "files", target: "output", pattern: /MathNotes-macOS-.*\.zip$/i, delivery: "macOS app ZIP (Apple build only)" },
  { id: "android-debug-apk", kind: "files", target: "apps/android/app/build/outputs/apk/debug", pattern: /\.apk$/i, delivery: "development APK; not a release-size claim" },
  { id: "android-release-apk", kind: "files", target: "apps/android/app/build/outputs/apk/release", pattern: /\.apk$/i, delivery: "universal release APK" },
  { id: "android-release-aab", kind: "files", target: "apps/android/app/build/outputs/bundle/release", pattern: /\.aab$/i, delivery: "recommended Android release artifact; store delivers device splits" }
];

const entries = [];
for (const descriptor of roots) {
  const absolute = path.join(projectRoot, descriptor.target);
  if (descriptor.kind === "directory") {
    const files = await listFiles(absolute);
    if (!files.length) {
      entries.push({ id: descriptor.id, status: "NOT_BUILT", delivery: descriptor.delivery });
      continue;
    }
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    entries.push({
      id: descriptor.id,
      status: "READY",
      delivery: descriptor.delivery,
      path: descriptor.target,
      bytes,
      mebibytes: toMiB(bytes),
      largestFiles: files.sort((left, right) => right.bytes - left.bytes).slice(0, 8)
    });
    continue;
  }

  const files = (await listFiles(absolute)).filter((file) => descriptor.pattern.test(path.basename(file.path)));
  entries.push(...(files.length
    ? files.map((file) => ({
        id: descriptor.id,
        status: "READY",
        delivery: descriptor.delivery,
        path: path.relative(projectRoot, path.join(absolute, file.path)).replaceAll("\\", "/"),
        bytes: file.bytes,
        mebibytes: toMiB(file.bytes)
      }))
    : [{ id: descriptor.id, status: "NOT_BUILT", delivery: descriptor.delivery }]));
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  git: {
    commit: git(["rev-parse", "HEAD"]),
    dirty: Boolean(git(["status", "--porcelain"]))
  },
  interpretation: [
    "Compare release artifacts, not development caches or installed dependency folders.",
    "Electron/Chromium and the macOS bundled Node sidecar are structural runtime costs in v1.",
    "The Android AAB is the release artifact; a store-generated per-device download is smaller than a universal APK but must be measured with bundletool or store delivery evidence.",
    "Offline Android QR scanning is retained; this report does not authorize removing its bundled model."
  ],
  entries
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`RELEASE_FOOTPRINT=${outputPath}`);
for (const entry of entries) {
  console.log(`${entry.id.toUpperCase().replaceAll("-", "_")}=${entry.status}${entry.mebibytes === undefined ? "" : ` ${entry.mebibytes} MiB`}`);
}

async function listFiles(root, current = "") {
  let directoryEntries;
  try {
    directoryEntries = await readdir(path.join(root, current), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of directoryEntries) {
    const relative = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relative));
    else if (entry.isFile()) files.push({ path: relative.replaceAll("\\", "/"), bytes: (await stat(path.join(root, relative))).size });
  }
  return files;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function toMiB(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}
