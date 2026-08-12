import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMacosBridge } from "./macos_bridge_readiness_lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const report = await inspectMacosBridge(projectRoot);
const reportPath = path.join(projectRoot, "output", "macos-electron-bridge", "readiness.json");
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`MACOS_BRIDGE_READY=${report.ready}`);
console.log(`MACOS_BRIDGE_REPORT=${reportPath}`);
for (const warning of report.warnings) console.log(`MACOS_BRIDGE_WARNING=${warning}`);
if (!report.ready) {
  for (const blocker of report.blockers) console.error(`MACOS_BRIDGE_BLOCKER=${blocker}`);
  process.exitCode = 1;
}
