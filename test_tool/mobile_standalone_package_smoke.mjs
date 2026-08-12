import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "output", "test-packages");
const short = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const outputRoot = path.join(packageRoot, `mobile-standalone-${short}`);
const ready = path.join(outputRoot, "ready");
const manifest = JSON.parse(await readFile(path.join(ready, "artifact-manifest.json"), "utf8"));
assert.equal(manifest.dirty, false);
assert.equal(manifest.signing.android, "development-debug-key");
assert.ok(manifest.footprint.pwaUnpackedBytes > 0);
assert.equal(manifest.hosting.sameOriginWorkerIncluded, true);
assert.equal(manifest.hosting.productionDeployed, false);
for (const entry of manifest.files) {
  const content = await readFile(path.join(ready, entry.path));
  assert.equal(createHash("sha256").update(content).digest("hex"), entry.sha256, entry.path);
}
assert.ok(manifest.files.some((entry) => entry.path.endsWith("development-signed.apk")));
assert.ok(manifest.files.some((entry) => entry.path.includes("PWA-Standalone") && entry.path.endsWith(".zip")));
assert.ok(manifest.files.some((entry) => entry.path.includes("PWA-Worker") && entry.path.endsWith("wrangler.jsonc")));
assert.ok(manifest.files.some((entry) => entry.path.includes("PWA-Worker") && entry.path.endsWith("src/index.js")));
console.log(`MOBILE_STANDALONE_PACKAGE_OK files=${manifest.files.length} ready=${ready}`);
