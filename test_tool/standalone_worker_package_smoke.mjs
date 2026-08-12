import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(root, "output", "test-packages");
const short = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const outputRoot = path.join(packageRoot, `standalone-worker-${short}`);
const ready = path.join(outputRoot, "ready");
const manifest = JSON.parse(await readFile(path.join(ready, "artifact-manifest.json"), "utf8"));
assert.equal(manifest.product, "MathNotes Standalone Worker");
assert.ok(manifest.footprint.pwaFiles > 0);
assert.ok(manifest.footprint.pwaUnpackedBytes > 0);

for (const entry of manifest.files) {
  const content = await readFile(path.join(ready, entry.path));
  assert.equal(createHash("sha256").update(content).digest("hex"), entry.sha256, entry.path);
}

const requiredFiles = [
  "src/index.js",
  "wrangler.jsonc",
  "package.json",
  "README.md",
  "部署说明.md",
  "网关接口合同.md",
  "pwa-site/index.html",
  "pwa-site/manifest.webmanifest",
  "pwa-site/sw.js",
  "pwa-site/_headers"
];
for (const required of requiredFiles) {
  assert.ok(manifest.files.some((entry) => entry.path === required), `missing ${required}`);
}

const config = await readFile(path.join(ready, "wrangler.jsonc"), "utf8");
assert.match(config, /"main"\s*:\s*"\.\/src\/index\.js"/);
assert.match(config, /"binding"\s*:\s*"ASSETS"/);
assert.match(config, /"run_worker_first"\s*:\s*true/);
assert.match(config, /"directory"\s*:\s*"\.\/pwa-site"/);

const workerSource = await readFile(path.join(ready, "src", "index.js"), "utf8");
assert.ok(!/^\s*import\s/m.test(workerSource), "worker must not import runtime modules");
assert.ok(!workerSource.includes("node:"), "worker must not depend on Node builtins");

const secretPatterns = [
  /sk-[A-Za-z0-9]{16,}/i,
  /(?:MATHNOTES_GATEWAY_TOKEN|MATHNOTES_PROVIDER_API_KEY)\s*[:=]\s*["'][A-Za-z0-9._\-]{8,}["']/,
  /Bearer [A-Za-z0-9_-]{16,}/
];
for (const entry of manifest.files.filter((file) => /\.(?:md|jsonc?|js|txt)$/i.test(file.path))) {
  const content = await readFile(path.join(ready, entry.path), "utf8");
  for (const pattern of secretPatterns) {
    assert.ok(!pattern.test(content), `secret-shaped literal in ${entry.path}`);
  }
}
await assert.rejects(access(path.join(ready, ".dev.vars")), /ENOENT/);

const stagedWorker = await import(pathToFileURL(path.join(ready, "src", "index.js")).href);
const handler = stagedWorker.createStandaloneGatewayHandler({
  randomUUID: () => "smoke-task-1",
  fetchImpl: async () => new Response(JSON.stringify({
    choices: [{ message: { content: "## 冒烟草稿" } }]
  }), { status: 200 })
});
const env = {
  ASSETS: { fetch: (request) => serveStagedAsset(request, ready) },
  MATHNOTES_GATEWAY_TOKEN: "smoke-token",
  MATHNOTES_PROVIDER_BASE_URL: "https://provider.test/v1",
  MATHNOTES_PROVIDER_MODEL: "smoke-model",
  MATHNOTES_PROVIDER_API_KEY: "smoke-key"
};
const origin = "http://127.0.0.1:8787";
const imageDataUrl = "data:image/jpeg;base64," + Buffer.from("smoke-image").toString("base64");
const recognitionBody = JSON.stringify({
  version: 1,
  sessionId: "smoke-session",
  fileName: "smoke.jpg",
  mimeType: "image/jpeg",
  imageDataUrl
});

const rootResponse = await handler(new Request(`${origin}/`), env);
assert.equal(rootResponse.status, 200);
assert.match(await rootResponse.text(), /<div id="root">/);

const capabilities = await handler(new Request(`${origin}/v1/capabilities`), env);
assert.equal(capabilities.status, 200);
assert.equal((await capabilities.json()).gateway, "mathnotes-standalone-v1");

const success = await handler(new Request(`${origin}/v1/recognitions`, {
  method: "POST",
  headers: {
    Origin: origin,
    Authorization: "Bearer smoke-token",
    "Content-Type": "application/json",
    "Idempotency-Key": "smoke-request"
  },
  body: recognitionBody
}), env);
assert.equal(success.status, 200);
assert.equal((await success.json()).status, "succeeded");

const denied = await handler(new Request(`${origin}/v1/recognitions`, {
  method: "POST",
  headers: {
    Origin: origin,
    Authorization: "Bearer wrong",
    "Content-Type": "application/json",
    "Idempotency-Key": "smoke-request"
  },
  body: recognitionBody
}), env);
assert.equal(denied.status, 401);

const missing = await handler(new Request(`${origin}/no-such-file`), env);
assert.equal(missing.status, 404);

console.log(`STANDALONE_WORKER_PACKAGE_OK files=${manifest.files.length} dirty=${manifest.dirty} ready=${ready}`);

async function serveStagedAsset(request, readyRoot) {
  const url = new URL(request.url);
  let relative;
  try {
    relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return new Response("bad path", { status: 404 });
  }
  if (!relative) relative = "index.html";
  const assetRoot = path.resolve(readyRoot, "pwa-site");
  const target = path.resolve(assetRoot, relative);
  if (target !== assetRoot && !target.startsWith(assetRoot + path.sep)) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const content = await readFile(target);
    return new Response(content, { status: 200, headers: { "Content-Type": mimeType(target) } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8"
  };
  return types[extension] ?? "application/octet-stream";
}
