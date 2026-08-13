import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const notesRoot = await mkdtemp(path.join(tmpdir(), "mathnotes-electron-smoke-"));
const userDataDir = path.join(notesRoot, "user-data");
const importImagePath = path.join(notesRoot, "local-blackboard.png");
const embeddedImagePath = path.join(notesRoot, "embedded-diagram.png");
const importPdfPath = path.join(notesRoot, "lecture-handout.pdf");
const annotatedPngDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const expectedMissingAssetFileName = "missing-smoke-image.png";
const outDir = path.join(projectRoot, "output/playwright");
const rendererDiagnostics = { console: [], resources: [] };
let app;
let firstIngestIdentity;
let blockedPortServer;

try {
  await mkdir(outDir, { recursive: true });
  await writeFile(importImagePath, Buffer.from("electron smoke local image"));
  await writeFile(embeddedImagePath, Buffer.from("electron smoke embedded image"));
  await writeFile(importPdfPath, createMinimalPdf());
  app = await electron.launch({
    args: [path.join(projectRoot, "apps/windows/electron-dist/main.cjs"), `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env: {
      ...process.env,
      MATHNOTES_ROOT: notesRoot,
      MATHNOTES_DEV_SERVER: "http://127.0.0.1:9"
    }
  });

  const page = await app.firstWindow();
  observeRendererDiagnostics(page, rendererDiagnostics);

  try {
    await page.waitForSelector("[data-testid='session-source-editor'] .cm-editor", { timeout: 30_000 });
  } catch (error) {
    await page.screenshot({ path: path.join(outDir, "electron-app-smoke-failure.png"), fullPage: false });
    const bodyText = await page.locator("body").innerText().catch(() => "");
    throw new Error(`Electron app did not render. url=${page.url()} body=${bodyText.slice(0, 500)}`, { cause: error });
  }

  assert.ok(page.url().startsWith("file://"), `Electron validation should load built dist, got ${page.url()}`);

  await page.waitForFunction(
    () => document.querySelector("[data-testid='preview-pane']")?.textContent?.includes("泛函分析 第 3 讲"),
    undefined,
    { timeout: 30_000 }
  );
  const previewText = await page.getByTestId("preview-pane").innerText();
  assert.match(previewText, /泛函分析 第 3 讲/);
  assert.match(previewText, /推导片段|OCR 草稿/);
  assert.doesNotMatch(previewText, /lock:start|lock:end/);

  const blockCount = await page.locator(".render-block").count();
  assert.ok(blockCount >= 4, `Electron default session should render enough demo blocks, got ${blockCount}`);

  const sourceEditorText = await page.getByTestId("session-source-editor").innerText();
  assert.doesNotMatch(sourceEditorText, /sample-ocr|sample-pdf/, "Electron source editor must not stay on browser fallback sample data");
  assert.match(sourceEditorText, /block: 0003|block: 0004/);
  assert.match(sourceEditorText, /photo_2026-06-26_001\.png/);
  assert.doesNotMatch(sourceEditorText, /\|\s*path:\s*blocks\//);
  assert.doesNotMatch(sourceEditorText, /\|\s*kind:\s*[a-z_]+/);
  assert.ok(await page.locator("[data-testid='source-block']").count() >= 4, "Electron source editor should render one shell per Markdown block");
  const firstBlockBodyText = await page.locator("[data-testid='source-block-editor'] .cm-editor").first().innerText();
  assert.doesNotMatch(firstBlockBodyText, /source:|block:/, "Electron block CodeMirror body should not include source headers");
  await page.locator("[data-testid='source-block-header']", { hasText: /photo_2026-06-26_001\.png/ }).first().click();
  await assertVisible(page, "[data-testid='asset-preview']");
  assert.match(await page.getByTestId("asset-preview").innerText(), /素材预览/);
  const previewImage = page.getByRole("img", { name: /photo_2026-06-26_001\.png/ });
  await previewImage.waitFor({ state: "attached", timeout: 3000 });
  await page.waitForFunction(
    () => {
      const image = document.querySelector("[data-testid='asset-preview'] img");
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    },
    undefined,
    { timeout: 3000 }
  );
  await page.getByRole("button", { name: "关闭素材预览", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("[data-testid='asset-preview']"), undefined, { timeout: 3000 });
  assert.equal(await page.evaluate(() => typeof window.mathNotes?.setMarkdownBlockLock), "function");
  assert.equal(await page.evaluate(() => typeof window.mathNotes?.windowControl), "function");
  assert.equal(await page.evaluate(() => typeof window.mathNotes?.pickDirectory), "function");
  assert.equal(await page.evaluate(() => typeof window.mathNotes?.createNotesBackup), "function");
  assert.equal(await page.evaluate(() => typeof window.mathNotes?.pickLocalPdf), "function");
  assert.equal(await page.evaluate(() => typeof window.mathNotes?.stagePdfRecognitionPage), "function");
  assert.equal(await page.evaluate(() => typeof window.mathNotes?.startPdfRecognitionBatch), "function");
  assert.equal(await page.evaluate(() => typeof window.mathNotes?.loadIngestServerState), "function");
  assert.equal(await page.evaluate(() => typeof window.mathNotes?.runAssistantTask), "function");
  assert.equal(await page.evaluate(() => typeof window.mathNotes?.cancelAssistantTask), "function");
  assert.ok(await page.locator(".session-source-editor .cm-foldGutter").count(), "Source block editors should show Markdown fold gutters");

  console.log("[electron smoke] configurable source-to-preview shortcut follows the active CodeMirror line");
  await page.getByRole("button", { name: "笔记目录", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await assertVisible(page, "[data-testid='settings-modal']");
  const previewShortcutInput = page.getByTestId("preview-follow-shortcut-input");
  await previewShortcutInput.scrollIntoViewIfNeeded();
  await previewShortcutInput.focus();
  await page.keyboard.press("F8");
  assert.equal(await previewShortcutInput.inputValue(), "F8");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.waitForFunction(async () => (await window.mathNotes.loadUserSettings()).previewFollowShortcut === "F8");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();

  const lastPreviewBlockId = await page.evaluate(async () => {
    const markdown = Array.from({ length: 120 }, (_, index) => `## 导航测试 ${index + 1}\n\n第 ${index + 1} 行内容`).join("\n\n");
    const document = await window.mathNotes.createMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      markdown,
      sourceName: "preview-navigation-smoke.md"
    });
    return document.editableBlocks.at(-1)?.id ?? null;
  });
  assert.ok(lastPreviewBlockId, "Shortcut smoke requires a preview block linked to source");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(`[data-testid='source-block'][data-block-id='${lastPreviewBlockId}'] .cm-content`, { timeout: 8000 });
  const sourceForLastPreview = page.locator(`[data-testid='source-block'][data-block-id='${lastPreviewBlockId}'] .cm-content`);
  await sourceForLastPreview.scrollIntoViewIfNeeded();
  await sourceForLastPreview.focus();
  await page.keyboard.press("Control+End");
  await page.locator(".preview-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.keyboard.press("F8");
  await page.waitForFunction(
    (blockId) => document.querySelector(`[data-testid='render-block'][data-block-id='${blockId}'][data-preview-locating='true']`),
    lastPreviewBlockId,
    { timeout: 5000 }
  );
  const followedPreviewState = await page.locator(".preview-scroll").evaluate((element) => {
    const target = element.querySelector("[data-preview-locating='true']");
    if (!(target instanceof HTMLElement)) return null;
    const scrollerRect = element.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return {
      scrollTop: element.scrollTop,
      targetBottom: targetRect.bottom - scrollerRect.top,
      targetTop: targetRect.top - scrollerRect.top,
      viewportHeight: element.clientHeight
    };
  });
  assert.ok(followedPreviewState, "Shortcut should expose a located preview target");
  assert.ok(followedPreviewState.scrollTop > 0, `Shortcut should move the preview: ${JSON.stringify(followedPreviewState)}`);
  assert.ok(
    followedPreviewState.targetBottom > 0 && followedPreviewState.targetTop < followedPreviewState.viewportHeight,
    `Shortcut target must be visible: ${JSON.stringify(followedPreviewState)}`
  );

  console.log("[electron smoke] top preview scrollbar owns the right gutter instead of moving the window");
  await page.locator(".preview-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  const previewScrollbarGeometry = await page.locator(".preview-scroll").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      x: rect.right - 6,
      y: rect.top + 18,
      dragY: rect.top + Math.min(220, rect.height * 0.35)
    };
  });
  const windowBoundsBeforeScrollbarDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  await page.mouse.move(previewScrollbarGeometry.x, previewScrollbarGeometry.y);
  await page.waitForTimeout(80);
  await page.mouse.down();
  await page.mouse.move(previewScrollbarGeometry.x, previewScrollbarGeometry.dragY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const previewScrollTopAfterThumbDrag = await page.locator(".preview-scroll").evaluate((element) => element.scrollTop);
  const windowBoundsAfterScrollbarDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  assert.ok(
    previewScrollTopAfterThumbDrag > 0,
    `Top scrollbar thumb should move preview content: ${JSON.stringify({ previewScrollTopAfterThumbDrag, previewScrollbarGeometry })}`
  );
  assert.deepEqual(windowBoundsAfterScrollbarDrag, windowBoundsBeforeScrollbarDrag, "Dragging the top preview scrollbar must not move the window");

  console.log("[electron smoke] context menu inserts exactly after the right-clicked block");
  const sourceBlockIdsBeforeInsert = await page.locator("[data-testid='source-block']").evaluateAll((blocks) =>
    blocks.map((block) => block.getAttribute("data-block-id"))
  );
  const insertionAnchorId = sourceBlockIdsBeforeInsert[1];
  const insertionSuccessorId = sourceBlockIdsBeforeInsert[2];
  assert.ok(insertionAnchorId && insertionSuccessorId, "Context insertion smoke requires an anchor and original successor");
  const insertionAnchor = page.locator(`[data-testid='source-block'][data-block-id='${insertionAnchorId}']`);
  await insertionAnchor.locator(".cm-content").click({ button: "right", position: { x: 24, y: 18 } });
  await assertVisible(page, "[data-testid='editor-context-menu']");
  await page.screenshot({ path: path.join(outDir, "electron-context-insert-menu.png"), fullPage: false });
  await page.getByRole("button", { name: "在下方新建文本块", exact: true }).click();
  await page.waitForFunction(
    ({ anchorId, successorId, previousLength }) => {
      const ids = [...document.querySelectorAll("[data-testid='source-block']")]
        .map((block) => block.getAttribute("data-block-id"));
      const anchorIndex = ids.indexOf(anchorId);
      return ids.length === previousLength + 1 && anchorIndex >= 0 && ids[anchorIndex + 2] === successorId;
    },
    { anchorId: insertionAnchorId, successorId: insertionSuccessorId, previousLength: sourceBlockIdsBeforeInsert.length },
    { timeout: 5000 }
  );
  const sourceBlockIdsAfterInsert = await page.locator("[data-testid='source-block']").evaluateAll((blocks) =>
    blocks.map((block) => block.getAttribute("data-block-id"))
  );
  const insertionAnchorIndex = sourceBlockIdsAfterInsert.indexOf(insertionAnchorId);
  const insertedBlockId = sourceBlockIdsAfterInsert[insertionAnchorIndex + 1];
  assert.ok(insertedBlockId && !sourceBlockIdsBeforeInsert.includes(insertedBlockId), "A new block must occupy the exact slot after the anchor");
  assert.equal(sourceBlockIdsAfterInsert[insertionAnchorIndex + 2], insertionSuccessorId, "The original successor must remain after the inserted block");

  console.log("[electron smoke] AI selection edit previews, explicitly applies, and participates in undo");
  const selectionTarget = page.locator("[data-testid='source-block']").first();
  const selectionTargetId = await selectionTarget.getAttribute("data-block-id");
  assert.ok(selectionTargetId, "Selection edit smoke requires a concrete block id");
  const selectionEditor = selectionTarget.locator(".cm-content");
  await selectionEditor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");
  const selectedHeading = (await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim();
  assert.match(selectedHeading, /^## 泛函分析 第 3 讲$/, "The real editor must expose the exact selected heading");
  await selectionEditor.click({ button: "right", position: { x: 48, y: 10 } });
  await page.getByRole("button", { name: "用 AI 修改选中文字", exact: true }).click();
  const selectionDialog = page.getByRole("dialog", { name: "AI 修改选中文字" });
  await selectionDialog.waitFor({ state: "visible", timeout: 3000 });
  assert.match(await selectionDialog.innerText(), /原选区[\s\S]*## 泛函分析 第 3 讲/);
  assert.match(await selectionDialog.innerText(), /此时不会修改笔记/);
  await selectionDialog.getByPlaceholder("例如：修正语病，但保留公式和原意").fill("把标题改得更清楚，保留数学含义");
  await selectionDialog.getByRole("button", { name: "生成修改候选", exact: true }).click();
  await selectionDialog.getByText("Mock 学习助手", { exact: false }).waitFor({ state: "visible", timeout: 5000 });
  assert.doesNotMatch(await selectionEditor.innerText(), /Mock 学习助手/, "Generating a candidate must not mutate the editor");
  await page.screenshot({ path: path.join(outDir, "electron-selection-edit-candidate.png"), fullPage: false });
  await selectionDialog.getByRole("button", { name: "应用修改", exact: true }).click();
  await selectionDialog.waitFor({ state: "detached", timeout: 5000 });
  await page.waitForFunction(
    (blockId) => document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}'] .cm-content`)?.textContent?.includes("Mock 学习助手"),
    selectionTargetId,
    { timeout: 5000 }
  );
  await selectionEditor.click();
  await page.keyboard.press("Control+z");
  await page.waitForFunction(
    (blockId) => {
      const text = document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}'] .cm-content`)?.textContent ?? "";
      return text.includes("泛函分析 第 3 讲") && !text.includes("Mock 学习助手");
    },
    selectionTargetId,
    { timeout: 5000 }
  );

  console.log("[electron smoke] whole-block lock disables AI selection editing");
  await selectionTarget.getByTestId("source-block-header").click();
  await page.getByTestId("block-lock-button").click();
  await page.waitForFunction(
    async (blockId) => (await window.mathNotes.loadCurrentSession()).sourceDocument.markdownBlocks
      .find((block) => block.blockId === blockId)?.locked === true,
    selectionTargetId,
    { timeout: 5000 }
  );
  await page.waitForFunction(
    (blockId) => document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}']`)?.getAttribute("data-locked") === "true",
    selectionTargetId,
    { timeout: 5000 }
  );
  await selectionTarget.getByTestId("source-block-header").click();
  await selectionEditor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");
  await selectionEditor.click({ button: "right", position: { x: 48, y: 10 } });
  assert.equal(
    await page.getByRole("button", { name: "用 AI 修改选中文字", exact: true }).isDisabled(),
    true,
    "A locked block must disable AI selection editing in the real context menu"
  );
  await page.keyboard.press("Escape");
  await selectionTarget.getByTestId("source-block-header").click();
  await page.getByTestId("block-lock-button").click();
  await page.waitForFunction(
    async (blockId) => (await window.mathNotes.loadCurrentSession()).sourceDocument.markdownBlocks
      .find((block) => block.blockId === blockId)?.locked === false,
    selectionTargetId,
    { timeout: 5000 }
  );
  await page.waitForFunction(
    (blockId) => document.querySelector(`[data-testid='source-block'][data-block-id='${blockId}']`)?.getAttribute("data-locked") === "false",
    selectionTargetId,
    { timeout: 5000 }
  );

  console.log("[electron smoke] stale proposal keeps its preview and reports an apply conflict");
  await selectionEditor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Shift+End");
  await selectionEditor.click({ button: "right", position: { x: 48, y: 10 } });
  await page.getByRole("button", { name: "用 AI 修改选中文字", exact: true }).click();
  await selectionDialog.getByPlaceholder("例如：修正语病，但保留公式和原意").fill("生成一个会发生版本冲突的候选");
  await selectionDialog.getByRole("button", { name: "生成修改候选", exact: true }).click();
  await selectionDialog.getByText("Mock 学习助手", { exact: false }).waitFor({ state: "visible", timeout: 5000 });
  await page.evaluate(async (blockId) => {
    const current = await window.mathNotes.loadCurrentSession();
    const block = current.sourceDocument.markdownBlocks.find((candidate) => candidate.blockId === blockId);
    if (!block) throw new Error(`Unable to find block ${blockId} for conflict injection`);
    await window.mathNotes.saveMarkdownBlock({
      notebookId: current.notebookId,
      sessionId: current.sessionId,
      blockId,
      markdown: `${block.markdown}\n\n外部并发修改`
    });
  }, selectionTargetId);
  await selectionDialog.getByRole("button", { name: "应用修改", exact: true }).click();
  const conflictAlert = selectionDialog.getByRole("alert");
  await conflictAlert.waitFor({ state: "visible", timeout: 5000 });
  assert.match(await conflictAlert.innerText(), /应用冲突/);
  assert.match(await selectionDialog.innerText(), /Mock 学习助手/, "A conflict must retain the candidate preview");
  await selectionDialog.getByRole("button", { name: "取消", exact: true }).click();
  await selectionDialog.waitFor({ state: "detached", timeout: 3000 });

  console.log("[electron smoke] assistant uses an independent native resizable window");
  const assistantWindowOpened = app.waitForEvent("window");
  await page.getByRole("button", { name: "AI 学习助手", exact: true }).click();
  const assistantPage = await assistantWindowOpened;
  await assistantPage.waitForSelector("[data-testid='assistant-workspace']", { timeout: 5000 });
  const detachedBounds = await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const main = windows.sort((a, b) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0];
    const assistant = windows.find((candidate) => candidate.getTitle().includes("学习助手"));
    if (!assistant) throw new Error("assistant BrowserWindow missing");
    const mainBounds = main.getBounds();
    assistant.setBounds({ x: mainBounds.x + mainBounds.width + 24, y: mainBounds.y + 40, width: 560, height: 720 });
    return { main: mainBounds, assistant: assistant.getBounds(), resizable: assistant.isResizable() };
  });
  assert.equal(detachedBounds.resizable, true, "Assistant window must use native resizing");
  assert.ok(
    detachedBounds.assistant.x >= detachedBounds.main.x + detachedBounds.main.width,
    `Assistant window must be movable outside the main window: ${JSON.stringify(detachedBounds)}`
  );
  const assistantClosed = assistantPage.waitForEvent("close");
  await assistantPage.getByRole("button", { name: "关闭 AI 学习助手", exact: true }).click();
  await assistantClosed;

  console.log("[electron smoke] recognition status stays in the unified task center");
  const recognitionAuxiliaryTitles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .map((candidate) => candidate.getTitle())
    .filter((title) => title.includes("识别动态") || title.includes("识别历史")));
  assert.deepEqual(recognitionAuxiliaryTitles, [], "Recognition must not create detached HUD or history windows");

  console.log("[electron smoke] receiver auto-start and notebook drawer scroll contract");
  const ingestState = await page.evaluate(() => window.mathNotes.loadIngestServerState());
  assert.equal(ingestState.running, true, `Receiver should be ready before the renderer loads: ${ingestState.lastError ?? "unknown"}`);
  assert.ok(ingestState.port && ingestState.port > 0, "Auto-started receiver should expose its actual port");
  assert.ok(ingestState.token && ingestState.token.length >= 32, "Auto-started receiver should expose a durable pairing token");
  firstIngestIdentity = { port: ingestState.port, token: ingestState.token };
  const health = await fetch(`http://127.0.0.1:${ingestState.port}/api/v1/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  const drawerOverflow = await page.locator(".left-drawer").evaluate((element) => getComputedStyle(element).overflowY);
  assert.equal(drawerOverflow, "auto", "Notebook/session drawer must remain scrollable when its list grows");

  const importResult = await page.evaluate((filePath) =>
    window.mathNotes.importLocalPhoto({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      filePath
    }),
    importImagePath
  );
  assert.equal(importResult.cancelled, false);
  assert.equal(importResult.duplicate, false);
  assert.equal(importResult.recognitionStatus, "succeeded");
  assert.match(importResult.assetPath, /assets\/photos\/local-blackboard\.png/);
  await page.evaluate(() => window.mathNotes.loadCurrentSession());
  await page.waitForFunction(() => document.querySelector("[data-testid='preview-pane']")?.textContent?.includes("Mock 识别占位"), undefined, {
    timeout: 3000
  });
  const tasksAfterImport = await page.evaluate(() =>
    window.mathNotes.loadRecognitionTasks({
      notebookId: "functional_analysis",
      sessionId: "lecture"
    })
  );
  assert.equal(tasksAfterImport[0].recognitionStatus, "succeeded");
  assert.match(tasksAfterImport[0].fileName, /local-blackboard\.png/);
  assert.ok(tasksAfterImport[0].warnings?.includes("mock_provider_used"), "Mock provider warning should be visible in task data");
  const exportedAfterImport = await page.evaluate(() =>
    window.mathNotes.exportCurrentSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      includeMetadataComments: false
    })
  );
  const exportedMarkdown = await readFile(exportedAfterImport.outPath, "utf8");
  assert.match(exportedMarkdown, /Mock 识别占位/);
  assert.doesNotMatch(exportedMarkdown, /\\\[/);

  console.log("[electron smoke] learning assistant remark promotion gate");
  const documentBeforeAssistant = await page.evaluate(() => window.mathNotes.loadCurrentSession());
  const markdownBeforeAssistant = Object.fromEntries(
    documentBeforeAssistant.editableBlocks.map((block) => [block.id, block.markdown])
  );
  const assistantResult = await page.evaluate(() =>
    window.mathNotes.runAssistantTask({
      taskId: "assistant_electron_smoke",
      notebookId: "functional_analysis",
      sessionId: "lecture",
      scope: "session",
      mode: "explain",
      question: "这段内容的主线是什么？",
      confirmedExternalCall: false
    })
  );
  assert.equal(assistantResult.status, "succeeded");
  assert.equal(assistantResult.providerName, "mock");
  assert.ok(assistantResult.remarkId, "Learning assistant should persist a sidecar remark");
  const documentAfterAssistant = await page.evaluate(() => window.mathNotes.loadCurrentSession());
  assert.equal(
    documentAfterAssistant.editableBlocks.find((block) => block.source === "ai_explanation"),
    undefined,
    "Learning assistant must not append a note block before explicit promotion"
  );
  const assistantRemarks = await page.evaluate(() =>
    window.mathNotes.loadAssistantRemarks({ notebookId: "functional_analysis", sessionId: "lecture" })
  );
  const assistantRemark = assistantRemarks.find((remark) => remark.id === assistantResult.remarkId);
  assert.ok(assistantRemark, "Learning assistant sidecar remark should be readable");
  assert.match(assistantRemark.markdown, /Mock 学习助手/);
  assert.match(assistantRemark.markdown, /\[mock_assistant_used\]/);
  for (const [blockId, markdown] of Object.entries(markdownBeforeAssistant)) {
    assert.equal(
      documentAfterAssistant.editableBlocks.find((block) => block.id === blockId)?.markdown,
      markdown,
      `Learning assistant must not rewrite source block ${blockId}`
    );
  }
  const exportedAfterAssistant = await page.evaluate(() =>
    window.mathNotes.exportCurrentSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      includeMetadataComments: false
    })
  );
  assert.doesNotMatch(await readFile(exportedAfterAssistant.outPath, "utf8"), /Mock 学习助手/);
  const documentAfterPromotion = await page.evaluate((remarkId) =>
    window.mathNotes.promoteAssistantRemark({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      remarkId
    }),
    assistantResult.remarkId
  );
  const assistantBlock = documentAfterPromotion.editableBlocks.find((block) => block.source === "ai_explanation");
  assert.ok(assistantBlock, "Explicit promotion should append an independent ai_explanation block");
  assert.match(assistantBlock.markdown, /Mock 学习助手/);
  const exportedAfterPromotion = await page.evaluate(() =>
    window.mathNotes.exportCurrentSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      includeMetadataComments: false
    })
  );
  assert.match(await readFile(exportedAfterPromotion.outPath, "utf8"), /Mock 学习助手/);

  console.log("[electron smoke] search popover locates source");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await assertVisible(page, "[data-testid='search-popover']");
  await page.getByPlaceholder("搜索笔记、源码、公式或命令").fill("Mock 识别占位");
  const searchResult = page.locator("[data-testid='search-popover'] button", { hasText: "Mock 识别占位" }).first();
  await searchResult.waitFor({ state: "visible", timeout: 3000 });
  await searchResult.click();
  await page.waitForFunction(() => !document.querySelector("[data-testid='search-popover']"), undefined, { timeout: 3000 });
  await page.waitForFunction(
    () => document.querySelector("[data-testid='source-block'].locating")?.textContent?.includes("Mock 识别占位"),
    undefined,
    { timeout: 3000 }
  );

  console.log("[electron smoke] new text block quick action");
  const sourceBlockCountBeforeCreate = await page.locator("[data-testid='source-block']").count();
  await page.getByRole("button", { name: "添加内容", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".source-create-menu")?.classList.contains("open"), undefined, {
    timeout: 3000
  });
  const createTextBlockAction = page.locator(".source-create-options button", { hasText: "新建文本块" });
  await createTextBlockAction.waitFor({ state: "visible", timeout: 3000 });
  await createTextBlockAction.click();
  await page.waitForFunction(
    (before) => document.querySelectorAll("[data-testid='source-block']").length > before,
    sourceBlockCountBeforeCreate,
    { timeout: 5000 }
  );
  await page.waitForFunction(
    () => document.querySelector("[data-testid='session-source-editor']")?.textContent?.includes("在这里继续整理笔记。"),
    undefined,
    { timeout: 3000 }
  );

  console.log("[electron smoke] embedded image import api");
  const embeddedImportResult = await page.evaluate(
    (filePath) =>
      window.mathNotes.importEmbeddedImage({
        notebookId: "functional_analysis",
        sessionId: "lecture",
        filePath
      }),
    embeddedImagePath
  );
  assert.equal(embeddedImportResult.cancelled, false);
  assert.match(embeddedImportResult.assetPath, /assets\/embedded\/embedded-diagram\.png/);
  assert.match(embeddedImportResult.markdown, /!\[图\]\(\.\.\/assets\/embedded\/embedded-diagram\.png\)/);

  console.log("[electron smoke] annotated image pick and save api");
  const pickedAnnotationImage = await page.evaluate(
    (filePath) => window.mathNotes.pickImageForAnnotation({ filePath }),
    embeddedImagePath
  );
  assert.equal(pickedAnnotationImage.cancelled, false);
  assert.equal(pickedAnnotationImage.fileName, "embedded-diagram.png");
  assert.match(pickedAnnotationImage.previewDataUrl, /^data:image\/png;base64,/);
  const annotatedImageResult = await page.evaluate(
    ({ sourcePath, pngDataUrl }) =>
      window.mathNotes.saveAnnotatedImage({
        notebookId: "functional_analysis",
        sessionId: "lecture",
        fileName: "annotated diagram.jpg",
        sourcePath,
        pngDataUrl,
        operations: [{ type: "confirm" }]
      }),
    { sourcePath: pickedAnnotationImage.sourcePath, pngDataUrl: annotatedPngDataUrl }
  );
  assert.match(annotatedImageResult.assetPath, /assets\/embedded\/annotated_diagram\.png/);
  assert.match(annotatedImageResult.metadataPath, /assets\/embedded\/annotated_diagram\.annotation\.json/);
  assert.match(annotatedImageResult.markdown, /!\[图\]\(\.\.\/assets\/embedded\/annotated_diagram\.png\)/);
  const annotationMetadataPath = path.join(notesRoot, "notebooks", "functional_analysis", "sessions", "lecture", annotatedImageResult.metadataPath);
  const annotationMetadata = JSON.parse(await readFile(annotationMetadataPath, "utf8"));
  assert.equal(annotationMetadata.sourceAsset, "embedded-diagram.png");
  assert.match(annotationMetadata.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(annotationMetadata.operations, [{ type: "confirm" }]);

  console.log("[electron smoke] notation profile save and prompt preview");
  const notationConfig = {
    schemaVersion: "nh1-v1",
    revision: 1,
    profiles: [{
      id: "profile_smoke",
      name: "泛函分析",
      description: "Electron smoke",
      enabled: true,
      status: "active",
      priority: 10,
      version: 1,
      rules: [{
        id: "rule_smoke",
        kind: "symbol",
        pattern: "X_+",
        meaning: "稳定子空间",
        aliases: [],
        keywords: ["稳定"],
        enabled: true,
        status: "approved",
        version: 1,
        source: { type: "user" },
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
        approvedAt: "2026-07-15T00:00:00.000Z"
      }],
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    }]
  };
  const savedNotationConfig = await page.evaluate((config) => window.mathNotes.saveNotationProfileConfig(config), notationConfig);
  assert.equal(savedNotationConfig.profiles[0].rules[0].status, "approved");
  const loadedNotationConfig = await page.evaluate(() => window.mathNotes.loadNotationProfileConfig());
  assert.equal(loadedNotationConfig.profiles[0].rules[0].pattern, "X_+");
  const notationPreview = await page.evaluate(() => window.mathNotes.previewNotationPrompt({ query: "X_+ 稳定子空间" }));
  assert.equal(notationPreview.selection.rules.length, 1);
  assert.equal(notationPreview.selection.conflicts.length, 0);
  assert.match(notationPreview.fullPrompt, /图片证据优先/);
  assert.match(notationPreview.selection.selectionHash, /^[a-f0-9]{64}$/);

  console.log("[electron smoke] safe user diagnostic self-test and redacted report");
  const providerSelfTest = await page.evaluate(
    (imagePath) => window.mathNotes.runProviderSelfTest({ imagePath, confirmedExternalCall: false }),
    embeddedImagePath
  );
  assert.equal(providerSelfTest.providerId, "mock");
  assert.equal(providerSelfTest.status, "succeeded");
  const diagnosticReportPath = path.join(notesRoot, "MathNotes-diagnostics-smoke.json");
  const diagnosticExport = await page.evaluate(
    (outputPath) => window.mathNotes.exportUserDiagnosticReport({ outputPath }),
    diagnosticReportPath
  );
  assert.equal(diagnosticExport.cancelled, false);
  const diagnosticText = await readFile(diagnosticReportPath, "utf8");
  const diagnosticReport = JSON.parse(diagnosticText);
  assert.equal(diagnosticReport.provider.id, "mock");
  assert.equal(diagnosticReport.latestSelfTest.status, "succeeded");
  assert.doesNotMatch(diagnosticText, /diagnostic-secret-sentinel/);
  assert.doesNotMatch(diagnosticText, new RegExp(firstIngestIdentity.token));
  assert.doesNotMatch(diagnosticText, /embedded-diagram\.png/);
  assert.doesNotMatch(diagnosticText, /reportPath|exportPath|fullPrompt|rawResponse/);

  console.log("[electron smoke] read-only PDF import and canvas rendering");
  const pickedPdf = await page.evaluate((filePath) => window.mathNotes.pickLocalPdf({ filePath }), importPdfPath);
  assert.equal(pickedPdf.cancelled, false);
  assert.equal(pickedPdf.pageCount, 1);
  const importedPdf = await page.evaluate(
    (sourcePath) =>
      window.mathNotes.importLocalPdf({
        notebookId: "functional_analysis",
        sessionId: "lecture",
        sourcePath,
        mode: "read_only",
        destination: "current_session"
      }),
    importPdfPath
  );
  assert.equal(importedPdf.pageCount, 1);
  assert.equal(importedPdf.recognitionQueued, false);
  assert.match(importedPdf.assetPath, /assets\/pdfs\/lecture-handout\.pdf/);
  await page.evaluate(() => window.mathNotes.loadCurrentSession());
  await page.reload();
  await page.waitForSelector(".pdf-page canvas", { state: "visible", timeout: 8000 });
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector(".pdf-page canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 0 && canvas.height > 0;
    },
    undefined,
    { timeout: 8000 }
  );

  console.log("[electron smoke] per-page PDF recognition pipeline");
  const renderedPdfPage = await page.evaluate(() => {
    const canvas = document.querySelector(".pdf-page canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("PDF canvas missing");
    return canvas.toDataURL("image/png");
  });
  const stagedPdfPage = await page.evaluate(
    ({ pdfBlockId, pngDataUrl }) =>
      window.mathNotes.stagePdfRecognitionPage({
        notebookId: "functional_analysis",
        sessionId: "lecture",
        pdfBlockId,
        pageNumber: 1,
        pngDataUrl
      }),
    { pdfBlockId: importedPdf.pdfBlockId, pngDataUrl: renderedPdfPage }
  );
  assert.equal(stagedPdfPage.pageNumber, 1);
  assert.match(stagedPdfPage.assetPath, /assets\/pdf-pages\/.+\/page-0001\.png/);
  const pdfBatch = await page.evaluate(
    ({ pdfBlockId, pdfAssetPath, stagedPage }) =>
      window.mathNotes.startPdfRecognitionBatch({
        notebookId: "functional_analysis",
        sessionId: "lecture",
        pdfBlockId,
        pdfAssetPath,
        pageCount: 1,
        concurrency: 2,
        pages: [stagedPage]
      }),
    { pdfBlockId: importedPdf.pdfBlockId, pdfAssetPath: importedPdf.assetPath, stagedPage: stagedPdfPage }
  );
  assert.equal(pdfBatch.jobIds.length, 1);
  await page.waitForFunction(
    async (jobId) => {
      const tasks = await window.mathNotes.loadRecognitionTasks({ notebookId: "functional_analysis", sessionId: "lecture" });
      return tasks.some((task) => task.recognitionJobId === jobId && task.recognitionStatus === "succeeded" && task.pageNumber === 1);
    },
    pdfBatch.jobIds[0],
    { timeout: 8000 }
  );
  const pdfRecognitionDocument = await page.evaluate(() => window.mathNotes.loadCurrentSession());
  assert.ok(
    pdfRecognitionDocument.sourceDocument.markdownBlocks.some(
      (block) => block.source === "ai_transcription" && block.sourceAssetPath === "assets/pdfs/lecture-handout.pdf"
    )
  );

  await page.locator(".session-source-editor .cm-line", { hasText: "在这里继续整理笔记。" }).last().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(
    `\n\n${embeddedImportResult.markdown}\n\n## Share package smoke\n\n![missing smoke asset](../assets/embedded/${expectedMissingAssetFileName})`
  );
  await page.waitForFunction(
    () => Boolean(document.querySelector("[data-testid='preview-pane'] img[src*='embedded-diagram.png']")),
    undefined,
    { timeout: 3000 }
  );

  console.log("[electron smoke] share package export popover");
  await page.getByRole("button", { name: "导出 Markdown", exact: true }).click();
  await assertVisible(page, "[data-testid='export-popover']");
  await page.getByRole("button", { name: "导出分享包", exact: true }).click();
  await page.waitForFunction(
    () => {
      const text = document.querySelector("[data-testid='export-result']")?.textContent ?? "";
      return text.includes("分享包：") && text.includes("已复制 1 个素材") && text.includes("缺失 1 个素材");
    },
    undefined,
    { timeout: 5000 }
  );
  await page.getByRole("button", { name: "查看缺失素材", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("[data-testid='export-result']")?.textContent?.includes("assets/embedded/missing-smoke-image.png"),
    undefined,
    { timeout: 3000 }
  );
  await page.getByRole("button", { name: "关闭导出", exact: true }).click();

  const nativeDragRegions = page.locator(".window-drag-region");
  assert.equal(await nativeDragRegions.count(), 2, "Top edge should have source and preview drag segments");
  const nativeDragContract = await nativeDragRegions.first().evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      appRegion: style.getPropertyValue("-webkit-app-region") || style.getPropertyValue("app-region"),
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth
    };
  });
  assert.equal(nativeDragContract.appRegion.trim(), "no-drag", "Top strip should receive pointer events for throttled window dragging");
  assert.equal(nativeDragContract.top, 0);
  assert.ok(nativeDragContract.left >= 0);
  assert.ok(nativeDragContract.width > 0, "Native drag segment should have usable width");
  assert.ok(nativeDragContract.height >= 38 && nativeDragContract.height <= 42, "Native drag strip should expose a generous top-edge target");

  const windowBoundsBeforeDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((a, b) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0].getBounds());
  const dragStartX = Math.round(nativeDragContract.left + nativeDragContract.width / 2);
  const dragStartY = Math.round(nativeDragContract.top + nativeDragContract.height / 2);
  const sourceClickY = Math.max(2, Math.round(nativeDragContract.top + 8));
  await page.evaluate(() => {
    window.__mathNotesTopEdgeClickCount = 0;
    window.__mathNotesTopEdgePointerTrace = [];
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
      document.addEventListener(type, (event) => {
        window.__mathNotesTopEdgePointerTrace.push({
          type,
          clientX: event.clientX,
          clientY: event.clientY,
          screenX: event.screenX,
          screenY: event.screenY
        });
      }, { capture: true });
    }
    window.addEventListener(
      "mathnotes:source-top-edge-click",
      () => {
        window.__mathNotesTopEdgeClickCount += 1;
      },
      { once: true }
    );
  });
  await page.mouse.click(dragStartX, sourceClickY);
  await page.waitForTimeout(120);
  const windowBoundsAfterClick = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((a, b) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0].getBounds());
  assert.deepEqual(windowBoundsAfterClick, windowBoundsBeforeDrag, "A light top-edge click must not move the native window");
  assert.equal(
    await page.evaluate(() => window.__mathNotesTopEdgeClickCount),
    1,
    "A light source-edge click should be replayed to the editor caret layer"
  );

  await page.mouse.move(dragStartX, dragStartY);
  await page.mouse.down();
  await page.mouse.move(dragStartX + 96, dragStartY + 54, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const windowBoundsAfterDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((a, b) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0].getBounds());
  const topEdgePointerTrace = await page.evaluate(() => window.__mathNotesTopEdgePointerTrace);
  assert.ok(
    Math.abs(windowBoundsAfterDrag.x - windowBoundsBeforeDrag.x) + Math.abs(windowBoundsAfterDrag.y - windowBoundsBeforeDrag.y) > 30,
    `Electron top drag region should move the native window, before=${JSON.stringify(windowBoundsBeforeDrag)} after=${JSON.stringify(windowBoundsAfterDrag)} trace=${JSON.stringify(topEdgePointerTrace)}`
  );
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows().sort((a, b) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0].setBounds(bounds), windowBoundsBeforeDrag);

  const primaryControls = page.locator("[aria-label='Primary controls']");
  const primaryButtons = primaryControls.locator("button");
  const firstPrimaryButton = await primaryButtons.nth(0).boundingBox();
  const secondPrimaryButton = await primaryButtons.nth(1).boundingBox();
  assert.ok(firstPrimaryButton && secondPrimaryButton, "Primary toolbar buttons should be measurable");
  const toolbarGapX = Math.round(firstPrimaryButton.x + firstPrimaryButton.width + (secondPrimaryButton.x - firstPrimaryButton.x - firstPrimaryButton.width) / 2);
  const toolbarGapY = Math.round(firstPrimaryButton.y + firstPrimaryButton.height / 2);
  const boundsBeforeToolbarGapDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((a, b) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0].getBounds());
  await page.mouse.move(toolbarGapX, toolbarGapY);
  await page.mouse.down();
  await page.mouse.move(toolbarGapX + 72, toolbarGapY + 42, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(160);
  const boundsAfterToolbarGapDrag = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((a, b) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0].getBounds());
  assert.ok(
    Math.abs(boundsAfterToolbarGapDrag.x - boundsBeforeToolbarGapDrag.x) + Math.abs(boundsAfterToolbarGapDrag.y - boundsBeforeToolbarGapDrag.y) > 24,
    `Primary toolbar gap should move the native window, before=${JSON.stringify(boundsBeforeToolbarGapDrag)} after=${JSON.stringify(boundsAfterToolbarGapDrag)}`
  );
  await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows().sort((a, b) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0].setBounds(bounds), boundsBeforeToolbarGapDrag);

  const latestTaskToast = page.locator(".new-photo-toast").first();
  if (await latestTaskToast.isVisible().catch(() => false)) {
    await latestTaskToast.click();
    await page.waitForSelector("[data-testid='task-popover']", { state: "visible", timeout: 3000 });
    const latestTaskToggle = page.locator("[data-testid='task-popover'] .task-row-toggle").first();
    if (await latestTaskToggle.isVisible().catch(() => false)) {
      await latestTaskToggle.click();
      assert.equal(await latestTaskToggle.getAttribute("aria-expanded"), "true");
      await latestTaskToggle.click();
      assert.equal(await latestTaskToggle.getAttribute("aria-expanded"), "false");
    }
    await page.getByRole("button", { name: "关闭任务信息" }).click();
    await latestTaskToast.locator(".toast-close").click();
    await page.waitForFunction(() => !document.querySelector(".new-photo-toast"), undefined, { timeout: 3000 });
    assert.equal(await page.locator("[data-testid='task-popover']").isVisible().catch(() => false), false);
  }

  await page.getByTestId("session-source-editor").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.locator(".session-source-editor .cm-line", { hasText: "设 T_n 为有界线性算子" }).click();
  const activeLine = await page.locator(".session-source-editor .cm-activeLine").first().boundingBox();
  const activeGutter = await page.locator(".session-source-editor .cm-activeLineGutter").first().boundingBox();
  assert.ok(activeLine);
  assert.ok(activeGutter);
  assert.ok(
    Math.abs(activeLine.y - activeGutter.y) < 2,
    `CodeMirror line and gutter should stay aligned, got y=${activeLine.y} and gutterY=${activeGutter.y}`
  );
  await assertVisible(page, "[data-testid='block-lock-button']");
  assert.match(await page.getByTestId("block-lock-button").innerText(), /固定整块/);
  await page.getByTestId("block-lock-button").click();
  await page.waitForFunction(() => document.querySelector("[data-testid='screen-toast']")?.textContent?.includes("已固定整块"), undefined, {
    timeout: 3000
  });
  await page.locator(".session-source-editor .cm-line", { hasText: "设 T_n 为有界线性算子" }).click();
  await assertVisible(page, "[data-testid='block-lock-button']");
  assert.match(await page.getByTestId("block-lock-button").innerText(), /解除整块/);

  const separator = await page.locator(".split-handle span").boundingBox();
  const sourcePaneBeforeDrag = await page.locator(".source-pane").boundingBox();
  assert.ok(separator);
  assert.ok(sourcePaneBeforeDrag);

  await page.mouse.move(separator.x + separator.width / 2, separator.y + separator.height / 2);
  await page.mouse.down();
  await page.mouse.move(300, separator.y + separator.height / 2, { steps: 6 });
  await page.mouse.up();
  const sourcePaneAfterNarrowDrag = await page.locator(".source-pane").boundingBox();
  assert.ok(sourcePaneAfterNarrowDrag);
  assert.ok(
    sourcePaneBeforeDrag.width - sourcePaneAfterNarrowDrag.width > 180,
    `Electron split should allow narrowing source pane, got ${sourcePaneBeforeDrag.width - sourcePaneAfterNarrowDrag.width}px`
  );

  await page.mouse.move(300, separator.y + separator.height / 2);
  await page.mouse.down();
  await page.mouse.move(1010, separator.y + separator.height / 2, { steps: 6 });
  await page.mouse.up();
  const sourcePaneAfterWideDrag = await page.locator(".source-pane").boundingBox();
  assert.ok(sourcePaneAfterWideDrag);
  assert.ok(
    sourcePaneAfterWideDrag.width - sourcePaneAfterNarrowDrag.width > 500,
    `Electron split should allow widening source pane, got ${sourcePaneAfterWideDrag.width - sourcePaneAfterNarrowDrag.width}px`
  );

  await page.evaluate(() => {
    const markers = Array.from(document.querySelectorAll(".session-source-editor .cm-foldGutter .cm-gutterElement"));
    const marker = markers.find((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return /⌄|›/.test(element.textContent ?? "") && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    marker?.click();
  });
  await page.waitForSelector(".session-source-editor .cm-foldPlaceholder", { timeout: 3000 });

  console.log("[electron smoke] native close guard: make source dirty");
  await page.locator(".session-source-editor .cm-line").first().click();
  await page.keyboard.type(" unsaved-close-check");
  await page.waitForFunction(() => document.querySelector("[data-testid='source-context-bar']")?.textContent?.includes("未保存"), undefined, {
    timeout: 3000
  });
  console.log("[electron smoke] native close guard: request native close");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((a, b) => b.getBounds().width * b.getBounds().height - a.getBounds().width * a.getBounds().height)[0].close());
  await assertVisible(page, "[data-testid='close-confirm-prompt']");
  await page.waitForTimeout(100);
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    1,
    "The recognition HUD must yield to the guarded main-window confirmation instead of covering it"
  );
  console.log("[electron smoke] native close guard: discard changes");
  const closed = page.waitForEvent("close", { timeout: 5000 });
  await page.getByRole("button", { name: "不保存", exact: true }).click().catch((error) => {
    if (!String(error?.message ?? error).includes("Target page, context or browser has been closed")) {
      throw error;
    }
  });
  await closed;
  await app.close();
  app = undefined;

  console.log("[electron smoke] receiver identity survives an app restart");
  app = await electron.launch({
    args: [path.join(projectRoot, "apps/windows/electron-dist/main.cjs"), `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env: {
      ...process.env,
      MATHNOTES_ROOT: notesRoot,
      MATHNOTES_DEV_SERVER: "http://127.0.0.1:9",
      MIMO_API_KEY: "diagnostic-secret-sentinel"
    }
  });
  const restartedPage = await app.firstWindow();
  observeRendererDiagnostics(restartedPage, rendererDiagnostics);
  await restartedPage.waitForSelector("[data-testid='session-source-editor'] .cm-editor", { timeout: 8000 });
  const restartedIngestState = await restartedPage.evaluate(() => window.mathNotes.loadIngestServerState());
  assert.deepEqual(
    { port: restartedIngestState.port, token: restartedIngestState.token },
    firstIngestIdentity,
    "A normal restart must not invalidate Android pairing"
  );

  console.log("[electron smoke] fixed receiver host survives an app restart");
  const fixedDisplayHost = restartedIngestState.displayHost;
  assert.ok(fixedDisplayHost, "A running receiver should expose a display host that can be fixed");
  const fixedIngestState = await restartedPage.evaluate(
    (host) => window.mathNotes.setIngestDisplayHost(host),
    fixedDisplayHost
  );
  assert.equal(fixedIngestState.preferredHost, fixedDisplayHost, "The selected receiver host must become persistent");

  console.log("[electron smoke] preset pairing token restarts the receiver and persists");
  const presetPairingToken = "MathNotes-Remote_2026";
  const updatedIngestState = await restartedPage.evaluate(
    (token) => window.mathNotes.updatePairingToken({ token, confirmation: token }),
    presetPairingToken
  );
  assert.equal(updatedIngestState.running, true, "Updating the pairing token must leave the receiver running");
  assert.equal(updatedIngestState.token, presetPairingToken, "The confirmed preset token must become active");
  await app.close();
  app = undefined;

  console.log("[electron smoke] occupied persisted port falls back without rotating the token");
  blockedPortServer = createServer();
  await listen(blockedPortServer, updatedIngestState.port);
  app = await electron.launch({
    args: [path.join(projectRoot, "apps/windows/electron-dist/main.cjs"), `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env: {
      ...process.env,
      MATHNOTES_ROOT: notesRoot,
      MATHNOTES_DEV_SERVER: "http://127.0.0.1:9"
    }
  });
  const fallbackPage = await app.firstWindow();
  observeRendererDiagnostics(fallbackPage, rendererDiagnostics);
  await fallbackPage.waitForSelector("[data-testid='session-source-editor'] .cm-editor", { timeout: 8000 });
  const fallbackIngestState = await fallbackPage.evaluate(() => window.mathNotes.loadIngestServerState());
  assert.notEqual(fallbackIngestState.port, updatedIngestState.port, "An occupied persisted port must use a safe fallback");
  assert.equal(fallbackIngestState.token, presetPairingToken, "Port fallback must keep the preset pairing token");
  assert.equal(fallbackIngestState.preferredHost, fixedDisplayHost, "A fixed receiver host must survive an app restart");
  const automaticIngestState = await fallbackPage.evaluate(() => window.mathNotes.setIngestDisplayHost(null));
  assert.equal(automaticIngestState.preferredHost, undefined, "Restoring automatic selection must clear the fixed receiver host");
  assert.equal(
    automaticIngestState.displayHost,
    automaticIngestState.addressCandidates[0]?.address,
    "Automatic selection must use the highest-ranked current endpoint"
  );
  assert.deepEqual(rendererDiagnostics.resources, [], "Electron renderer must not leave unexpected failed resources");
  assert.deepEqual(rendererDiagnostics.console, [], "Electron renderer must not emit unexpected warnings or errors");
  await app.close();
  app = undefined;
} finally {
  await app?.close();
  await close(blockedPortServer);
  await rm(notesRoot, { recursive: true, force: true });
}

function createMinimalPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 44 >>\nstream\nBT /F1 18 Tf 48 320 Td (Math Notes PDF) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

console.log("electron app smoke passed");

async function assertVisible(page, selector) {
  await page.waitForSelector(selector, { state: "visible", timeout: 3000 });
  assert.equal(await page.locator(selector).first().isVisible(), true);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function observeRendererDiagnostics(page, diagnostics) {
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    const value = message.text();
    if (/Failed to load resource: the server responded with a status of 404/i.test(value)) return;
    if (/^%cElectron Security Warning \(Insecure Content-Security-Policy\)/.test(value)) return;
    diagnostics.console.push(`${message.type()}: ${value}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    if (response.status() === 404 && response.url().includes(expectedMissingAssetFileName)) return;
    diagnostics.resources.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes(expectedMissingAssetFileName)) return;
    diagnostics.resources.push(`${request.failure()?.errorText ?? "request failed"} ${request.url()}`);
  });
}
