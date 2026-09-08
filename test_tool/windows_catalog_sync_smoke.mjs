import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// All notes, HTTP credentials, and profiles are synthetic and isolated under this fixture.
const root = process.cwd();
const output = path.resolve(process.env.MATHNOTES_QA_OUTPUT || "output/playwright/windows-catalog-sync");
await mkdir(output, { recursive: true });
const fixture = await mkdtemp(path.join(output, "fixture-"));
const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const errors = [];
const notebookId = "catalog_qa_notebook", sessionId = "catalog_qa_session";
const target = { notebookId, sessionId };
const photoPath = "assets/原图 (黑板) [1] #题目 %23保留.png";
const photoMarkdownPath = `../${photoPath.split("/").map(segment => encodeURIComponent(segment).replace(/[!'()*]/g,
  character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")}`;
const photo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64");
let app;
const launch = () => electron.launch({ executablePath,
    args: ["--no-stdio-init", ...(executablePath ? [] : [path.join(root, "apps/windows/electron-dist/main.cjs")]), `--user-data-dir=${path.join(fixture, "profile")}`],
    chromiumSandbox: false, cwd: root,
    env: { ...process.env, MATHNOTES_ROOT: path.join(fixture, "notes"), MATHNOTES_DEV_SERVER: "" }
  });
