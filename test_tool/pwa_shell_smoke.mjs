import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pwaRoot = path.join(projectRoot, "apps", "pwa", "dist");
const manifest = JSON.parse(await readFile(path.join(pwaRoot, "manifest.webmanifest"), "utf8"));
const index = await readFile(path.join(pwaRoot, "index.html"), "utf8");
const serviceWorker = await readFile(path.join(pwaRoot, "sw.js"), "utf8");
const fixtureToken = "pwa-smoke-token";
const pairingScreenshotPath = path.join(tmpdir(), "mathnotes-pwa-pairing-auto-origin.png");
const screenshotPath = path.join(tmpdir(), "mathnotes-pwa1-readonly-companion.png");
const mobileScreenshotPath = path.join(tmpdir(), "mathnotes-pwa1-readonly-companion-mobile.png");
const mobileCaptureScreenshotPath = path.join(tmpdir(), "mathnotes-pwa-mobile-capture.png");
const mobileCatalogScreenshotPath = path.join(tmpdir(), "mathnotes-pwa-mobile-catalog-capture.png");

assert(manifest.name === "MathNotes Companion", "PWA manifest name mismatch");
assert(manifest.display === "standalone" && manifest.start_url === "/", "PWA install contract mismatch");
assert(manifest.icons.some((icon) => icon.sizes === "192x192"), "PWA 192 icon missing");
assert(manifest.icons.some((icon) => icon.sizes === "512x512"), "PWA 512 icon missing");
assert(index.includes("manifest.webmanifest"), "PWA manifest link missing from index");
assert(!index.includes(fixtureToken), "PWA shell embeds the fixture token");
assert(!serviceWorker.includes(fixtureToken), "Service Worker embeds the fixture token");
assert(!serviceWorker.includes("/api/"), "Service Worker contains an API route in its precache payload");

const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mathnotes-pwa1-"));
const runtimeRoot = path.join(fixtureRoot, "runtime");
const notesRoot = path.join(fixtureRoot, "notes");
await mkdir(runtimeRoot);
await createNotesFixture(notesRoot);
const configPath = path.join(fixtureRoot, "network-node.json");
const port = await getFreeBrowserPort();
await writeFile(configPath, JSON.stringify({
  version: 2,
  exposureMode: "loopback",
  port,
  userDataDir: runtimeRoot,
  notesRootDir: notesRoot,
  pwaStaticRootDir: pwaRoot,
  legacyTokenEnv: "MATHNOTES_PWA_SMOKE_TOKEN"
}));
const child = spawn(process.execPath, [
  path.join(projectRoot, "packages", "core-server", "dist", "headless", "networkNodeCli.cjs"),
  "--config",
  configPath
], {
  cwd: projectRoot,
  env: { ...process.env, MATHNOTES_PWA_SMOKE_TOKEN: fixtureToken },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  windowsHide: true
});

