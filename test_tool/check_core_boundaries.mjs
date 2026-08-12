import path from "node:path";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scanCoreBoundaries } from "./core_boundary_lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
const targetRoots = roots.length > 0 ? roots : existingCoreRoots();
const report = await scanCoreBoundaries({ projectRoot, roots: targetRoots });

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(
    `CORE_BOUNDARY_${report.violations.length === 0 ? "OK" : "FAILED"} `
      + `roots=${report.roots.join(",")} files=${report.fileCount} `
      + `electron=${report.electronImportCount} node=${report.nodeImportCount}`
  );
  for (const violation of report.violations) {
    console.error(`${violation.file}: ${violation.kind}: ${violation.detail}`);
  }
}

if (report.violations.length > 0) process.exitCode = 1;

function existingCoreRoots() {
  // The package root becomes authoritative as services move out of the Windows app.
  return ["packages/core-server/src", "apps/windows/src/core"].filter((root) => {
    try {
      return requireStat(path.join(projectRoot, root));
    } catch {
      return false;
    }
  });
}

function requireStat(candidate) {
  // Deliberately synchronous only during this tiny command-line bootstrap.
  return statSync(candidate).isDirectory();
}
