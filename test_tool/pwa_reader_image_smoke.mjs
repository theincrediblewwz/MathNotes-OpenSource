import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const url = process.env.PWA_CAPTURE_QA_URL || "http://127.0.0.1:4176";
const output = process.env.PWA_CAPTURE_QA_OUTPUT || path.join(tmpdir(), "mathnotes-pwa-reader-image-qa");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const viewport of [{ width: 412, height: 915 }, { width: 1180, height: 820 }]) {
    const page = await browser.newPage({ viewport });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(url);
    await page.evaluate(async () => {
      const { createReaderDocument } = await import("/src/readerDocument.ts");
      const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 900;
      const context = canvas.getContext("2d"); context.fillStyle = "#fcfaf2"; context.fillRect(0, 0, 1200, 900);
      context.strokeStyle = "#267a5a"; context.lineWidth = 8; context.strokeRect(70, 70, 1060, 760);
      context.fillStyle = "#172c23"; context.font = "60px sans-serif"; context.fillText("整张照片 · 原样显示", 130, 220);
      context.font = "42px sans-serif"; context.fillText("图形和手写标记保留在照片中", 130, 360);
      context.beginPath(); context.moveTo(190, 730); context.lineTo(580, 460); context.lineTo(950, 730); context.stroke();
      const photo = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      const documentContent = await createReaderDocument({ key: "qa", profileId: "qa", version: 1, notebookId: "qa", sessionId: "image", title: "图片阅读", revision: "qa", updatedAt: "now", syncedAt: "now", blockCount: 1, markdown: "", assets: [],
        html: '<html><head><style>body{margin:20px;font:16px sans-serif}img{width:180px}p{line-height:1.8}</style></head><body><h1>图片阅读</h1><p>点击照片放大，关闭后回到这里。</p><img alt="课堂照片" src="mathnotes-companion-asset://photo"><p>照片之后的正文保持不变。</p></body></html>' },
        [{ key: "photo", profileId: "qa", notebookId: "qa", sessionId: "image", assetId: "photo", mimeType: "image/png", bytes: photo, syncedAt: "now" }]);
      const frame = document.createElement("iframe"); frame.title = "笔记正文"; frame.setAttribute("sandbox", ""); frame.srcdoc = documentContent.html;
      frame.style.cssText = "display:block;width:100vw;height:100vh;border:0"; document.body.style.margin = "0"; document.body.replaceChildren(frame);
    });
    const frame = page.frameLocator('iframe[title="笔记正文"]');
    const summary = frame.locator(".mathnotes-image-preview > summary"); await summary.waitFor();
    const before = await summary.locator("img").boundingBox();
    await summary.click();
    await frame.getByRole("dialog", { name: "图片大图" }).waitFor({ state: "visible" });
    const enlarged = await frame.getByRole("dialog", { name: "图片大图" }).locator("img").boundingBox();
    if (!before || !enlarged || enlarged.width <= before.width + 100) throw new Error("Photo did not enlarge within sandboxed reader");
    if (enlarged.x < 0 || enlarged.y < 0 || enlarged.x + enlarged.width > viewport.width + 1 || enlarged.y + enlarged.height > viewport.height + 1) throw new Error("Enlarged photo escaped viewport");
    const screenshot = path.join(output, `reader-image-${viewport.width}.png`); await page.screenshot({ path: screenshot });
    await frame.getByText("关闭大图", { exact: true }).click();
    await frame.getByRole("dialog", { name: "图片大图" }).waitFor({ state: "hidden" });
    if (!await frame.getByText("照片之后的正文保持不变。", { exact: true }).isVisible()) throw new Error("Closing photo did not return to reader");
    const policy = await frame.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    if (await page.locator("iframe").getAttribute("sandbox") !== "" || !policy.includes("default-src 'none'") || policy.includes("script-src")) throw new Error("Reader security boundary was relaxed");
    if (await frame.locator("script,a[href]").count()) throw new Error("Viewer introduced scripting or navigation");
    if (errors.length) throw new Error(errors.join(" | "));
    results.push({ viewport, before, enlarged, sandbox: "", policy, screenshot, errors }); await page.close();
  }
  await writeFile(path.join(output, "result.json"), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2));
} finally { await browser.close(); }