try {
  app = await launch();
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", error => errors.push(error.message));
  await page.getByTestId("session-source-editor").locator(".cm-editor").first().waitFor();
  const initialTarget = await page.evaluate(async () => {
    const loaded = await window.mathNotes.loadCurrentSession();
    return { notebookId: loaded.notebookId, sessionId: loaded.sessionId };
  });
  const receiver = await page.evaluate(() => window.mathNotes.startIngestServer());
  assert.equal(receiver.running, true);
  const origin = `http://127.0.0.1:${receiver.port}`;
  const headers = { authorization: `Bearer ${receiver.token}`, "Content-Type": "application/json" };
  const request = async (route, body, status = 200) => {
    const response = await fetch(`${origin}/api/v3/workspace/${route}`, {
      headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) })
    });
    const text = await response.text();
    assert.equal(response.status, status, `${route}: ${text}`);
    return JSON.parse(text);
  };
  const operation = input => ({ operationId: randomUUID(), ...input });
  const execute = (input, status) => request("catalog-operation", input, status);
  const catalog = () => request("catalog-state");
  const snapshot = () => request(`snapshot?${new URLSearchParams(target)}`);
  const notebook = async () => (await catalog()).notebooks.find(item => item.notebookId === notebookId);
  assert.ok((await request("identity")).capabilities.includes("catalog-operations-v1"));
  assert.equal((await fetch(`${origin}/api/v3/workspace/catalog-state`)).status, 401);

  await page.getByRole("button", { name: "笔记目录", exact: true }).click();
  await page.getByTestId("notebook-drawer").getByRole("button", { name: "打开 Notebooks", exact: true }).click();
  const browser = page.getByTestId("notebook-browser-dialog");
  await browser.waitFor();
  const folder = title => browser.locator(".notebook-folder").filter({ hasText: title });
  const createNotebook = operation({ action: "create_notebook", notebookId, title: "远程空笔记本", baseRevision: null });
  const createdNotebook = await execute(createNotebook);
  assert.deepEqual((await notebook()).sessions, []);
  await folder("远程空笔记本").waitFor();
  const renameNotebook = operation({ action: "rename", notebookId, title: "远程中文目录", baseRevision: createdNotebook.target.revision });
  await execute(renameNotebook);
  await folder("远程中文目录").waitFor();
  assert.equal(await folder("远程空笔记本").count(), 0);
  assert.deepEqual(await execute(createNotebook), createdNotebook, "create retry must retain its original result after a later rename");
  assert.deepEqual(await execute({ ...createNotebook, title: "重试不能换内容" }, 409), { error: "operation_reused" });

  const timestamp = "2026-09-08T00:00:00.000Z";
  const session = {
    id: sessionId, title: "远程照片笔记", status: "draft", createdAt: timestamp, updatedAt: timestamp,
    blocks: [{ id: "catalog_qa_block", type: "markdown", path: "blocks/b.md", source: "user", status: "draft",
      readonly: false, editableByAi: true, fromAssets: [photoPath], createdAt: timestamp, updatedAt: timestamp }],
    locks: [], currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true }
  };
  const initial = { version: 1, notebookId, session,
    markdown: { "blocks/b.md": `# CATALOG_HOST_BODY\n\n合成照片正文\n\n![原素材](${photoMarkdownPath})\n` },
    assets: [{ path: photoPath, sha256: digest(photo), byteLength: photo.length }], revision: "" };
  initial.revision = digest(JSON.stringify([initial.session, Object.entries(initial.markdown).sort(([a], [b]) => a.localeCompare(b)), initial.assets]));
  const createSession = operation({ action: "create_session", ...target, snapshot: initial, baseRevision: null });
  await request("asset", { operationId: createSession.operationId, sha256: digest(photo), base64: photo.toString("base64") });
  const beforeNewSession = await notebook();
  await execute(createSession);
  await folder("远程中文目录").click();
  await browser.locator(".notebook-session-main").filter({ hasText: "远程照片笔记" }).waitFor();
  assert.deepEqual(await execute(operation({ action: "trash", notebookId, baseRevision: beforeNewSession.revision }), 409), { error: "revision_conflict" });
  const storedPhoto = await readFile(path.join(fixture, "notes", "notebooks", notebookId, "sessions", sessionId, photoPath));
  assert.ok(storedPhoto.equals(photo), "created session must contain exact staged photo bytes");
  const remotePhoto = await fetch(`${origin}/api/v3/workspace/asset?${new URLSearchParams({ ...target, path: photoPath, sha256: digest(photo) })}`, { headers });
  assert.equal(remotePhoto.status, 200);
  assert.ok(Buffer.from(await remotePhoto.arrayBuffer()).equals(photo));

  const trashNotebook = operation({ action: "trash", notebookId, baseRevision: (await notebook()).revision });
  const deletedNotebook = await execute(trashNotebook);
  await folder("远程中文目录").waitFor({ state: "detached" });
  let trash = (await catalog()).trash.find(item => item.id === deletedNotebook.deletionId);
  assert.ok(trash);
  await execute(operation({ action: "restore", notebookId, deletionId: trash.id, baseRevision: trash.revision }));
  await folder("远程中文目录").waitFor();
  assert.deepEqual(await execute(trashNotebook), deletedNotebook, "retry after restore must not delete the notebook again");
  assert.ok(await notebook());
  await folder("远程中文目录").click();
  await browser.locator(".notebook-session-main").filter({ hasText: "远程照片笔记" }).dblclick();
  await browser.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector('[data-testid="preview-pane"]')?.textContent?.includes("CATALOG_HOST_BODY"));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="preview-pane"] img')].some(image => image.complete && image.naturalWidth > 0));
  const editor = page.locator('[data-testid="source-block"][data-block-id="catalog_qa_block"] .cm-content');
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\nCATALOG_LOCAL_UNSAVED_DRAFT");
  assert.match(await editor.innerText(), /CATALOG_LOCAL_UNSAVED_DRAFT/);
  const oldSession = await snapshot();
  await execute(operation({ action: "rename", ...target, title: "Mac 改名后笔记", baseRevision: oldSession.revision }));
  await page.getByTestId("workspace-conflict").waitFor();
  assert.match(await editor.innerText(), /CATALOG_LOCAL_UNSAVED_DRAFT/);
  assert.equal((await snapshot()).session.title, "Mac 改名后笔记");
  assert.deepEqual(await execute(operation({ action: "trash", ...target, baseRevision: oldSession.revision }), 409), { error: "revision_conflict" });

  const trashSession = operation({ action: "trash", ...target, baseRevision: (await snapshot()).revision });
  const deletedSession = await execute(trashSession);
  await page.waitForFunction(() => /删除|废纸篓|移走/.test(document.querySelector('[data-testid="workspace-conflict"]')?.textContent ?? ""));
  assert.match(await editor.innerText(), /CATALOG_LOCAL_UNSAVED_DRAFT/);
  await page.keyboard.press("Control+s");
  assert.match(await editor.innerText(), /CATALOG_LOCAL_UNSAVED_DRAFT/);
  assert.deepEqual((await notebook()).sessions, [], "saving a deleted open draft must not recreate the session");
  await page.screenshot({ path: path.join(output, "windows-catalog-deleted-draft.png"), animations: "disabled" });
  trash = (await catalog()).trash.find(item => item.id === deletedSession.deletionId);
  assert.ok(trash);
  await execute(operation({ action: "restore", ...target, deletionId: trash.id, baseRevision: trash.revision }));
  assert.deepEqual(await execute(trashSession), deletedSession);
  assert.match(await editor.innerText(), /CATALOG_LOCAL_UNSAVED_DRAFT/, "restore must retain the existing unsaved Windows draft");
  const restored = await snapshot();
  assert.equal(restored.session.title, "Mac 改名后笔记");
  assert.doesNotMatch(Object.values(restored.markdown).join(""), /CATALOG_LOCAL_UNSAVED_DRAFT/, "local draft must not silently overwrite the restored host");
  assert.equal(restored.assets[0].sha256, digest(photo));
  const restartTargets = [...new Map([initialTarget, target].map(item => [`${item.notebookId}/${item.sessionId}`, item])).values()];
  const restartDeletions = [];
  for (const restartTarget of restartTargets) {
    const before = await request(`snapshot?${new URLSearchParams(restartTarget)}`);
    const deleted = await execute(operation({ action: "trash", ...restartTarget, baseRevision: before.revision }));
    restartDeletions.push({ ...restartTarget, deletionId: deleted.deletionId });
  }
  await app.close();
  app = await launch();
  const restartedPage = await app.firstWindow();
  restartedPage.setDefaultTimeout(15000);
  restartedPage.on("pageerror", error => errors.push(error.message));
  await restartedPage.getByTestId("preview-pane").waitFor();
  const restartedReceiver = await restartedPage.evaluate(() => window.mathNotes.startIngestServer());
  assert.equal(restartedReceiver.running, true);
  const restartedCatalogResponse = await fetch(`http://127.0.0.1:${restartedReceiver.port}/api/v3/workspace/catalog-state`,
    { headers: { authorization: `Bearer ${restartedReceiver.token}` } });
  assert.equal(restartedCatalogResponse.status, 200, await restartedCatalogResponse.clone().text());
  const restartedCatalog = await restartedCatalogResponse.json();
  for (const deleted of restartDeletions) {
    assert.ok(!restartedCatalog.notebooks.find(item => item.notebookId === deleted.notebookId)?.sessions?.some(item => item.sessionId === deleted.sessionId),
      "restart must not resurrect a deleted default or last-open session");
    assert.ok(restartedCatalog.trash.some(item => item.id === deleted.deletionId));
    await assert.rejects(stat(path.join(fixture, "notes", "notebooks", deleted.notebookId, "sessions", deleted.sessionId)), { code: "ENOENT" });
  }
  await restartedPage.screenshot({ path: path.join(output, "windows-catalog-restart-no-resurrection.png"), animations: "disabled" });
  assert.doesNotMatch(await restartedPage.getByTestId("screen-toast").innerText(), /失败|invalid_id|Error invoking/,
    "an empty workspace must not try to load recognition or assistant tasks using an empty session ID");
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "result.json"), JSON.stringify({ ok: true, fixture,
    executablePath: executablePath ?? "built electron", target,
    checks: { catalogCapability: true, authentication: true, emptyNotebook: true, liveDirectoryRefresh: true,
      notebookRename: true, originalRetryResult: true, operationReuseRejected: true, stagedPhotoExact: true,
      specialFilenamePhotoRendered: true, staleNotebookDeleteRejected: true, notebookTrashRestore: true,
      sessionRename: true, staleSessionDeleteRejected: true, deletedDraftProtected: true,
      deletedDraftSaveDoesNotResurrect: true, sessionTrashRestore: true, retryDoesNotRepeatDelete: true,
      restartDoesNotResurrectDefaultOrCurrentSession: true }, restartDeletions, errors
  }, null, 2));
  console.log(`WINDOWS_CATALOG_SYNC_SMOKE_OK ${output}`);
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: path.join(output, "failure.png"), animations: "disabled" }).catch(() => {});
  throw error;
} finally { await app?.close(); }