let browser;
let context;
let page;
try {
  const started = await waitForReady(child);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
  await context.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined
    });
  });
  page = await context.newPage();
  const browserMessages = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      const location = message.location();
      browserMessages.push(
        `${message.type()}: ${message.text()} @ ${location.url || "unknown"}:${location.lineNumber ?? 0}`
      );
    }
  });
  page.on("pageerror", (error) => browserMessages.push(`pageerror: ${error.message}`));
  await page.route("**/api/v1/pairing/verify", async (route) => {
    const upstream = await route.fetch();
    const catalog = await upstream.json();
    await route.fulfill({
      response: upstream,
      json: {
        ...catalog,
        capabilities: {
          upload: { image: true, pdf: true },
          recognition: { status: true, retry: true }
        }
      }
    });
  });

  const response = await page.goto(started.url, { waitUntil: "networkidle" });
  assert(response?.status() === 200, "same-origin PWA companion did not load");
  assert(
    await page.evaluate(() => typeof globalThis.crypto?.randomUUID === "undefined"),
    "PWA compatibility smoke did not disable crypto.randomUUID"
  );
  assert(
    (await response?.headerValue("content-security-policy"))?.includes("connect-src 'self' http: https:"),
    "PWA cross-origin Companion CSP missing"
  );
  await page.getByRole("heading", { name: "连接你的 MathNotes" }).waitFor();
  const automaticOrigin = page.getByLabel("电脑地址");
  assert(
    (await automaticOrigin.textContent())?.includes(started.url),
    "PWA must automatically use the current Mac origin"
  );
  await writeLegacyCrossOriginCredential(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "连接你的 MathNotes" }).waitFor();
  assert(
    await hasActiveCredential(page) === false,
    "PWA retained a credential belonging to another host origin"
  );
  await page.getByRole("button", { name: "连接其他电脑" }).click();
  const customOrigin = page.getByLabel("其他电脑地址");
  assert(await customOrigin.getAttribute("required") !== null, "custom PWA computer address must be required");
  assert(
    await page.locator('.pairing-sheet input[type="password"]').count() === 0,
    "PWA must not submit a host token across origins"
  );
  const openComputer = page.getByRole("button", { name: "打开这台电脑" });
  await openComputer.waitFor();
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    openComputer.click()
  ]);
  await page.getByRole("heading", { name: "连接你的 MathNotes" }).waitFor();
  await page.screenshot({ path: pairingScreenshotPath, fullPage: true });
  const pairingToken = page.getByLabel("配对令牌");
  assert(await pairingToken.getAttribute("required") !== null, "PWA pairing token must be required");
  await pairingToken.fill(fixtureToken);
  await page.getByRole("button", { name: "连接电脑" }).click();
  await page.getByRole("heading", { name: "泛函分析" }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "泛函分析" }).waitFor();
  assert(
    await page.getByRole("heading", { name: "连接你的 MathNotes" }).count() === 0,
    "PWA must restore the saved credential without reopening pairing"
  );
  const search = page.getByLabel("搜索 Notebook 或 Session");
  await search.fill("不存在的 Session");
  await page.getByRole("heading", { name: "没有匹配的笔记" }).waitFor();
  await page.getByRole("button", { name: "清除搜索" }).click();
  await page.getByRole("heading", { name: "泛函分析" }).waitFor();

  await page.route("**/api/v1/uploads", async (route) => {
    assert(route.request().method() === "POST", "PWA upload smoke did not use POST");
    assert(
      route.request().headers().authorization === `Bearer ${fixtureToken}`,
      "PWA upload smoke omitted the device authorization"
    );
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        uploadId: "pwa-smoke-upload",
        duplicate: false,
        imageBlockId: "0002",
        transcriptBlockId: "0003",
        recognitionJobId: "pwa-smoke-recognition",
        recognitionStatus: "running"
      })
    });
  });
  await page.route("**/api/v1/uploads/status?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        uploadId: "pwa-smoke-upload",
        duplicate: false,
        imageBlockId: "0002",
        transcriptBlockId: "0003",
        recognitionJobId: "pwa-smoke-recognition",
        recognitionStatus: "succeeded"
      })
    });
  });
  await page.getByRole("button", { name: "PDF", exact: true }).waitFor();
  const galleryInput = page.locator('input[type="file"][accept="image/*"][multiple]');
  await galleryInput.setInputFiles({
    name: "pwa-board.png",
    mimeType: "image/png",
    buffer: await readFile(path.join(projectRoot, "apps", "pwa", "public", "icons", "mathnotes-192.png"))
  });
  const succeededUpload = page.locator(".upload-task.succeeded");
  await succeededUpload.waitFor({ timeout: 15_000 });
  await succeededUpload.getByText(/^已入库并识别完成 · /).waitFor({ timeout: 15_000 });

  await page.getByRole("button", { name: /泛函分析 第 3 讲/ }).click();

  const reader = page.frameLocator("iframe.reader-frame");
  await reader.getByRole("heading", { name: "泛函分析 第 3 讲" }).waitFor();
  await reader.getByRole("heading", { name: "半群与生成元" }).waitFor();
  const image = reader.getByRole("img", { name: "相图" });
  await image.waitFor();
  await image.evaluate((element) => new Promise((resolve, reject) => {
    const imageElement = /** @type {HTMLImageElement} */ (element);
    if (imageElement.complete && imageElement.naturalWidth > 0) return resolve(undefined);
    if (imageElement.complete) return reject(new Error("reader image completed without pixels"));
    const timeout = setTimeout(() => reject(new Error("reader image load timed out")), 5_000);
    imageElement.addEventListener("load", () => {
      clearTimeout(timeout);
      resolve(undefined);
    }, { once: true });
    imageElement.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("reader image failed to load"));
    }, { once: true });
  }));
  assert((await image.getAttribute("src"))?.startsWith("data:image/"), "reader image is not embedded inside the opaque sandbox");

  const databaseState = await readDatabaseState(page);
  assert(
    JSON.stringify(databaseState.stores) === JSON.stringify([
      "assets",
      "catalogs",
      "credentials",
      "meta",
      "sessions",
      "uploads"
    ]),
    "PWA IndexedDB schema does not contain the companion stores"
  );
  assert(databaseState.catalogTargets === 1, "paired catalog was not persisted");
  assert(databaseState.sessionTitle === "泛函分析 第 3 讲", "session snapshot was not persisted");
  assert(databaseState.assetCount === 1, "session asset Blob was not persisted");
  assert(databaseState.uploadStatus === "succeeded", "foreground upload queue did not persist completion");
  assert(databaseState.uploadBytesPresent === false, "completed upload retained its source Blob");

  await page.evaluate(async () => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.frameLocator("iframe.reader-frame").getByRole("heading", { name: "半群与生成元" }).waitFor();

  const apiStatus = await page.evaluate(async () => (await fetch("/api/v1/health")).status);
  assert(apiStatus === 200, "same-origin Core API was swallowed by PWA routing");
  const browserSecurity = await page.evaluate(async () => {
    const names = await caches.keys();
    const requests = (await Promise.all(names.map(async (name) => (await caches.open(name)).keys()))).flat();
    return {
      localStorage: { ...localStorage },
      cachedUrls: requests.map((request) => request.url),
      bodyText: document.body.innerText
    };
  });
  assert(!JSON.stringify(browserSecurity.localStorage).includes(fixtureToken), "token leaked into localStorage");
  assert(browserSecurity.cachedUrls.every((url) => !url.includes("/api/")), "Service Worker cached an API request");
  assert(browserSecurity.cachedUrls.every((url) => !url.includes(fixtureToken)), "token leaked into Cache Storage URLs");
  assert(!browserSecurity.bodyText.includes(fixtureToken), "token leaked into visible UI");
  assert((await fetch(`${started.url}/unknown-client-route`)).status === 404, "unknown path incorrectly fell back to index");

  await page.screenshot({ path: screenshotPath, fullPage: false });

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("离线阅读", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: /连接状态：离线阅读/ }).click();
  await page.getByRole("region", { name: "连接详情" }).waitFor();
  await page.getByText("手机当前离线", { exact: true }).waitFor();
  await page.getByText(started.url, { exact: true }).waitFor();
  await page.getByRole("button", { name: "立即重试" }).waitFor();
  await page.getByRole("button", { name: "收起" }).click();
  const offlineReader = page.frameLocator("iframe.reader-frame");
  await offlineReader.getByRole("heading", { name: "半群与生成元" }).waitFor();
  const offlineImage = offlineReader.getByRole("img", { name: "相图" });
  await offlineImage.waitFor();
  assert((await offlineImage.getAttribute("src"))?.startsWith("data:image/"), "offline reader did not restore its cached image");

  await context.setOffline(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "返回目录" }).click();
  const mobileSessionButton = page.locator(".session-list button").filter({ hasText: "泛函分析 第 3 讲" });
  await mobileSessionButton.waitFor();
  await Promise.all([
    page.waitForResponse((candidate) => candidate.url().includes("/api/v1/pairing/verify")),
    page.getByRole("button", { name: "立即刷新" }).click()
  ]);
  assert(
    await page.getByRole("button", { name: "返回目录" }).count() === 0,
    "catalog refresh unexpectedly reopened the first session"
  );
  await page.getByRole("button", { name: /采集到笔记/ }).waitFor();
  await page.getByText("PWA 2026.07.29.13", { exact: true }).waitFor();
  await page.screenshot({ path: mobileCatalogScreenshotPath, fullPage: false });
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(mobileOverflow <= 1, `mobile PWA overflows horizontally by ${mobileOverflow}px`);
  await page.getByRole("button", { name: /采集到笔记/ }).click();
  await page.getByRole("dialog", { name: "采集到当前 Session" }).waitFor();
  await page.getByRole("button", { name: "关闭采集" }).last().click();
  await mobileSessionButton.click();
  await page.frameLocator("iframe.reader-frame").getByRole("heading", { name: "半群与生成元" }).waitFor();
  await page.getByRole("button", { name: "采集", exact: true }).click();
  await page.getByRole("dialog", { name: "采集到当前 Session" }).waitFor();
  assert(
    await page.locator('.mobile-capture-sheet input[type="file"][accept="image/*"][multiple]').count() === 1,
    "mobile reader capture sheet did not expose gallery intake"
  );
  await page.screenshot({ path: mobileCaptureScreenshotPath, fullPage: false });
  await page.getByRole("button", { name: "关闭采集" }).last().click();
  await page.screenshot({ path: mobileScreenshotPath, fullPage: false });
  assert(browserMessages.length === 0, `browser emitted errors: ${browserMessages.join(" | ")}`);

  console.log(
    `PWA_COMPANION_SMOKE_OK catalog=1 session=1 assets=1 cached=${browserSecurity.cachedUrls.length} ` +
    `origin=${started.url} screenshots=${pairingScreenshotPath},${screenshotPath},${mobileCatalogScreenshotPath},${mobileScreenshotPath},${mobileCaptureScreenshotPath}`
  );
} catch (error) {
  if (page) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);
    console.error(`PWA_COMPANION_SMOKE_DIAGNOSTIC\n${bodyText}\nscreenshot=${screenshotPath}`);
  }
  throw error;
} finally {
  await context?.close();
  await browser?.close();
  if (child.connected) child.send({ type: "mathnotes-shutdown" });
  try {
    await waitForExit(child);
  } catch {
    child.kill();
    await waitForExit(child).catch(() => undefined);
  }
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function createNotesFixture(notesRoot) {
  const notebookDir = path.join(notesRoot, "notebooks", "analysis");
  const sessionId = "20260728073706_未命名_session_12ce79";
  const sessionDir = path.join(notebookDir, "sessions", sessionId);
  await mkdir(path.join(sessionDir, "blocks"), { recursive: true });
  await mkdir(path.join(sessionDir, "assets", "embedded"), { recursive: true });
  await writeFile(path.join(notebookDir, "notebook.json"), JSON.stringify({
    id: "analysis",
    title: "泛函分析",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:01:00.000Z"
  }, null, 2));
  await writeFile(
    path.join(sessionDir, "blocks", "0001_user.md"),
    [
      "## 半群与生成元",
      "",
      "设 $T(t)$ 是强连续半群，并且",
      "",
      "$$",
      "\\|T(t)x\\| \\le e^{\\omega t}\\|x\\|.",
      "$$",
      "",
      "![相图](../assets/embedded/phase-portrait.png)",
      ""
    ].join("\n"),
    "utf8"
  );
  await copyFile(
    path.join(projectRoot, "apps", "pwa", "public", "icons", "mathnotes-192.png"),
    path.join(sessionDir, "assets", "embedded", "phase-portrait.png")
  );
  await writeFile(path.join(sessionDir, "session.json"), JSON.stringify({
    id: sessionId,
    title: "泛函分析 第 3 讲",
    status: "draft",
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:01:00.000Z",
    currentDraftPolicy: "append_only",
    exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks: [{
      id: "0001",
      type: "markdown",
      path: "blocks/0001_user.md",
      source: "user",
      status: "draft",
      readonly: false,
      editableByAi: false,
      createdAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:01:00.000Z"
    }]
  }, null, 2));
}

async function readDatabaseState(page) {
  return page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open("mathnotes-pwa");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const stores = Array.from(database.objectStoreNames);
      const transaction = database.transaction(["catalogs", "sessions", "assets", "uploads"], "readonly");
      const catalog = transaction.objectStore("catalogs").getAll();
      const sessions = transaction.objectStore("sessions").getAll();
      const assets = transaction.objectStore("assets").count();
      const uploads = transaction.objectStore("uploads").getAll();
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        resolve({
          stores,
          catalogTargets: catalog.result[0]?.targets?.length ?? 0,
          sessionTitle: sessions.result[0]?.title,
          assetCount: assets.result,
          uploadStatus: uploads.result[0]?.status,
          uploadBytesPresent: Boolean(uploads.result[0]?.bytes)
        });
        database.close();
      };
    };
  }));
}

