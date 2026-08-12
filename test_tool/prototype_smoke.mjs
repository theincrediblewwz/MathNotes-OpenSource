import { chromium } from "playwright";
import assert from "node:assert/strict";
import path from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:4173/";
const outDir = path.resolve("output/playwright");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 911 } });

await page.goto(url, { waitUntil: "networkidle" });

await page.screenshot({ path: path.join(outDir, "windows-ui-prototype-smoke-home.png"), fullPage: false });

const previewText = await page.locator(".preview-pane").innerText();
assert.match(previewText, /泛函分析 第 3 讲/);
assert.doesNotMatch(previewText, /AI draft|Reviewed|Locked|photo_2026|Image|source:/i);

await page.locator("#menuBtn").click();
await assertVisible(page, "#notebookDrawer.open", "notebook drawer should open");

await page.keyboard.press("Escape");
await assertHidden(page, "#notebookDrawer.open", "notebook drawer should close on Escape");

await page.locator("#searchBtn").click();
await assertVisible(page, "#searchPopover.open", "search popover should open");
await page.locator("[data-jump='src-ocr-1']").click();
await page.waitForTimeout(250);
assert.equal(await page.locator("#src-ocr-1").evaluate((el) => el.classList.contains("locating")), true);

await page.locator("#taskBtn").click();
await assertVisible(page, "#taskPopover.open", "task popover should open");

await page.locator("#exportBtn").click();
await assertVisible(page, "#exportPopover.open", "export popover should open");
await page.locator("#confirmExport").click();
await assertVisible(page, "#screenToast.show", "export toast should show");

await page.locator("#moreBtn").click();
await assertVisible(page, "#moreDrawer.open", "more drawer should open");

await page.locator(".render-block[data-source='src-ocr-2']").hover();
await assertVisible(page, "#hoverTip", "hover tip should show");
await page.locator(".render-block[data-source='src-ocr-2']").click();
await page.waitForTimeout(250);
assert.equal(await page.locator("#src-ocr-2").evaluate((el) => el.classList.contains("locating")), true);

await page.screenshot({ path: path.join(outDir, "windows-ui-prototype-smoke-interactions.png"), fullPage: false });
await browser.close();

console.log("prototype smoke passed");

async function assertVisible(page, selector, message) {
  await page.waitForSelector(selector, { state: "visible", timeout: 3000 });
  assert.equal(await page.locator(selector).first().isVisible(), true, message);
}

async function assertHidden(page, selector, message) {
  await page.waitForFunction((sel) => !document.querySelector(sel), selector, { timeout: 3000 });
  assert.equal(await page.locator(selector).count(), 0, message);
}
