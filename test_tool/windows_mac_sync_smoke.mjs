import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const output = path.resolve(process.env.MATHNOTES_QA_OUTPUT || "output/playwright/windows-mac-sync");
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(path.join(output, "fixture-"));
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const errors = [];
let app;
try {
  app = await electron.launch({ executablePath, args: ["--no-stdio-init", ...(executablePath ? [] : [path.join(root, "apps/windows/electron-dist/main.cjs")]), `--user-data-dir=${path.join(fixture, "profile")}`],
    chromiumSandbox: false, cwd: root, env: { ...process.env, MATHNOTES_ROOT: path.join(fixture, "notes"), MATHNOTES_DEV_SERVER: "" } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("session-source-editor").locator(".cm-editor").first().waitFor();
  const target = await page.evaluate(async () => {
    const initial = await window.mathNotes.createNotebook({ title: "Mac 同步合成验收" });
    const doc = initial.sourceDocument.markdownBlocks.length ? initial : await window.mathNotes.createMarkdownBlock({ notebookId: initial.notebookId, sessionId: initial.sessionId, markdown: "# HOST_A" });
    const blockId = doc.sourceDocument.markdownBlocks[0].blockId;
    await window.mathNotes.saveMarkdownBlock({ notebookId: doc.notebookId, sessionId: doc.sessionId, blockId, markdown: "# HOST_A\n\n合成原文\n", revisionBaseline: doc.revisionBaseline });
    return { notebookId: doc.notebookId, sessionId: doc.sessionId, blockId };
  });
  await page.reload();
  const preview = page.getByTestId("preview-pane");
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-pane"]')?.textContent?.includes("HOST_A"));
  const receiver = await page.evaluate(() => window.mathNotes.startIngestServer());
  assert.equal(receiver.running, true);
  const origin = `http://127.0.0.1:${receiver.port}`;
  const headers = { authorization: `Bearer ${receiver.token}`, "Content-Type": "application/json" };
  const query = new URLSearchParams({ notebookId: target.notebookId, sessionId: target.sessionId });
  const snapshot = async () => {
    const response = await fetch(`${origin}/api/v3/workspace/snapshot?${query}`, { headers });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const push = async (before, edit) => {
    const body = { operationId: randomUUID(), baseRevision: before.revision, snapshot: structuredClone(before) };
    edit(body.snapshot);
    const response = await fetch(`${origin}/api/v3/workspace/push`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text());
    return { body, accepted: await response.json() };
  };
  let current = await snapshot();
  ({ accepted: current } = await push(current, next => { next.markdown[next.session.blocks.find(b => b.id === target.blockId).path] = "# HOST_B\n\n主机新内容\n"; }));
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-pane"]')?.textContent?.includes("HOST_B"));
  assert.equal(await page.getByTestId("workspace-conflict").count(), 0);
  const editor = page.locator(`[data-testid="source-block"][data-block-id="${target.blockId}"] .cm-content`);
  await editor.click(); await page.keyboard.press("Control+End"); await page.keyboard.insertText("\nLOCAL_DRAFT_ONLY");
  assert.match(await editor.innerText(), /LOCAL_DRAFT_ONLY/);
  ({ accepted: current } = await push(current, next => { next.markdown[next.session.blocks.find(b => b.id === target.blockId).path] = "# HOST_C\n\nMac 新内容保留\n"; }));
  await page.getByTestId("workspace-conflict").waitFor();
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => document.querySelector(".source-save-state")?.textContent?.includes("失败") || document.querySelector('[data-testid="screen-toast"]')?.textContent?.includes("revision_conflict"));
  assert.match(await editor.innerText(), /LOCAL_DRAFT_ONLY/);
  const afterRejectedSave = await snapshot();
  assert.equal(afterRejectedSave.revision, current.revision, "old Windows draft must not overwrite the host");
  await page.getByRole("button", { name: "查看主机版本", exact: true }).click();
  assert.match(await page.getByRole("dialog", { name: "当前主机版本" }).innerText(), /HOST_C/);
  assert.match(await editor.innerText(), /LOCAL_DRAFT_ONLY/);
  await page.screenshot({ path: path.join(output, "windows-draft-conflict.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "重新载入并替换草稿", exact: true }).click();
  assert.match(await editor.innerText(), /LOCAL_DRAFT_ONLY/);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "重新载入并替换草稿", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="workspace-conflict"]'));
  assert.doesNotMatch(await editor.innerText(), /LOCAL_DRAFT_ONLY/);

  const formulaParts = ["# 连续片段\n\n$$\nx+", "y", "=1\n$$\n\n"];
  const tableParts = ["| 变量 | 值 |\n| --- | --- |\n| x | ", "1", " |\n"];
  const original = formulaParts.join("") + "\n\n" + tableParts.join("");
  const template = current.session.blocks.find(b => b.type === "markdown");
  const { body: groupRequest, accepted: grouped } = await push(current, next => {
    next.session.blocks = []; next.session.locks = []; next.markdown = {}; next.assets = [];
    for (const [group, parts] of [["formula", formulaParts], ["table", tableParts]]) {
      parts.forEach((text, index) => {
        const id = `${group}_${index}`, blockPath = `blocks/${id}.md`, locked = index === 1;
        next.session.blocks.push({ ...template, id, path: blockPath, fromAssets: undefined, continuationGroup: group, source: "user", readonly: false, editableByAi: !locked, status: locked ? "locked" : "draft" });
        next.markdown[blockPath] = text;
        if (locked) next.session.locks.push({ id: `lock_${id}`, blockId: id, kind: "block", contentHash: digest(text), createdAt: template.createdAt, createdBy: "user", aiEditable: false });
      });
    }
  });
  await preview.locator(".katex").first().waitFor();
  await preview.locator("table").first().waitFor();
  assert.equal(await preview.locator(".katex-error").count(), 0);
  assert.match(await preview.locator("table").innerText(), /x\s+1/);
  assert.equal(await page.locator('[data-testid="source-block"]').count(), 6, "all real fragments retain separate editing identities");
  await page.screenshot({ path: path.join(output, "windows-continuous-formula-table.png"), animations: "disabled" });
  const exported = await page.evaluate(target => window.mathNotes.exportCurrentSession({ ...target, includeMetadataComments: false, packageMode: "share" }), target);
  const exportedMarkdown = await readFile(exported.outPath, "utf8");
  assert.ok(exportedMarkdown.includes(formulaParts.join("")), "export keeps the whole formula unchanged");
  assert.ok(exportedMarkdown.includes(tableParts.join("")), "export keeps the whole table unchanged");
  const retry = await fetch(`${origin}/api/v3/workspace/push`, { method: "POST", headers, body: JSON.stringify(groupRequest) });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), grouped);
  const forbidden = structuredClone(grouped);
  forbidden.markdown[forbidden.session.blocks.find(b => b.id === "formula_1").path] = "z";
  const rejected = await fetch(`${origin}/api/v3/workspace/push`, { method: "POST", headers, body: JSON.stringify({ operationId: randomUUID(), baseRevision: grouped.revision, snapshot: forbidden }) });
  assert.equal(rejected.status, 423);
  assert.deepEqual(await rejected.json(), { error: "block_locked" });
  assert.equal((await snapshot()).revision, grouped.revision);
  await page.getByRole("button", { name: "笔记目录", exact: true }).click();
  await page.getByTestId("notebook-drawer").getByRole("button", { name: "设置", exact: true }).click();
  const displayedVersion = await page.getByTestId("app-version").innerText();
  assert.match(displayedVersion, /0\.3\.4.*Mac 同步测试版.*[0-9a-f]{12}/);
  if (process.env.MATHNOTES_EXPECT_BUILD) assert.ok(displayedVersion.includes(process.env.MATHNOTES_EXPECT_BUILD));
  await page.screenshot({ path: path.join(output, "windows-build-version.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "result.json"), JSON.stringify({ ok: true, fixture, executablePath: executablePath ?? "built electron", target,
    checks: { nativeHostRoutes: true, noDraftRefresh: true, staleDraftRejected: true, draftRetained: true, viewHostVersion: true, reloadConfirmation: true, continuousFormula: true, continuousTable: true, actualFragmentIdentities: 6, exportPreservesText: true, retryIdempotent: true, lockedFragmentRejected: true },
    displayedVersion, originalSha256: digest(original), errors }, null, 2));
  console.log(`WINDOWS_MAC_SYNC_SMOKE_OK ${output}`);
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: path.join(output, "failure.png"), animations: "disabled" }).catch(() => {});
  throw error;
} finally { await app?.close(); }
