import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:4174/";
const outDir = path.resolve("output/playwright/desktop-minimal-library-ai-edit-v1");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1024 }, deviceScaleFactor: 1 });
const rendererErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") rendererErrors.push(message.text());
});
page.on("pageerror", (error) => rendererErrors.push(error.message));

try {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid='preview-pane'] .render-block", { timeout: 10_000 });

  await page.getByRole("button", { name: "笔记目录", exact: true }).click();
  const recentDrawer = page.getByTestId("notebook-drawer");
  await recentDrawer.waitFor({ state: "visible" });
  assert.match(await recentDrawer.innerText(), /最近阅读/);
  assert.ok(await recentDrawer.locator(".recent-reading-row").count() <= 4);
  assert.deepEqual(
    (await recentDrawer.locator(".recent-reading-actions > button").allInnerTexts()).map((text) => text.trim()),
    ["设置", "打开 Notebooks"]
  );
  await page.screenshot({
    animations: "disabled",
    path: path.join(outDir, "01-recent-reading.png")
  });
  await recentDrawer.screenshot({
    animations: "disabled",
    path: path.join(outDir, "01-recent-reading-focus.png")
  });

  await recentDrawer.getByRole("button", { name: "设置", exact: true }).click();
  const settingsModal = page.getByRole("dialog", { name: "设置" });
  await settingsModal.waitFor({ state: "visible" });
  assert.doesNotMatch(await settingsModal.innerText(), /诊断与自检|选择自检图片|导出脱敏诊断报告/);
  const ownerCard = settingsModal.getByRole("link", { name: "打开 WWZ SYSU 的 GitHub 主页" });
  await ownerCard.waitFor({ state: "visible" });
  assert.equal(await ownerCard.getAttribute("href"), "https://github.com/theincrediblewwz");
  assert.equal(await ownerCard.locator("img").getAttribute("alt"), "WWZ SYSU 头像");
  await ownerCard.screenshot({
    animations: "disabled",
    path: path.join(outDir, "02a-settings-owner.png")
  });
  const typographySection = settingsModal.locator(".typography-section");
  await typographySection.scrollIntoViewIfNeeded();
  await typographySection.getByLabel("左侧字号").fill("18");
  await typographySection.getByRole("button", { name: "一键应用", exact: true }).click();
  await page.getByText("浏览器预览模式：设置已暂存", { exact: true }).waitFor({ state: "visible" });
  await page.screenshot({
    animations: "disabled",
    path: path.join(outDir, "02-settings-typography.png")
  });
  await typographySection.screenshot({
    animations: "disabled",
    path: path.join(outDir, "02-settings-typography-focus.png")
  });
  await typographySection.getByLabel("左侧字号").fill("13");
  await typographySection.getByRole("button", { name: "一键应用", exact: true }).click();
  await settingsModal.getByRole("button", { name: "关闭设置", exact: true }).click();

  await page.getByRole("button", { name: "笔记目录", exact: true }).click();
  await recentDrawer.waitFor({ state: "visible" });
  await recentDrawer.getByRole("button", { name: "打开 Notebooks", exact: true }).click();
  const notebookBrowser = page.getByRole("dialog", { name: "打开 Notebooks" });
  await notebookBrowser.waitFor({ state: "visible" });
  assert.equal(await notebookBrowser.getByRole("button", { name: "设置", exact: true }).count(), 0);
  assert.ok(await notebookBrowser.locator(".notebook-folder").count() >= 4);
  assert.ok(await notebookBrowser.locator(".notebook-session-main").count() >= 4);
  await notebookBrowser.locator(".notebook-session-main").first().hover();
  const sessionPreview = page.locator(".notebook-session-preview");
  await sessionPreview.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const preview = document.querySelector(".notebook-session-preview");
    return preview && !preview.textContent?.includes("正在渲染预览");
  });
  const previewBox = await sessionPreview.boundingBox();
  assert.ok(previewBox);
  assert.ok(previewBox.x >= 8 && previewBox.y >= 8);
  assert.ok(previewBox.x + previewBox.width <= 1432);
  assert.ok(previewBox.y + previewBox.height <= 1016);
  await page.screenshot({
    animations: "disabled",
    path: path.join(outDir, "02-notebook-browser.png")
  });
  await notebookBrowser.getByRole("button", { name: "关闭", exact: true }).click();

  const selectionEditor = page.locator("[data-testid='source-block-editor'] .cm-content").first();
  await selectionEditor.click();
  await page.keyboard.press("Control+a");
  const selectedText = (await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim();
  assert.ok(selectedText.length > 20, `Selection fixture should contain a meaningful paragraph, got ${selectedText.length}`);
  await selectionEditor.click({ button: "right", position: { x: 80, y: 24 } });
  await page.getByRole("button", { name: "用 AI 修改选中文字", exact: true }).click();

  const assistant = page.getByTestId("assistant-workspace");
  await assistant.waitFor({ state: "visible" });
  await assistant.getByRole("textbox", { name: "告诉 AI 怎样修改" }).fill("把这一段写得更清楚，公式不要动");
  await page.evaluate(() => {
    window.mathNotes = {
      proposeSelectionEdit: async (input) => {
        const timestamp = new Date().toISOString();
        return {
          version: 1,
          id: "visual-selection-proposal",
          notebookId: input.notebookId,
          sessionId: input.sessionId,
          blockId: input.blockId,
          baseRevision: "visual-base-revision",
          selection: {
            from: input.from,
            to: input.to,
            selectedText: input.selectedText
          },
          instruction: input.instruction,
          replacementMarkdown: [
            "## 泛函分析 第 3 讲",
            "",
            "设 $X,Y$ 为赋范线性空间，$T:X\\to Y$ 为线性算子。若存在常数 $M>0$，使得",
            "",
            "$$\\|Tx\\|_Y \\le M\\|x\\|_X,\\qquad \\forall x\\in X,$$",
            "",
            "则称 $T$ 为有界线性算子。其算子范数定义为",
            "",
            "$$\\|T\\|=\\sup_{x\\ne0}\\frac{\\|Tx\\|_Y}{\\|x\\|_X}."
          ].join("\n"),
          providerName: "visual-qa-assistant",
          status: "proposed",
          createdAt: timestamp,
          updatedAt: timestamp
        };
      },
      cancelSelectionEdit: async () => ({ status: "cancelled" })
    };
  });
  await assistant.getByRole("button", { name: "生成修改", exact: true }).click();
  await assistant.getByText("已生成修改候选。应用前，你仍可以继续编辑。").waitFor({ state: "visible" });
  assert.equal(await assistant.locator(".assistant-edit-card.original").isVisible(), true);
  assert.equal(await assistant.locator(".assistant-edit-card.revised").isVisible(), true);
  assert.match(await assistant.innerText(), /仅修改未锁定内容/);
  await page.screenshot({
    animations: "disabled",
    path: path.join(outDir, "03-ai-selection-edit.png")
  });

  const beforeResize = await assistant.boundingBox();
  const westHandle = assistant.getByTestId("assistant-resize-w");
  const westHandleBox = await westHandle.boundingBox();
  assert.ok(beforeResize && westHandleBox);
  await page.mouse.move(westHandleBox.x + westHandleBox.width / 2, westHandleBox.y + westHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(westHandleBox.x - 84, westHandleBox.y + westHandleBox.height / 2, { steps: 8 });
  await page.mouse.up();
  const afterWestResize = await assistant.boundingBox();
  assert.ok(afterWestResize);
  assert.ok(afterWestResize.width - beforeResize.width > 70, "Dragging the west edge should widen the assistant");
  assert.ok(
    Math.abs(afterWestResize.x + afterWestResize.width - (beforeResize.x + beforeResize.width)) <= 2,
    "Dragging the west edge must keep the east edge anchored"
  );

  const header = assistant.locator(".assistant-workspace-header");
  const headerBox = await header.boundingBox();
  assert.ok(headerBox);
  await page.mouse.move(headerBox.x + headerBox.width * 0.45, headerBox.y + headerBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(headerBox.x + headerBox.width * 0.45 - 32, headerBox.y + headerBox.height / 2 - 24, { steps: 6 });
  await page.mouse.up();
  const afterDrag = await assistant.boundingBox();
  assert.ok(afterDrag);
  assert.ok(afterDrag.x < afterWestResize.x - 20 && afterDrag.y < afterWestResize.y - 15, "Assistant header should drag the panel");

  await page.setViewportSize({ width: 960, height: 680 });
  await page.waitForTimeout(100);
  const compactAssistant = await assistant.boundingBox();
  assert.ok(compactAssistant);
  assert.ok(compactAssistant.x >= 12 && compactAssistant.y >= 12);
  assert.ok(compactAssistant.x + compactAssistant.width <= 948);
  assert.ok(compactAssistant.y + compactAssistant.height <= 668);
  await page.screenshot({
    animations: "disabled",
    path: path.join(outDir, "04-min-window-ai.png")
  });
  await assistant.getByRole("button", { name: "关闭与笔记对话", exact: true }).click();
  await page.evaluate(() => {
    delete window.mathNotes;
  });

  await page.getByRole("button", { name: "笔记目录", exact: true }).first().click();
  await page.getByTestId("notebook-drawer").getByRole("button", { name: "打开 Notebooks", exact: true }).click();
  const compactLibrary = page.getByRole("dialog", { name: "打开 Notebooks" });
  await compactLibrary.waitFor({ state: "visible" });
  const compactLibraryBox = await compactLibrary.boundingBox();
  assert.ok(compactLibraryBox);
  assert.ok(compactLibraryBox.x >= 8 && compactLibraryBox.y >= 8);
  assert.ok(compactLibraryBox.x + compactLibraryBox.width <= 952);
  assert.ok(compactLibraryBox.y + compactLibraryBox.height <= 672);
  await page.screenshot({
    animations: "disabled",
    path: path.join(outDir, "05-min-window-notebook-browser.png")
  });

  await compactLibrary.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "笔记目录", exact: true }).first().click();
  await page.getByTestId("notebook-drawer").getByRole("button", { name: "设置", exact: true }).click();
  const compactSettings = page.getByRole("dialog", { name: "设置" });
  await compactSettings.waitFor({ state: "visible" });
  await compactSettings.locator(".typography-section").scrollIntoViewIfNeeded();
  const compactSettingsBox = await compactSettings.boundingBox();
  assert.ok(compactSettingsBox);
  assert.ok(compactSettingsBox.x >= 8 && compactSettingsBox.y >= 8);
  assert.ok(compactSettingsBox.x + compactSettingsBox.width <= 952);
  assert.ok(compactSettingsBox.y + compactSettingsBox.height <= 672);
  assert.equal(await compactSettings.getByRole("button", { name: "一键应用", exact: true }).isVisible(), true);
  assert.doesNotMatch(await compactSettings.innerText(), /诊断与自检|选择自检图片/);
  await page.screenshot({
    animations: "disabled",
    path: path.join(outDir, "06-min-window-settings.png")
  });

  assert.deepEqual(rendererErrors, [], `Renderer errors: ${rendererErrors.join("\n")}`);
  console.log(`visual output: ${outDir}`);
  console.log("desktop minimal library visual smoke passed");
} finally {
  await browser.close();
}
