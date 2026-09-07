import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), "mathnotes-session-ai-"));
const output = process.env.MATHNOTES_QA_OUTPUT || path.join(fixture, "evidence");
await mkdir(output, { recursive: true });
let requestCount = 0;
let changes;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = body.messages[0].content;
    assert.match(prompt, /整篇笔记修改助手/);
    const context = JSON.parse(prompt.split("--- 当前笔记 JSON 开始 ---\n")[1].split("\n--- 当前笔记 JSON 结束 ---")[0]);
    const unlocked = context.blocks.find((block) => !block.locked);
    const locked = context.blocks.find((block) => block.locked);
    assert.ok(unlocked && locked, "fixture must cover both lock states");
    changes = { unlocked, locked };
    requestCount += 1;
    const reply = { summary: "统一表述，并说明锁定部分的建议。", changes: [
      { blockId: unlocked.blockId, markdown: "# 全文修改验证\n\n这是经过统一的新表述。", summary: "统一标题与表述" },
      { blockId: locked.blockId, markdown: "恶意模型试图改动锁定内容", summary: "原本打算补充定理前提" }
    ], lockedSuggestions: [{ blockId: locked.blockId, suggestion: "原本打算补充定理前提" }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: "stop" }] }));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
let app;
const errors = [];
try {
  app = await electron.launch({ args: ["--no-stdio-init", path.join(root, "apps/windows/electron-dist/main.cjs"), `--user-data-dir=${path.join(fixture, "profile")}`],
    chromiumSandbox: false, cwd: root, env: { ...process.env, MATHNOTES_ROOT: path.join(fixture, "notes"), MATHNOTES_DEV_SERVER: "" } });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("[data-testid=session-source-editor] .cm-editor");
  const target = await page.evaluate(async (baseUrl) => {
    const doc = await window.mathNotes.createNotebook({ title: "论文阅读" });
    const target = { notebookId: doc.notebookId, sessionId: doc.sessionId };
    await window.mathNotes.createMarkdownBlock({ ...target, markdown: "# 锁定定理\n\n这个定理保持原样。" });
    const current = await window.mathNotes.loadCurrentSession();
    await window.mathNotes.setMarkdownBlockLock({ ...target, blockId: current.sourceDocument.markdownBlocks.at(-1).blockId, locked: true });
    await window.mathNotes.saveAssistantProviderConfig({ providerId: "openai_vision", model: "local-fixture", apiKey: "fixture-only", apiKeyEnvVar: "MATHNOTES_FIXTURE_KEY", baseUrl });
    return target;
  }, endpoint);
  await page.reload();
  await page.waitForSelector("[data-testid=session-source-editor] .cm-editor");
  const assistantOpened = app.waitForEvent("window");
  await page.getByRole("button", { name: "AI 学习助手", exact: true }).click();
  const assistant = await assistantOpened;
  assistant.on("pageerror", (error) => errors.push(error.message));
  await assistant.getByTestId("assistant-workspace").waitFor();
  await assistant.getByRole("button", { name: "解读", exact: true }).click();
  await assistant.getByRole("button", { name: "修改全文", exact: true }).click();
  await assistant.getByRole("textbox", { name: "与笔记对话", exact: true }).fill("统一全文表述，补充定理前提");
  await assistant.getByRole("button", { name: "发送", exact: true }).click();
  await assistant.getByRole("button", { name: "应用全文修改", exact: true }).waitFor();
  assert.equal(requestCount, 1);
  await assistant.getByText("因为以下块已被锁定，未能进行更改", { exact: true }).waitFor();
  const proposalPreview = await page.evaluate(() => window.mathNotes.loadCurrentSession());
  assert.ok(!proposalPreview.sourceDocument.text.includes("这是经过统一的新表述"));
  await assistant.locator(".assistant-edit-card summary").first().click();
  await assistant.screenshot({ path: path.join(output, "session-revision-preview.png") });
  await assistant.getByRole("button", { name: "应用全文修改", exact: true }).click();
  await assistant.getByText("已应用 1 个块的修改", { exact: true }).waitFor();
  const after = await page.evaluate(() => window.mathNotes.loadCurrentSession());
  assert.ok(after.sourceDocument.text.includes("这是经过统一的新表述"));
  assert.ok(after.sourceDocument.text.includes(changes.locked.markdown));
  assert.ok(!after.sourceDocument.text.includes("恶意模型"));
  const remarks = await page.evaluate((input) => window.mathNotes.loadAssistantRemarks(input), target);
  assert.ok(remarks.some((remark) => remark.markdown.includes("因为以下块已被锁定")));
  await assistant.screenshot({ path: path.join(output, "session-revision-applied.png") });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "session-revision-result.json"), JSON.stringify({ ok: true, target, requestCount, lockedBlockUnchanged: true, reportPersisted: true, errors, fixture }, null, 2));
  console.log(`SESSION_REVISION_ELECTRON_OK ${output}`);
} finally {
  if (app) await app.close();
  await new Promise((resolve) => server.close(resolve));
}
