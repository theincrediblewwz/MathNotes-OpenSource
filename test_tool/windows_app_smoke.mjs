import { chromium } from "playwright";
import assert from "node:assert/strict";
import path from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const outDir = path.resolve("output/playwright");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 911 } });

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector("[data-testid='preview-pane'] .render-block", { timeout: 8000 });
await page.screenshot({ path: path.join(outDir, "windows-app-smoke-home.png"), fullPage: false });

const density = await page.evaluate(() => {
  const preview = document.querySelector("[data-testid='preview-pane']");
  const blocks = [...document.querySelectorAll(".render-block")];
  const first = blocks[0].getBoundingClientRect();
  const second = blocks[1].getBoundingClientRect();
  const previewBox = preview.getBoundingClientRect();
  return {
    widthRatio: first.width / previewBox.width,
    gap: second.top - first.bottom
  };
});

assert.ok(density.widthRatio >= 0.9, `preview block should occupy more preview width, got ${density.widthRatio}`);
assert.ok(density.gap <= 10, `preview blocks should read as a continuous lecture page, got ${density.gap}px`);
await page.setViewportSize({ width: 1800, height: 911 });
const widePreviewLayout = await page.evaluate(() => {
  const preview = document.querySelector("[data-testid='preview-pane']").getBoundingClientRect();
  const note = document.querySelector(".rendered-note").getBoundingClientRect();
  return {
    noteWidth: note.width,
    previewWidth: preview.width
  };
});
assert.ok(
  widePreviewLayout.noteWidth / widePreviewLayout.previewWidth >= 0.9,
  `rendered note should keep widening with the preview pane, got ${widePreviewLayout.noteWidth}/${widePreviewLayout.previewWidth}`
);
await page.setViewportSize({ width: 1280, height: 911 });

const previewText = await page.locator("[data-testid='preview-pane']").innerText();
assert.match(previewText, /泛函分析 第 3 讲/);
assert.doesNotMatch(previewText, /AI draft|Reviewed|Locked|photo_2026|Image|source:/i);

assert.equal(await page.locator(".source-block-select").count(), 0, "block selection checkboxes must stay hidden by default");
const firstBlockHeader = page.getByTestId("source-block-header").first();
await firstBlockHeader.click({ button: "right" });
await page.getByRole("button", { name: "多选块" }).click();
await page.getByRole("checkbox", { name: "取消选择 block 0001" }).waitFor();
assert.ok(await page.getByTestId("source-block-organize-toolbar").isVisible());
await page.screenshot({ path: path.join(outDir, "windows-app-smoke-block-selection.png"), fullPage: false });
await page.getByTestId("source-block-organize-toolbar").getByRole("button", { name: "取消选择", exact: true }).click();
assert.equal(await page.locator(".source-block-select").count(), 0, "cancelling selection must remove every block checkbox");

await firstBlockHeader.click({ button: "right" });
assert.ok(await page.getByRole("button", { name: "重新识别这个块" }).isVisible());
await page.keyboard.press("Escape");

