import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import katex from "katex";
import { chromium } from "playwright";

const root = process.cwd();
const pwaSource = await readFile(path.join(root, "apps/pwa/src/readerDocument.ts"), "utf8");
const coreStyleSource = await readFile(path.join(root, "packages/core-server/src/session/companionReaderStyle.ts"), "utf8");
const policyBody = pwaSource.match(/const katexVisibilityPolicy = \[([\s\S]*?)\]\.join\(""\);/)?.[1];
assert.ok(policyBody, "PWA KaTeX visibility policy was not found");
const policy = [...policyBody.matchAll(/^\s*("(?:[^"\\]|\\.)*")/gm)]
  .map((match) => JSON.parse(match[1]))
  .join("");
const coreStyle = coreStyleSource.match(/COMPANION_READER_STYLE = `([\s\S]*?)`;/)?.[1];
assert.ok(coreStyle, "Core companion reader style was not found");

const formulas = [
  String.raw`\mathcal A_1(\zeta)=-\int_\zeta^\infty \operatorname{Ai}(r_6t)\,dt,\quad \mathcal A_2(\zeta)=-\int_\zeta^\infty \mathcal A_1(t)\,dt\tag{1.2}`,
  String.raw`\xi_*\in I_* := [2.29721803560332,\,2.29721803560333]\tag{1.3}`,
  String.raw`\begin{cases}\partial_tV+V\cdot\nabla V+\nabla P-\nu\Delta V=0,\\\nabla\cdot V=0\end{cases}\tag{1.4}`,
  String.raw`\left[\begin{matrix}a_{11}&a_{12}&a_{13}\\a_{21}&a_{22}&a_{23}\end{matrix}\right]\longrightarrow\sqrt{\frac{\alpha+\beta}{\gamma}}\tag{1.5}`
];
const body = formulas.map((formula, index) =>
  `<div class="math-display" data-formula="${index}">${katex.renderToString(formula, { displayMode: true, throwOnError: true })}</div>`
).join("");
const katexCssUrl = pathToFileURL(path.join(root, "node_modules/katex/dist/katex.min.css")).href;
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${katexCssUrl}"><style>${coreStyle}${policy}</style></head><body>${body}</body></html>`;

const outDir = path.join(root, "output/playwright");
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.locator(".math-display").evaluateAll((displays) => displays.map((display) => {
    const tag = display.querySelector(".katex-html > .tag");
    const bases = [...display.querySelectorAll(".katex-html > .base")];
    const tagRect = tag?.getBoundingClientRect();
    const displayRect = display.getBoundingClientRect();
    const baseRects = bases.map((base) => base.getBoundingClientRect());
    const overlaps = tagRect ? baseRects.some((base) => !(
      tagRect.right <= base.left || tagRect.left >= base.right || tagRect.bottom <= base.top || tagRect.top >= base.bottom
    )) : true;
    const element = display;
    element.scrollLeft = element.scrollWidth;
    return {
      hasTag: Boolean(tagRect),
      overlaps,
      tagVisible: Boolean(tagRect && tagRect.left >= displayRect.left - 1 && tagRect.right <= displayRect.right + 1),
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      maxScrollReached: Math.abs(element.scrollLeft - (element.scrollWidth - element.clientWidth)) <= 1
    };
  }));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "Reader page must not grow wider than the phone viewport");
  for (const [index, item] of geometry.entries()) {
    assert.equal(item.hasTag, true, `Formula ${index} must expose its equation tag`);
    assert.equal(item.overlaps, false, `Formula ${index} equation tag overlaps the formula body`);
    assert.equal(item.tagVisible, true, `Formula ${index} equation tag must remain visible in the phone viewport`);
    assert.equal(item.maxScrollReached, true, `Formula ${index} right edge must remain reachable by its own scroller`);
  }
  assert.ok(geometry.some((item) => item.scrollWidth > item.clientWidth + 1), "Fixture must exercise an actually overflowing formula");
  await page.locator(".math-display").evaluateAll((displays) => displays.forEach((display) => { display.scrollLeft = 0; }));
  await page.screenshot({ path: path.join(outDir, "mobile-math-layout.png"), fullPage: true });
  console.log(`mobile math layout smoke passed formulas=${geometry.length}`);
} finally {
  await browser.close();
}
