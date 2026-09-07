import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), "mathnotes-startup-"));
const output = process.argv[2] || "output/performance/windows-startup.json";
const runs = [];
for (let index = 0; index < 3; index += 1) {
  const started = Date.now();
  let app;
  try {
    app = await electron.launch({
      args: ["--no-stdio-init", path.join(root, "apps/windows/electron-dist/main.cjs"), `--user-data-dir=${path.join(fixture, "profile")}`],
      chromiumSandbox: false,
      cwd: root,
      env: { ...process.env, MATHNOTES_ROOT: path.join(fixture, "notes"), MATHNOTES_DEV_SERVER: "" }
    });
    const page = await app.firstWindow();
    const windowMs = Date.now() - started;
    const shownAt = await app.evaluate(({ BrowserWindow }) => new Promise((resolve) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isVisible()) resolve(Date.now());
      else window.once("show", () => resolve(Date.now()));
    }));
    await page.waitForSelector("[data-testid=session-source-editor] .cm-editor", { timeout: 30_000 });
    const editorMs = Date.now() - started;
    await page.waitForFunction(() => document.querySelector("[data-testid=preview-pane]")?.textContent?.includes("泛函分析 第 3 讲"));
    const readyMs = Date.now() - started;
    const performanceEntries = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, paints: performance.getEntriesByType("paint").map((item) => ({ name: item.name, ms: item.startTime })), navigation: performance.getEntriesByType("navigation").map((item) => ({ domContentLoadedMs: item.domContentLoadedEventEnd, loadMs: item.loadEventEnd })) }));
    const firstContentfulPaint = performanceEntries.paints.find((item) => item.name === "first-contentful-paint");
    runs.push({ run: index + 1, profile: index === 0 ? "new" : "existing", windowMs, windowShownMs: shownAt - started, editorMs, readyMs, firstContentfulPaintMs: firstContentfulPaint ? performanceEntries.timeOrigin - started + firstContentfulPaint.ms : null, performanceEntries });
  } finally {
    await app?.close();
  }
}
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(output, JSON.stringify({ fixture, runs }, null, 2));
console.log(JSON.stringify({ output, runs }, null, 2));
