import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMacosBridge } from "./macos_bridge_readiness_lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("macOS bridge has no static platform blockers", async () => {
  const report = await inspectMacosBridge(projectRoot);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.ready, true);
  assert.equal(report.target.platform, "darwin");
  assert.equal(report.target.arch, "arm64");
  assert.equal(report.evidence.sharedCoreElectronImports.length, 0);
  assert.ok(report.evidence.sharedCoreTypeScriptFiles > 0);
});
