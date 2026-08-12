import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const executable = path.resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node test_tool/windows_portable_smoke.mjs <MathNotes.exe>");

const userDataDir = await mkdtemp(path.join(os.tmpdir(), "mathnotes-portable-smoke-"));
const pdfPath = path.join(userDataDir, "portable-pdf-runtime-smoke.pdf");
await writeFile(pdfPath, createMinimalPdf());
await assertReleaseFiles(path.dirname(executable));
const port = await reservePort();
const child = spawn(executable, [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`], {
  cwd: path.dirname(executable),
  windowsHide: true,
  stdio: "ignore"
});

let browser;
try {
  browser = await connectWithRetry(port, child);
  const page = await waitForRendererPage(browser, child);
  await page.waitForLoadState("domcontentloaded");
  const title = await page.title();
  const body = await page.locator("body").innerText();
  if (!body.includes("Session")) throw new Error("Packaged renderer did not load the MathNotes workspace");
  const pdf = await page.evaluate((filePath) => window.mathNotes.pickLocalPdf({ filePath }), pdfPath);
  if (pdf.cancelled || pdf.pageCount !== 1) {
    throw new Error(`Packaged PDF runtime did not inspect the selected document: ${JSON.stringify(pdf)}`);
  }
  let ingestState = await page.evaluate(() => window.mathNotes.loadIngestServerState());
  if (!ingestState.running) {
    ingestState = await page.evaluate(() => window.mathNotes.startIngestServer());
  }
  if (!ingestState.port) throw new Error("Packaged app did not start its phone connection host");
  const pwaOrigin = `http://127.0.0.1:${ingestState.port}`;
  const pwaResponse = await fetch(`${pwaOrigin}/`);
  const pwaHtml = await pwaResponse.text();
  if (!pwaResponse.ok || !pwaHtml.includes("MathNotes")) {
    throw new Error(`Packaged phone host did not serve the bundled PWA: ${pwaResponse.status}`);
  }
  const serviceWorkerResponse = await fetch(`${pwaOrigin}/sw.js`);
  const serviceWorker = await serviceWorkerResponse.text();
  if (!serviceWorkerResponse.ok || !serviceWorker.includes("skipWaiting")) {
    throw new Error("Packaged phone host is missing the production service worker");
  }
  console.log(`WINDOWS_PORTABLE_SMOKE_OK title=${JSON.stringify(title)} pid=${child.pid}`);
} finally {
  await browser?.close().catch(() => undefined);
  if (child.pid) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  await removeWithRetry(userDataDir);
}

function createMinimalPdf() {
  return Buffer.from(
    "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n" +
      "xref\n0 4\n0000000000 65535 f \n" +
      "trailer\n<< /Root 1 0 R /Size 4 >>\nstartxref\n0\n%%EOF\n"
  );
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function connectWithRetry(port, child) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited early with ${child.exitCode}`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function waitForRendererPage(browser, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited early with ${child.exitCode}`);
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Packaged app exposed no renderer page within 15 seconds");
}

async function removeWithRetry(target) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

async function assertReleaseFiles(packagedRoot) {
  const required = [
    "README.md",
    "SECURITY.md",
    "首次运行说明.txt",
    "windows-sbom.cdx.json",
    "third-party-licenses.json",
    "release-manifest.json",
    path.join("resources", "MathNotesPWA", "index.html"),
    path.join("resources", "MathNotesPWA", "sw.js")
  ];
  for (const relativePath of required) await access(path.join(packagedRoot, relativePath));
  const locales = (await readdir(path.join(packagedRoot, "locales"))).sort();
  if (locales.join(",") !== "en-US.pak,zh-CN.pak") {
    throw new Error(`Portable package retained unexpected Chromium locales: ${locales.join(",")}`);
  }
  const manifest = JSON.parse(await readFile(path.join(packagedRoot, "release-manifest.json"), "utf8"));
  if (manifest.product !== "MathNotes" || typeof manifest.versions?.windows !== "string") {
    throw new Error("Portable release manifest does not match the packaged product version");
  }
}
