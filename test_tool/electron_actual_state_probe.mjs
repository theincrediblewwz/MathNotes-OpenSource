import { _electron as electron } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const outDir = path.join(projectRoot, "output", "playwright");
await mkdir(outDir, { recursive: true });

const logs = [];
let app;

try {
  app = await electron.launch({
    args: [path.join(projectRoot, "apps", "windows", "electron-dist", "main.cjs")],
    cwd: projectRoot,
    env: {
      ...process.env,
      MATHNOTES_DEV_SERVER: "http://127.0.0.1:9"
    }
  });

  const page = await app.firstWindow();
  page.on("console", (message) => {
    logs.push(`[console:${message.type()}] ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    logs.push(`[pageerror] ${error.stack ?? error.message}`);
  });

  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText().catch((error) => `[body read failed] ${error.message}`);
  const rootHtml = await page.locator("#root").evaluate((node) => node.innerHTML.slice(0, 1000)).catch((error) => `[root read failed] ${error.message}`);
  const editorCount = await page.locator("[data-testid='session-source-editor'] .cm-editor").count().catch(() => -1);
  const previewCount = await page.locator("[data-testid='preview-pane']").count().catch(() => -1);
  const screenshotPath = path.join(outDir, "electron-actual-state-probe.png");
  await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);

  console.log(`url=${page.url()}`);
  console.log(`editorCount=${editorCount}`);
  console.log(`previewCount=${previewCount}`);
  console.log(`bodyText=${bodyText.slice(0, 2000)}`);
  console.log(`rootHtml=${rootHtml}`);
  console.log(`screenshot=${screenshotPath}`);
  console.log("logs:");
  for (const line of logs.slice(-80)) console.log(line);
} finally {
  if (app) await app.close().catch(() => undefined);
}
