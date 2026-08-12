import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageRoot = path.join(projectRoot, "output", "pwa-companion", "stage");
const manifest = JSON.parse(await readFile(path.join(stageRoot, "artifact-manifest.json"), "utf8"));

assert(manifest.product === "MathNotes PWA Read-only Companion", "PWA package product mismatch");
assert(manifest.deploymentRoot === "site", "PWA package deployment root mismatch");
const paths = new Set(manifest.files.map((file) => file.path));
assert(
  !manifest.files.some((file) => file.path.endsWith(".map")),
  "PWA production package must not publish source maps"
);
assert(
  manifest.files.filter((file) => file.path.startsWith("site/")).reduce((sum, file) => sum + file.bytes, 0) < 1_000_000,
  "PWA production site exceeded the 1 MB footprint budget"
);
for (const required of [
  "README.md",
  "site/index.html",
  "site/manifest.webmanifest",
  "site/sw.js",
  "site/icons/mathnotes-192.png",
  "site/icons/mathnotes-512.png"
]) {
  assert(paths.has(required), `PWA package is missing ${required}`);
}

for (const file of manifest.files) {
  const absolutePath = path.join(stageRoot, file.path);
  const content = await readFile(absolutePath);
  assert((await stat(absolutePath)).size === file.bytes, `PWA package byte length mismatch: ${file.path}`);
  assert(createHash("sha256").update(content).digest("hex") === file.sha256, `PWA package hash mismatch: ${file.path}`);
}

const serviceWorker = await readFile(path.join(stageRoot, "site", "sw.js"), "utf8");
assert(!serviceWorker.includes("/api/"), "PWA package Service Worker contains an API route");
const applicationJavaScript = (
  await Promise.all(
    manifest.files
      .filter((file) => /^site\/assets\/.*\.js$/.test(file.path))
      .map((file) => readFile(path.join(stageRoot, file.path), "utf8"))
  )
).join("\n");
assert(applicationJavaScript.includes("2026.07.29.13"), "PWA package build marker is stale");
assert(applicationJavaScript.includes(".katex-html"), "PWA package is missing KaTeX HTML styles");
assert(
  (applicationJavaScript.match(/data:font\/woff2/g) ?? []).length >= 20,
  "PWA package does not embed the complete KaTeX WOFF2 font set"
);

console.log(`PWA_COMPANION_PACKAGE_OK files=${manifest.files.length} stage=${stageRoot}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
