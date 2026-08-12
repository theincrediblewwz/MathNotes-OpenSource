import { readFile } from "node:fs/promises";
import path from "node:path";

const electronImportPattern = /(?:from\s+["']electron["']|require\(["']electron["']\))/;

export async function inspectMacosBridge(projectRoot) {
  const rootPackage = await readJson(path.join(projectRoot, "package.json"));
  const desktopPackage = await readJson(path.join(projectRoot, "apps", "windows", "package.json"));
  const mainSource = await readFile(path.join(projectRoot, "apps", "windows", "electron", "main.ts"), "utf8");
  const coreEnvironmentSource = await readFile(
    path.join(projectRoot, "apps", "windows", "electron", "coreEnvironment.ts"),
    "utf8"
  );
  const coreSourceFiles = await listTypeScriptFiles(path.join(projectRoot, "packages", "core-server", "src"));
  const electronCoreImports = [];
  for (const filePath of coreSourceFiles) {
    const source = await readFile(filePath, "utf8");
    if (electronImportPattern.test(source)) {
      electronCoreImports.push(path.relative(projectRoot, filePath).replaceAll("\\", "/"));
    }
  }

  const blockers = [];
  if (electronCoreImports.length) blockers.push(`Shared Core imports Electron: ${electronCoreImports.join(", ")}`);
  if (!mainSource.includes("createDesktopCoreEnvironment")) {
    blockers.push("Electron main does not create a host-aware desktop Core environment");
  }
  if (!coreEnvironmentSource.includes('platform === "darwin"')) {
    blockers.push("Desktop Core adapter does not map darwin to macos");
  }
  if (!rootPackage.scripts?.["package:macos:bridge"]) {
    blockers.push("Root package.json is missing package:macos:bridge");
  }
  if (desktopPackage.dependencies?.["@napi-rs/canvas"]) {
    blockers.push("Desktop runtime unexpectedly includes the experiment-only native canvas dependency");
  }

  return {
    schemaVersion: 1,
    target: { platform: "darwin", arch: "arm64", signed: false },
    ready: blockers.length === 0,
    blockers,
    warnings: [
      "The Phase 0 bridge still reuses apps/windows as a temporary Electron shell; Phase 1 product code belongs in apps/macos.",
      "The stored Codex runtime label uses windows to mean native process execution; WSL remains Windows-only and is not a Mac acceptance Provider.",
      "Actual launch, file dialogs, LAN ingest, provider turns, signing and notarization remain unverified until run on macOS."
    ],
    evidence: {
      sharedCoreTypeScriptFiles: coreSourceFiles.length,
      sharedCoreElectronImports: electronCoreImports,
      desktopRuntimeDependencies: Object.keys(desktopPackage.dependencies ?? {}).sort()
    }
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function listTypeScriptFiles(rootDir) {
  const { readdir } = await import("node:fs/promises");
  const files = [];
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(entryPath);
  }
  return files;
}
