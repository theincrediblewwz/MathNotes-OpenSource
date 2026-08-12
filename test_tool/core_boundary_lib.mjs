import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

export async function scanCoreBoundaries({ projectRoot, roots }) {
  const files = [];
  for (const root of roots) {
    const absoluteRoot = path.resolve(projectRoot, root);
    for (const absolutePath of await walkSourceFiles(absoluteRoot)) {
      if (isTestOrFixture(absolutePath)) continue;
      const source = await readFile(absolutePath, "utf8");
      const imports = extractImports(source);
      files.push({
        path: toPosix(path.relative(projectRoot, absolutePath)),
        imports,
        electronImports: imports.filter(isElectronImport),
        nodeImports: imports.filter((specifier) => specifier.startsWith("node:")),
        platformSignals: collectPlatformSignals(source)
      });
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const violations = files.flatMap((file) => [
    ...file.electronImports.map((specifier) => ({ file: file.path, kind: "electron-import", detail: specifier })),
    ...file.platformSignals
      .filter((signal) => signal.kind === "electron-global")
      .map((signal) => ({ file: file.path, kind: signal.kind, detail: signal.detail }))
  ]);

  return {
    schemaVersion: 1,
    roots: roots.map(toPosix),
    fileCount: files.length,
    electronImportCount: files.reduce((total, file) => total + file.electronImports.length, 0),
    nodeImportCount: files.reduce((total, file) => total + file.nodeImports.length, 0),
    violations,
    files
  };
}

export function extractImports(source) {
  const imports = [];
  for (const match of source.matchAll(importPattern)) {
    imports.push(match[1] ?? match[2] ?? match[3]);
  }
  return [...new Set(imports)].sort();
}

function collectPlatformSignals(source) {
  const signals = [];
  const electronGlobals = ["BrowserWindow", "ipcMain", "ipcRenderer", "contextBridge"];
  for (const symbol of electronGlobals) {
    if (new RegExp(`\\b${symbol}\\b`).test(source)) {
      signals.push({ kind: "electron-global", detail: symbol });
    }
  }
  if (/\bprocess\.platform\b/.test(source)) signals.push({ kind: "os-branch", detail: "process.platform" });
  return signals;
}

function isElectronImport(specifier) {
  return specifier === "electron" || specifier.startsWith("electron/");
}

function isTestOrFixture(filePath) {
  const normalized = toPosix(filePath);
  return /\.(?:test|spec)\.[^/]+$/.test(normalized) || normalized.includes("/testHelpers/");
}

async function walkSourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkSourceFiles(absolutePath));
    else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) files.push(absolutePath);
  }
  return files;
}

function toPosix(value) {
  return value.replaceAll("\\", "/");
}
