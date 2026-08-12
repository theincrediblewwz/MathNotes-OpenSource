import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createStandaloneGatewayHandler } from "../apps/worker/src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const staticRoot = path.join(root, "apps", "pwa", "dist");
const screenshot = path.join(root, "output", "playwright", "mobile-standalone-same-origin.png");
await mkdir(path.dirname(screenshot), { recursive: true });

const gateway = createStandaloneGatewayHandler();
const server = createServer(async (incoming, outgoing) => {
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = new Request(`${origin}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers
    });
    const response = await gateway(request, {
      ASSETS: { fetch: (assetRequest) => serveAsset(assetRequest, staticRoot) }
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    outgoing.end(error instanceof Error ? error.message : "browser smoke failed");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const problems = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

  const response = await page.goto(origin, { waitUntil: "networkidle" });
  assert(response?.status() === 200, "standalone PWA did not load through the Worker asset binding");
  await page.getByText("手机独立", { exact: true }).waitFor();
  await page.waitForFunction((expected) => {
    const input = document.querySelector('input[aria-label="Gateway 地址"]');
    return input instanceof HTMLInputElement && input.value === expected;
  }, origin);
  assert(await page.getByLabel("Gateway 临时令牌").getAttribute("type") === "password", "Gateway token is not masked");
  const capability = await page.evaluate(async () => (await fetch("/v1/capabilities", { cache: "no-store" })).json());
  assert(capability.gateway === "mathnotes-standalone-v1", "capability probe did not reach the Worker");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `standalone PWA overflows by ${overflow}px on iPhone viewport`);
  await page.screenshot({ path: screenshot, fullPage: true });
  assert(problems.length === 0, `browser emitted errors: ${problems.join(" | ")}`);
  console.log(`STANDALONE_WORKER_BROWSER_OK origin=${origin} gatewayAutoFilled=true screenshot=${screenshot}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

async function serveAsset(request, rootDir) {
  const url = new URL(request.url);
  const requested = decodeURIComponent(url.pathname);
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const absolute = path.resolve(rootDir, relative);
  if (!absolute.startsWith(`${path.resolve(rootDir)}${path.sep}`)) return new Response("not found", { status: 404 });
  try {
    return new Response(await readFile(absolute), {
      status: 200,
      headers: { "Content-Type": contentType(absolute) }
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

function contentType(file) {
  const extension = path.extname(file).toLowerCase();
  return ({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml"
  })[extension] ?? "application/octet-stream";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
