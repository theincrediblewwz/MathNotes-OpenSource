import { _electron as electron } from "playwright";
import { createCanvas } from "@napi-rs/canvas";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const fixture = await mkdtemp(path.join(tmpdir(), "mathnotes-feedback-v034-"));
const output = process.env.MATHNOTES_QA_OUTPUT || path.join(fixture, "evidence");
await mkdir(output, { recursive: true });
const canvas = createCanvas(800, 600), ctx = canvas.getContext("2d");
ctx.fillStyle = "#204437"; ctx.fillRect(0, 0, 800, 600);
ctx.fillStyle = "white"; ctx.font = "36px sans-serif"; ctx.fillText("Synthetic board: f(x) = x^2", 30, 100);
ctx.fillStyle = "black"; ctx.fillRect(600, 0, 200, 600);
const processedPhoto = canvas.toBuffer("image/png");
const photoPath = path.join(fixture, "processed.png"), markdownPath = path.join(fixture, "external.md");
await writeFile(photoPath, processedPhoto); await writeFile(markdownPath, "# 合法文件拖入\n\nEXTERNAL_MARKDOWN_IMPORT_OK\n");
const requests = [], serverErrors = [], rendererErrors = [];
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(req.url, "/v1/chat/completions");
    const image = body.messages[0].content.find(item => item.type === "image_url");
    assert.deepEqual(Buffer.from(image.image_url.url.split(",")[1], "base64"), processedPhoto);
    const entry = { number: requests.length + 1, started: Date.now(), response: res, sentImageSha256: createHash("sha256").update(processedPhoto).digest("hex") };
    requests.push(entry);
    if (entry.number === 1) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "# 第一轮识别\n\nFIRST_PROVIDER_RESULT\n\n[[mathnotes:source-image]]" } }] }));
      entry.completed = Date.now();
    } else {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `# 第 ${entry.number} 轮识别\n\n` } }] })}\n\n`);
    }
  } catch (error) { serverErrors.push(String(error)); res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const release = (number, text) => {
  const entry = requests[number - 1];
  entry.response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  entry.response.end("data: [DONE]\n\n"); entry.completed = Date.now();
};
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 25)); }
}
let app;
try {
  app = await electron.launch({ executablePath, args: ["--no-stdio-init", ...(executablePath ? [] : [path.join(root, "apps/windows/electron-dist/main.cjs")]), `--user-data-dir=${path.join(fixture, "profile")}`],
    chromiumSandbox: false, cwd: root, env: { ...process.env, MATHNOTES_ROOT: path.join(fixture, "notes"), MATHNOTES_DEV_SERVER: "" } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on("pageerror", error => rendererErrors.push(error.message));
  await page.waitForSelector("[data-testid=session-source-editor] .cm-editor");
  const target = await page.evaluate(async () => {
    const doc = await window.mathNotes.createNotebook({ title: "本轮 Windows 反馈验收" });
    const target = { notebookId: doc.notebookId, sessionId: doc.sessionId };
    for (const text of ["第一块", "第二块", "第三块"]) await window.mathNotes.createMarkdownBlock({ ...target, markdown: `# ${text}\n\n拖动时保留的正文。` });
    return target;
  });
  await page.reload(); await page.waitForSelector("[data-testid=session-source-editor] .cm-editor");
  await page.evaluate(() => {
    window.feedbackToasts = [];
    new MutationObserver(() => { const text = document.querySelector("[data-testid=screen-toast]")?.textContent; if (text) window.feedbackToasts.push(text); })
      .observe(document.querySelector("[data-testid=screen-toast]"), { subtree: true, characterData: true, childList: true });
  });
  const order = () => page.locator("[data-testid=source-block]").evaluateAll(items => items.map(item => item.dataset.blockId));
  const beforeDrag = await order();
  const dragResults = [];
  for (const landing of ["original", "blank", "outside", "cancel", "other"]) {
    const ids = await order(), moving = ids[0];
    const header = page.locator(`[data-testid=source-block][data-block-id="${moving}"] [data-testid=source-block-header]`);
    await header.scrollIntoViewIfNeeded(); const box = await header.boundingBox();
    await page.mouse.move(box.x + 80, box.y + box.height / 2); await page.mouse.down();
    const nativeMove = page.mouse.move(box.x + 110, box.y + box.height / 2 + 18, { steps: 6 });
    const overlay = page.getByTestId("block-reorder-preview"); await overlay.waitFor();
    if (landing === "cancel") await page.keyboard.press("Escape");
    else {
      const destination = landing === "original" || landing === "other"
        ? page.locator(`.block-reorder-card[data-block-id="${landing === "original" ? moving : ids.at(-1)}"]`) : overlay;
      const bounds = await destination.boundingBox();
      const x = landing === "outside" ? 1000 : bounds.x + 70;
      const y = landing === "outside" ? 750 : landing === "blank" ? bounds.y + 10 : bounds.y + bounds.height - 9;
      await page.mouse.move(x, y, { steps: 7 }); await page.mouse.move(x + 1, y + 1);
      if (landing === "original") await page.screenshot({ path: path.join(output, "original-position-drag.png"), animations: "disabled" });
      await page.mouse.up();
    }
    await nativeMove; await page.mouse.up(); await overlay.waitFor({ state: "detached" });
    if (landing === "other") await until(async () => (await order()).at(-1) === moving, "Cross-block reorder did not complete");
    else assert.deepEqual(await order(), ids, `${landing} drop must be a no-op`);
    dragResults.push({ landing, order: await order() });
  }
  assert.equal((await order()).length, beforeDrag.length);
  assert.ok(!(await page.evaluate(() => window.feedbackToasts)).some(text => text.includes("Markdown 导入失败")));
  const cdp = await page.context().newCDPSession(page);
  const dragData = { items: [], files: [markdownPath], dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"]) await cdp.send("Input.dispatchDragEvent", { type, x: 1000, y: 740, data: dragData });
  await until(async () => (await page.evaluate(() => window.mathNotes.loadCurrentSession())).sourceDocument.text.includes("EXTERNAL_MARKDOWN_IMPORT_OK"), "Valid external Markdown drop did not import");
  assert.equal((await order()).length, beforeDrag.length + 1);
  console.log("PASS internal native drops: original/blank/outside/cancel/cross-block; real external .md import");

  await page.evaluate(baseUrl => window.mathNotes.saveProviderConfig({ providerId: "custom_openai_compatible", model: "synthetic-delayed", apiKey: "fixture-only", apiKeyEnvVar: "MATHNOTES_FIXTURE_ONLY", baseUrl }), endpoint);
  const initial = await page.evaluate(input => window.mathNotes.importLocalPhoto(input), { ...target, filePath: photoPath });
  assert.equal(initial.recognitionStatus, "succeeded"); assert.equal(requests.length, 1);
  await page.reload(); await page.waitForSelector("[data-testid=session-source-editor] .cm-editor");
  const transcriptId = initial.transcriptBlockId;
  const document = () => page.evaluate(() => window.mathNotes.loadCurrentSession());
  const originalSessionDir = (await document()).sessionDir;
  const sourceText = async () => (await document()).sourceDocument.text;
  const taskStatus = () => page.evaluate(async target => (await window.mathNotes.loadRecognitionTasks(target))[0].recognitionStatus, target);
  const startFromBlockMenu = async () => {
    const header = page.locator(`[data-testid=source-block][data-block-id="${transcriptId}"] [data-testid=source-block-header]`);
    await header.scrollIntoViewIfNeeded(); await header.click({ button: "right" });
    await page.getByRole("button", { name: "重新识别这个块", exact: true }).click();
  };
  const receiver = await page.evaluate(() => window.mathNotes.loadIngestServerState());
  const statusUrl = `http://127.0.0.1:${receiver.port}/api/v1/uploads/status?${new URLSearchParams({ ...target, uploadId: initial.uploadId })}`;
  const readRemoteStatus = async () => {
    const response = await fetch(statusUrl, { headers: { authorization: `Bearer ${receiver.token}` } }); assert.equal(response.status, 200); return response.json();
  };
  await startFromBlockMenu(); await until(() => requests.length === 2, "Re-recognition did not call the provider again");
  await page.locator(".recognition-task-row.running").waitFor();
  assert.equal(await taskStatus(), "running"); assert.match(await sourceText(), /FIRST_PROVIDER_RESULT/);
  const liveReceipt = await readRemoteStatus(); assert.equal(liveReceipt.recognitionStatus, "running"); assert.equal(liveReceipt.sessionId, target.sessionId);
  const repeatedError = await page.evaluate(async input => { try { await window.mathNotes.retryRecognitionTask(input); return "not rejected"; } catch (error) { return String(error); } }, { ...target, recognitionJobId: initial.recognitionJobId });
  assert.match(repeatedError, /仍在进行中/); assert.equal(requests.length, 2);
  await page.screenshot({ path: path.join(output, "rerecognition-running-old-text.png"), animations: "disabled" });
  await new Promise(resolve => setTimeout(resolve, 400)); assert.equal(await taskStatus(), "running");
  release(2, "SECOND_PROVIDER_RESULT\n\n[[mathnotes:source-image]]");
  await until(async () => await taskStatus() === "succeeded" && (await sourceText()).includes("SECOND_PROVIDER_RESULT"), "Fresh result did not reach the same transcript");
  const freshPreview = page.getByTestId("preview-pane").getByText("SECOND_PROVIDER_RESULT", { exact: true });
  await freshPreview.waitFor();
  await freshPreview.scrollIntoViewIfNeeded();
  await page.locator(`[data-testid=source-block][data-block-id="${transcriptId}"] [data-testid=source-block-header]`).scrollIntoViewIfNeeded();
  assert.equal((await document()).sourceDocument.markdownBlocks.filter(block => block.blockId === transcriptId).length, 1);
  assert.ok(!(await sourceText()).includes("FIRST_PROVIDER_RESULT"));
  assert.ok((await sourceText()).includes(initial.assetPath));
  assert.equal((await readRemoteStatus()).recognitionStatus, "succeeded");
  await page.screenshot({ path: path.join(output, "rerecognition-completed-new-text.png"), animations: "disabled" });
  console.log("PASS explicit success rerun invokes provider, preserves old text while running, rejects duplicate, commits fresh bound result");

  await startFromBlockMenu(); await until(() => requests.length === 3, "Locked-during-run fixture never reached provider");
  await page.evaluate(input => window.mathNotes.setMarkdownBlockLock(input), { ...target, blockId: transcriptId, locked: true });
  release(3, "SHOULD_NOT_OVERWRITE_LOCK\n\n[[mathnotes:source-image]]");
  await until(async () => await taskStatus() === "failed", "User lock did not reject the writeback");
  assert.match(await sourceText(), /SECOND_PROVIDER_RESULT/); assert.ok(!(await sourceText()).includes("SHOULD_NOT_OVERWRITE_LOCK"));
  assert.equal((await readRemoteStatus()).recognitionStatus, "failed");
  const beforeLockedRetry = requests.length;
  const lockError = await page.evaluate(async input => { try { await window.mathNotes.retryRecognitionTask(input); return "not rejected"; } catch (error) { return String(error); } }, { ...target, recognitionJobId: initial.recognitionJobId });
  assert.match(lockError, /已锁定/); assert.equal(requests.length, beforeLockedRetry);
  await page.evaluate(input => window.mathNotes.setMarkdownBlockLock(input), { ...target, blockId: transcriptId, locked: false });
  await page.reload(); await page.waitForSelector("[data-testid=session-source-editor] .cm-editor");
  await startFromBlockMenu(); await until(() => requests.length === 4, "Cancel fixture never reached provider");
  const row = page.locator(".recognition-task-row.running"); await row.locator(".task-row-toggle").click();
  await page.getByRole("button", { name: `中断识别 ${initial.recognitionJobId}`, exact: true }).click();
  await until(async () => await taskStatus() === "cancelled", "Cancelled retry did not settle");
  assert.match(await sourceText(), /SECOND_PROVIDER_RESULT/);
  assert.equal((await readRemoteStatus()).recognitionStatus, "cancelled");
  await page.evaluate(baseUrl => window.mathNotes.saveProviderConfig({ providerId: "custom_openai_compatible", model: "unconfigured", apiKey: "", apiKeyEnvVar: "MATHNOTES_INTENTIONALLY_UNSET_KEY", baseUrl }), endpoint);
  assert.equal((await readRemoteStatus()).recognitionStatus, "cancelled", "Historical status must not initialize the unconfigured provider");
  const session = JSON.parse(await readFile(path.join(originalSessionDir, "session.json"), "utf8"));
  assert.deepEqual(session.blocks.find(block => block.id === transcriptId).fromAssets, [initial.assetPath]);

  await page.evaluate(baseUrl => window.mathNotes.saveProviderConfig({ providerId: "custom_openai_compatible", model: "synthetic-delayed", apiKey: "fixture-only", apiKeyEnvVar: "MATHNOTES_FIXTURE_ONLY", baseUrl }), endpoint);
  const otherTarget = await page.evaluate(async imageBlockId => {
    const doc = await window.mathNotes.createNotebook({ title: "同编号任务隔离验收" });
    const other = { notebookId: doc.notebookId, sessionId: doc.sessionId };
    for (let i = 1; i < Number(imageBlockId) - 1; i++) await window.mathNotes.createMarkdownBlock({ ...other, markdown: `另一笔记占位 ${i}` });
    return other;
  }, initial.imageBlockId);
  const otherImport = page.evaluate(input => window.mathNotes.importLocalPhoto(input), { ...otherTarget, filePath: photoPath });
  await until(() => requests.length === 5, "Other session initial recognition did not start");
  release(5, "OTHER_SESSION_INITIAL\n\n[[mathnotes:source-image]]");
  const otherInitial = await otherImport;
  assert.equal(otherInitial.recognitionStatus, "succeeded");
  assert.equal(otherInitial.recognitionJobId, initial.recognitionJobId, "Fixture must actually use colliding wire job IDs");
  const inputA = { ...target, recognitionJobId: initial.recognitionJobId };
  const inputB = { ...otherTarget, recognitionJobId: otherInitial.recognitionJobId };
  const rerunA = page.evaluate(input => window.mathNotes.retryRecognitionTask(input), inputA).catch(error => ({ error: String(error) }));
  await until(() => requests.length === 6, "First same-ID retry did not start");
  const rerunB = page.evaluate(input => window.mathNotes.retryRecognitionTask(input), inputB).catch(error => ({ error: String(error) }));
  await until(() => requests.length === 7, "Same-ID retry in another session was incorrectly blocked");
  await page.evaluate(input => window.mathNotes.cancelRecognitionTask(input), inputA);
  assert.equal((await rerunA).recognitionStatus, "cancelled");
  const otherStatus = () => page.evaluate(async target => (await window.mathNotes.loadRecognitionTasks(target))[0].recognitionStatus, otherTarget);
  assert.equal(await otherStatus(), "running", "Cancelling one session must not cancel the same-ID task in the other session");
  release(7, "OTHER_SESSION_FRESH\n\n[[mathnotes:source-image]]");
  assert.equal((await rerunB).recognitionStatus, "succeeded");
  assert.equal(await otherStatus(), "succeeded");
  const originalBlock = session.blocks.find(block => block.id === transcriptId);
  assert.match(await readFile(path.join(originalSessionDir, originalBlock.path), "utf8"), /SECOND_PROVIDER_RESULT/);
  assert.match(await sourceText(), /OTHER_SESSION_FRESH/);
  assert.equal((await readRemoteStatus()).recognitionStatus, "cancelled");
  console.log("PASS same wire job ID across sessions: concurrent fresh provider calls, targeted cancel, other session writes fresh result");
  assert.equal(requests.length, 7); assert.deepEqual(rendererErrors, []); assert.deepEqual(serverErrors, []);
  const report = { ok: true, fixture, executablePath: executablePath ?? "development-electron", dragResults, externalMarkdownImported: true, providerRequests: requests.map(({ response, ...entry }) => entry),
    freshProviderResultAppliedToSameBlock: true, originalAssetBindingRetained: true, oldTextRetainedWhileRunning: true,
    duplicateRunningRequestRejected: true, preexistingAndRuntimeLocksProtected: true, cancelledRetryPreservesSuccess: true,
    receiptTracksLiveRetryStatus: true, receiptReadableWithoutProvider: true, crossSessionSameJobIsolation: true, rendererErrors, serverErrors };
  await writeFile(path.join(output, "windows-feedback-result.json"), JSON.stringify(report, null, 2));
  console.log(`WINDOWS_FEEDBACK_V034_OK ${output}`);
} catch (error) {
  const page = app?.windows()[0];
  await page?.screenshot({ path: path.join(output, "failure.png"), animations: "disabled" }).catch(() => undefined);
  console.error(await page?.locator("body").innerText()); throw error;
} finally {
  if (app) await app.close();
  for (const entry of requests) entry.response.destroy();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