await page.getByRole("button", { name: "进入阅读模式" }).click();
await page.getByRole("button", { name: "退出阅读模式" }).waitFor();
assert.equal(await page.locator(".source-pane").isVisible(), false);
assert.equal(await page.locator(".split-handle").isVisible(), false);
const readingPreview = await page.getByTestId("preview-pane").boundingBox();
assert.ok(readingPreview);
assert.ok(readingPreview.width >= 1270, `reading mode preview should fill the window, got ${readingPreview.width}px`);
await page.screenshot({ path: path.join(outDir, "windows-app-smoke-reading.png"), fullPage: false });
await page.getByRole("button", { name: "退出阅读模式" }).click();
assert.ok(await page.locator(".source-pane").isVisible());
await assertVisible(page, "[data-testid='session-source-editor'] .cm-editor");
const sourceEditorText = await page.getByTestId("session-source-editor").innerText();
assert.match(sourceEditorText, /block: 0002/);
assert.doesNotMatch(sourceEditorText, /block: sample-ocr-2/);
assert.doesNotMatch(sourceEditorText, /--- asset:/);
assert.doesNotMatch(sourceEditorText, /\|\s*path:\s*blocks\//);
assert.doesNotMatch(sourceEditorText, /\|\s*kind:\s*[a-z_]+/);
assert.ok(await page.locator("[data-testid='source-block']").count() >= 4, "Source editor should render one shell per Markdown block");
const sourceBodyEditorText = await page.locator("[data-testid='source-block-editor'] .cm-editor").first().innerText();
assert.doesNotMatch(sourceBodyEditorText, /source:|block:/, "Block CodeMirror body should not include source headers");
assert.equal(await page.locator("[data-testid='markdown-block-editor']").count(), 0);
assert.equal(await page.locator(".window-drag-region").count(), 2);
const dragRegionMetrics = await page.locator(".window-drag-region").first().evaluate((el) => {
  const box = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  const splitStyle = window.getComputedStyle(document.querySelector(".split-handle"));
  const floatingStyle = window.getComputedStyle(document.querySelector(".floating-group"));
  const sourceEditorStyle = window.getComputedStyle(document.querySelector(".session-source-editor"));
  return {
    appRegion: style.getPropertyValue("-webkit-app-region"),
    position: style.position,
    sourceEditorRegion: sourceEditorStyle.getPropertyValue("-webkit-app-region"),
    height: box.height,
    left: box.left,
    right: box.right,
    width: box.width,
    viewportWidth: window.innerWidth,
    zIndex: Number(style.zIndex),
    splitZIndex: Number(splitStyle.zIndex),
    floatingZIndex: Number(floatingStyle.zIndex)
  };
});
assert.equal(dragRegionMetrics.appRegion, "no-drag");
assert.equal(dragRegionMetrics.position, "fixed");
assert.notEqual(dragRegionMetrics.sourceEditorRegion, "drag", "source editor should keep normal pointer interaction below the explicit drag strip");
assert.ok(dragRegionMetrics.left >= 0);
assert.ok(dragRegionMetrics.width > 0, "drag region should expose a usable blank top-edge segment");
assert.ok(dragRegionMetrics.height >= 38 && dragRegionMetrics.height <= 42, `drag region should expose a generous native drag target, got ${dragRegionMetrics.height}px`);
assert.ok(dragRegionMetrics.zIndex > dragRegionMetrics.splitZIndex, "drag region should sit above the split handle at the top edge");
assert.ok(dragRegionMetrics.zIndex < dragRegionMetrics.floatingZIndex, "floating controls should remain clickable above the drag region");
const dragEdgeHitTargets = await page.evaluate(() => {
  const farLeftTarget = document.elementFromPoint(4, 12);
  const leftTarget = document.elementFromPoint(220, 30);
  const rightTarget = document.elementFromPoint(window.innerWidth - 220, 12);
  return {
    farLeft: farLeftTarget instanceof HTMLElement ? farLeftTarget.className : "",
    left: leftTarget instanceof HTMLElement ? leftTarget.className : "",
    right: rightTarget instanceof HTMLElement ? rightTarget.className : ""
  };
});
assert.match(String(dragEdgeHitTargets.farLeft), /window-drag-region/, "top edge above the primary buttons should remain draggable");
assert.match(String(dragEdgeHitTargets.left), /window-drag-region/, "top left blank edge should remain draggable");
assert.match(String(dragEdgeHitTargets.right), /window-drag-region/, "top right blank edge should remain draggable");
assert.equal(await page.locator("[data-testid='source-context-bar']").count(), 0);
assert.equal(await page.locator(".task-button .badge").count(), 0);
assert.equal(await page.locator(".new-photo-toast", { hasText: "photo_2026-06-26_003.jpg" }).count(), 0);

const sourceHeader = page.locator("[data-testid='source-block-header']").first();
await assertVisible(page, "[data-testid='source-block-header']");
const sourceHeaderStyle = await sourceHeader.evaluate((el) => {
  const style = window.getComputedStyle(el);
  return {
    color: style.color,
    cursor: style.cursor
  };
});
assert.equal(sourceHeaderStyle.cursor, "pointer");
assert.notEqual(sourceHeaderStyle.color, "rgb(47, 47, 43)");
await sourceHeader.click();
await assertVisible(page, "[data-testid='screen-toast'].show");
assert.match(await page.getByTestId("screen-toast").innerText(), /暂时找不到可预览素材/);

const firstMarkdownBodyLine = page.locator(".session-source-editor .cm-line", { hasText: "设 T_n 为有界线性算子" }).first();
const headerBoxForDrag = await sourceHeader.boundingBox();
const bodyBoxForDrag = await firstMarkdownBodyLine.boundingBox();
assert.ok(headerBoxForDrag);
assert.ok(bodyBoxForDrag);
await page.mouse.move(bodyBoxForDrag.x + 24, bodyBoxForDrag.y + bodyBoxForDrag.height / 2);
await page.mouse.down();
await page.mouse.move(headerBoxForDrag.x + 32, headerBoxForDrag.y + headerBoxForDrag.height / 2, { steps: 8 });
await page.mouse.up();
const sourceHeaderStyleAfterDrag = await sourceHeader.evaluate((el) => {
  const style = window.getComputedStyle(el);
  return {
    color: style.color,
    cursor: style.cursor
  };
});
assert.equal(sourceHeaderStyleAfterDrag.cursor, "pointer");
assert.notEqual(sourceHeaderStyleAfterDrag.color, "rgb(47, 47, 43)", "source header should remain styled after drag selection");

await page.locator(".session-source-editor .cm-line", { hasText: "设 T_n 为有界线性算子" }).click();
await assertVisible(page, "[data-testid='source-context-bar']");
assert.match(await page.getByTestId("source-context-bar").innerText(), /sample-ocr-1/);
const sourceContextDragStyles = await page.getByTestId("source-context-bar").evaluate((element) => {
  const button = element.querySelector("button");
  return {
    bar: window.getComputedStyle(element).getPropertyValue("-webkit-app-region"),
    button: button ? window.getComputedStyle(button).getPropertyValue("-webkit-app-region") : ""
  };
});
assert.equal(sourceContextDragStyles.bar, "no-drag", "source context bar must preserve text and control interaction under manual drag arbitration");
assert.equal(sourceContextDragStyles.button, "no-drag", "source context actions must stay clickable inside the drag surface");
const primaryControlsBox = await page.locator("[aria-label='Primary controls']").boundingBox();
const sourceContextBox = await page.getByTestId("source-context-bar").boundingBox();
assert.ok(primaryControlsBox, "primary toolbar should be measurable");
assert.ok(sourceContextBox, "source context bar should be measurable");
assert.ok(
  Math.abs(sourceContextBox.y - primaryControlsBox.y) <= 4,
  `source context bar should align with the top toolbar, got y=${sourceContextBox.y} toolbar=${primaryControlsBox.y}`
);
assert.ok(
  sourceContextBox.x >= primaryControlsBox.x + primaryControlsBox.width + 8,
  `source context bar should start after primary toolbar, got x=${sourceContextBox.x} toolbarRight=${
    primaryControlsBox.x + primaryControlsBox.width
  }`
);
await assertVisible(page, "[data-testid='block-lock-button']");
assert.match(await page.getByTestId("block-lock-button").innerText(), /固定整块/);
await page.keyboard.press("End");
await page.keyboard.type(" 实时预览测试");
await page.waitForFunction(() => document.querySelector("[data-testid='preview-pane']")?.textContent?.includes("实时预览测试"), undefined, {
  timeout: 3000
});
assert.match(await page.getByTestId("source-context-bar").innerText(), /未保存/);
await page.locator(".session-source-editor .cm-line", { hasText: "若 T 有界" }).click();
await page.keyboard.press("Home");
await page.keyboard.down("Shift");
await page.keyboard.press("End");
await page.keyboard.up("Shift");
await assertVisible(page, "[data-testid='lock-selection-button']");
await page.getByTestId("lock-selection-button").click();
await page.waitForFunction(
  () =>
    document.querySelector("[data-testid='session-source-editor']")?.textContent?.includes("lock:start") &&
    document.querySelector("[data-testid='session-source-editor']")?.textContent?.includes("lock:end"),
  undefined,
  { timeout: 3000 }
);
assert.doesNotMatch(await page.getByTestId("preview-pane").innerText(), /lock:start|lock:end/);
await assertVisible(page, ".cm-lockSpanBody");
await page.locator(".cm-lockSpanBody").first().click();
await assertVisible(page, "[data-testid='unlock-span-button']");
await page.getByTestId("unlock-span-button").click();
await page.waitForFunction(
  () =>
    !document.querySelector("[data-testid='session-source-editor']")?.textContent?.includes("lock:start") &&
    !document.querySelector("[data-testid='session-source-editor']")?.textContent?.includes("lock:end"),
  undefined,
  { timeout: 3000 }
);
assert.equal(await page.locator(".cm-lockSpanBody").count(), 0);

await page.getByRole("button", { name: "笔记目录", exact: true }).click();
await assertVisible(page, "[data-testid='notebook-drawer']");
assert.doesNotMatch(await page.getByTestId("notebook-drawer").innerText(), /PDE Stability|算子半群/);
await page.mouse.click(500, 850);
await assertHidden(page, "[data-testid='notebook-drawer']");
await page.getByRole("button", { name: "笔记目录", exact: true }).click();
await assertVisible(page, "[data-testid='notebook-drawer']");
await page.getByTestId("notebook-drawer").getByRole("button", { name: "设置", exact: true }).click();
await assertVisible(page, "[data-testid='settings-modal']");
assert.match(await page.getByTestId("settings-modal").innerText(), /文件位置/);
assert.match(await page.getByTestId("settings-modal").innerText(), /字体与字号/);
assert.match(await page.getByTestId("settings-modal").innerText(), /识别服务/);
assert.equal(await page.getByRole("button", { name: "选择笔记所在位置", exact: true }).isVisible(), true);
assert.equal(await page.getByLabel("左侧字体").isVisible(), true);
assert.equal(await page.getByLabel("右侧字体").isVisible(), true);
assert.equal(await page.getByTestId("settings-modal").getByTestId("provider-config").isVisible(), true);
assert.match(await page.getByTestId("provider-config").innerText(), /假识别服务（验证管线）|OpenAI 视觉识别|Codex 订阅识别/);
await page.getByRole("button", { name: "关闭设置", exact: true }).click();
await assertHidden(page, "[data-testid='settings-modal']");
await page.keyboard.press("Escape");
await assertHidden(page, "[data-testid='notebook-drawer']");

await page.getByRole("button", { name: "搜索", exact: true }).click();
await assertVisible(page, "[data-testid='search-popover']");
await page.getByPlaceholder("搜索笔记、源码、公式或命令").fill("OCR");
await page.getByTestId("preview-pane").click({ position: { x: 20, y: 120 } });
await assertHidden(page, "[data-testid='search-popover']");
await page.getByRole("button", { name: "搜索", exact: true }).click();
await assertVisible(page, "[data-testid='search-popover']");
await page.getByPlaceholder("搜索笔记、源码、公式或命令").fill("OCR");
await page.locator("[data-testid='search-popover'] button").first().click();
await page.waitForTimeout(250);
assert.equal(await page.locator("[data-testid='session-source-editor'] .cm-editor").first().isVisible(), true);

await page.getByRole("button", { name: "任务与块信息", exact: true }).click();
await assertVisible(page, "[data-testid='task-popover']");
assert.match(await page.getByTestId("task-popover").innerText(), /暂无真实任务记录|识别完成|等待识别|识别中|识别失败/);
assert.doesNotMatch(await page.getByTestId("task-popover").innerText(), /photo_003\.jpg|ocr_transcript_002/);
await page.getByTestId("task-popover").click();
await assertVisible(page, "[data-testid='task-popover']");
await page.mouse.click(640, 14);
await assertHidden(page, "[data-testid='task-popover']");
await page.getByRole("button", { name: "任务与块信息", exact: true }).click();
await assertVisible(page, "[data-testid='task-popover']");
await page.mouse.click(900, 600);
await assertHidden(page, "[data-testid='task-popover']");

await page.getByRole("button", { name: "导出 Markdown", exact: true }).click();
await assertVisible(page, "[data-testid='export-popover']");
await page.mouse.click(900, 600);
await assertHidden(page, "[data-testid='export-popover']");
await page.getByRole("button", { name: "导出 Markdown", exact: true }).click();
await assertVisible(page, "[data-testid='export-popover']");
await page.getByTestId("export-popover").getByRole("button", { name: "导出当前 Session", exact: true }).click();
await assertVisible(page, "[data-testid='screen-toast'].show");
await assertVisible(page, "[data-testid='export-result']");
assert.match(await page.getByTestId("export-result").innerText(), /lecture_03\.md|exports|Markdown block/);

await page.getByRole("button", { name: "手机连接", exact: true }).click();
await assertVisible(page, "[data-testid='more-drawer']");
await assertVisible(page, "[data-testid='connection-panel']");
const connectionText = await page.getByTestId("connection-panel").innerText();
assert.match(connectionText, /配对二维码/);
assert.match(connectionText, /手机连接地址/);
assert.match(connectionText, /配对令牌/);
assert.match(connectionText, /地址策略|自动选择/);
assert.doesNotMatch(connectionText, /监听地址|Root|pairingPayload/);
assert.equal(await page.getByTestId("more-drawer").getByRole("button", { name: "启动接收", exact: true }).isVisible(), true);
assert.equal(await page.getByTestId("more-drawer").getByRole("button", { name: "停止接收", exact: true }).isVisible(), true);
assert.doesNotMatch(await page.getByTestId("more-drawer").innerText(), /识别服务|保存 Provider 设置|检查 Provider/);
await page.getByTestId("more-drawer").click();
await assertVisible(page, "[data-testid='more-drawer']");
await page.mouse.click(500, 600);
await assertHidden(page, "[data-testid='more-drawer']");
await page.getByRole("button", { name: "手机连接", exact: true }).click();
await assertVisible(page, "[data-testid='more-drawer']");
await page.keyboard.press("Escape");
await assertHidden(page, "[data-testid='more-drawer']");

const previewSourceBlock = page.locator("[data-testid='preview-pane'] [data-block-id='sample-ocr-2']");
await previewSourceBlock.hover();
await assertVisible(page, "[data-testid='hover-tip']");
const hoverTipText = await page.getByTestId("hover-tip").innerText();
assert.match(hoverTipText, /块内约第|块内位置/);
assert.doesNotMatch(hoverTipText, /来自左侧第/);
const hoverTipMetrics = await page.getByTestId("hover-tip").evaluate((el) => {
  const box = el.getBoundingClientRect();
  return {
    pointerEvents: window.getComputedStyle(el).pointerEvents,
    x: box.left + box.width / 2,
    y: box.top + box.height / 2
  };
});
assert.equal(hoverTipMetrics.pointerEvents, "none", "hover source tip must not intercept preview block clicks");
await page.mouse.click(hoverTipMetrics.x, hoverTipMetrics.y);
await page.waitForTimeout(250);
assert.equal(await page.locator("[data-testid='session-source-editor'] .cm-editor").first().isVisible(), true);
await assertVisible(page, "[data-testid='source-block'][data-block-id='sample-ocr-2'].locating");
await assertSourceBlockCentered(page, "sample-ocr-2");
const locateTargets = ["sample-ocr-1", "sample-ocr-2", "sample-ocr-1", "sample-ocr-2", "sample-ocr-1", "sample-ocr-2"];
for (const blockId of locateTargets) {
  const block = page.locator(`[data-testid='preview-pane'] [data-block-id='${blockId}']`).first();
  await block.click({ position: { x: 18, y: 18 } });
  await assertVisible(page, `[data-testid='source-block'][data-block-id='${blockId}'].locating`);
  await assertSourceBlockCentered(page, blockId);
}
await assertVisible(page, "[data-testid='source-block'][data-block-id='sample-ocr-2'].locating");
const finalLocatedBlock = await page.evaluate(() => {
  const located = document.querySelector("[data-testid='source-block'].locating");
  return located instanceof HTMLElement ? located.dataset.blockId : "";
});
assert.equal(finalLocatedBlock, "sample-ocr-2", "rapid alternating preview clicks should leave the last source block highlighted");

const separator = await page.getByRole("separator", { name: "调整左右栏宽度" }).boundingBox();
const sourcePaneBeforeDrag = await page.locator(".source-pane").boundingBox();
assert.ok(sourcePaneBeforeDrag);
assert.ok(separator);
const lineLayout = await page.locator(".session-source-editor .cm-line").first().evaluate((el) => {
  const lineStyle = window.getComputedStyle(el);
  const contentStyle = window.getComputedStyle(document.querySelector(".session-source-editor .cm-content"));
  return {
    whiteSpace: lineStyle.whiteSpace,
    lineMaxWidth: lineStyle.maxWidth,
    contentMaxWidth: contentStyle.maxWidth
  };
});
assert.notEqual(
  lineLayout.lineMaxWidth,
  "100%",
  "CodeMirror line boxes must not be constrained by project-level max-width styles"
);
assert.notEqual(
  lineLayout.contentMaxWidth,
  "100%",
  "CodeMirror content must not be constrained by project-level max-width styles"
);
const lineWhiteSpace = lineLayout.whiteSpace;
assert.match(lineWhiteSpace, /break-spaces|pre-wrap/);
await page.mouse.move(separator.x + separator.width / 2, separator.y + 240);
await page.mouse.down();
await page.mouse.move(300, separator.y + 240, { steps: 6 });
await page.mouse.up();
const sourcePaneAfterNarrowDrag = await page.locator(".source-pane").boundingBox();
assert.ok(sourcePaneAfterNarrowDrag);
assert.ok(
  sourcePaneBeforeDrag.width - sourcePaneAfterNarrowDrag.width > 180,
  `split handle should reflow source pane when narrowed, got ${sourcePaneBeforeDrag.width - sourcePaneAfterNarrowDrag.width}px`
);
await page.mouse.move(300, separator.y + 240);
await page.mouse.down();
await page.mouse.move(1010, separator.y + 240, { steps: 6 });
await page.mouse.up();
const sourcePaneAfterDrag = await page.locator(".source-pane").boundingBox();
assert.ok(sourcePaneAfterDrag);
assert.ok(sourcePaneAfterDrag.width - sourcePaneAfterNarrowDrag.width > 500, `split handle should allow a wide resize range, got ${sourcePaneAfterDrag.width - sourcePaneAfterNarrowDrag.width}px`);

await page.screenshot({ path: path.join(outDir, "windows-app-smoke-interactions.png"), fullPage: false });
await browser.close();

console.log("windows app smoke passed");

async function assertVisible(page, selector) {
  await page.waitForSelector(selector, { state: "visible", timeout: 3000 });
  assert.equal(await page.locator(selector).first().isVisible(), true);
}

async function assertHidden(page, selector) {
  await page.waitForFunction((sel) => !document.querySelector(sel), selector, { timeout: 3000 });
  assert.equal(await page.locator(selector).count(), 0);
}

async function assertSourceBlockCentered(page, blockId) {
  await page.waitForFunction(
    (targetBlockId) => {
      const editor = document.querySelector("[data-testid='session-source-editor']");
      const block = document.querySelector(`[data-testid='source-block'][data-block-id='${targetBlockId}']`);
      if (!(editor instanceof HTMLElement) || !(block instanceof HTMLElement)) {
        return false;
      }
      const editorBox = editor.getBoundingClientRect();
      const blockBox = block.getBoundingClientRect();
      const blockCenterY = blockBox.top + blockBox.height / 2;
      return blockCenterY >= editorBox.top + 48 && blockCenterY <= editorBox.bottom - 48;
    },
    blockId,
    { timeout: 350 }
  );
}