async function writeLegacyCrossOriginCredential(page) {
  await page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open("mathnotes-pwa");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("credentials", "readwrite");
      transaction.objectStore("credentials").put({
        id: "active",
        version: 1,
        origin: "https://previous-host.tailnet.ts.net",
        token: "previous-host-token",
        deviceId: "previous-host-device",
        deviceLabel: "Legacy PWA",
        verifiedAt: "2026-07-28T00:00:00.000Z"
      });
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        database.close();
        resolve(undefined);
      };
    };
  }));
}

async function hasActiveCredential(page) {
  return page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open("mathnotes-pwa");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("credentials", "readonly");
      const credential = transaction.objectStore("credentials").get("active");
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => {
        database.close();
        resolve(Boolean(credential.result));
      };
    };
  }));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`PWA smoke node readiness timed out: ${stderr}`)), 15_000);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.kind === "mathnotes-network-ready" && typeof parsed.url === "string") {
            clearTimeout(timeout);
            resolve(parsed);
          }
        } catch {
          // Only complete JSON status lines are part of the CLI protocol.
        }
      }
    });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`PWA smoke node exited before ready (${code}): ${stderr}`));
    });
  });
}

async function getFreeBrowserPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 42_000 + Math.floor(Math.random() * 7_000);
    const available = await new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close((error) => resolve(!error));
      });
    });
    if (available) return port;
  }
  throw new Error("Unable to reserve a browser-safe PWA smoke port");
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("PWA smoke node did not stop after IPC shutdown")), 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
