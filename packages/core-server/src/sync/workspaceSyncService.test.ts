import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createBlockRef, createSessionRecord } from "@mathnotes/shared";
import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";
import { WorkspaceSyncService, type ReplicaSnapshot, replicaRevision, validateReplicaPath } from "./workspaceSyncService";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-v3-sync-")); roots.push(root);
  const notebookId = "中文笔记"; const sessionId = "Session 1";
  const directory = join(root, "notebooks", notebookId, "sessions", sessionId);
  const state = join(root, "state");
  await mkdir(join(directory, "blocks"), { recursive: true }); await mkdir(state);
  const session = createSessionRecord({ id: sessionId, title: "原文", createdAt: "2026-09-08T00:00:00Z" });
  session.blocks.push(createBlockRef({ id: "0001", type: "markdown", source: "user", path: "blocks/0001.md", createdAt: session.createdAt }));
  await writeFile(join(directory, "blocks/0001.md"), "# 原文\r\n\r\n$α$ 和 emoji 😀\n");
  await writeFile(join(directory, "session.json"), JSON.stringify(session));
  const queue = new SessionWriteCoordinator();
  const coordinate = <T>(n: string, s: string, operation: () => Promise<T>) => queue.run(n, s, operation);
  const sync = new WorkspaceSyncService(root, state, coordinate);
  const base = await sync.snapshot(notebookId, sessionId);
  return { root, state, directory, notebookId, sessionId, sync, base, coordinate };
}
function edit(base: ReplicaSnapshot, text = "新版本 B\n") {
  const snapshot = structuredClone(base); snapshot.markdown[snapshot.session.blocks[0].path] = text;
  return { operationId: randomUUID(), baseRevision: base.revision, snapshot };
}
async function addAsset(f: Awaited<ReturnType<typeof fixture>>, input: ReturnType<typeof edit>, path: string, bytes = Buffer.from("image bytes")) {
  const sha256 = hash(bytes);
  input.snapshot.assets.push({ path, sha256, byteLength: bytes.length });
  await f.sync.stageAsset({ operationId: input.operationId, sha256, base64: bytes.toString("base64") });
  return { bytes, sha256 };
}

describe("workspace v3 sync host", () => {
  it("requires the existing write coordinator rather than silently creating a separate lock", () => {
    expect(() => new WorkspaceSyncService("a", "b", undefined as never)).toThrow("workspace_sync_coordinator_required");
  });
  it("persists one identity across concurrent instances and restart", async () => {
    const f = await fixture();
    const identities = await Promise.all(Array.from({ length: 12 }, () => new WorkspaceSyncService(f.root, f.state, f.coordinate).identity()));
    expect(new Set(identities.map(x => x.hostId)).size).toBe(1);
    expect(await f.sync.identity()).toEqual(identities[0]);
    const other = await fixture(); expect((await other.sync.identity()).hostId).not.toBe(identities[0].hostId);
  });
  it("returns the current Chinese catalog title and Session identity", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "notebooks", f.notebookId, "notebook.json"), JSON.stringify({ id: f.notebookId, title: "论文阅读", createdAt: f.base.session.createdAt, updatedAt: f.base.session.updatedAt }));
    expect(await f.sync.catalog()).toMatchObject({ notebooks: [{ notebookId: f.notebookId, title: "论文阅读", sessions: [{ sessionId: f.sessionId, title: "原文" }] }] });
  });
  it("keeps original bytes and unknown compatible fields, changes the manifest once, retries after restart", async () => {
    const f = await fixture(); const input = edit(f.base);
    Object.assign(input.snapshot.session, { futureField: { nested: "保留" }, remoteSyncOperations: { forged: "bad" } });
    input.snapshot.session.blocks[0].createdAt = "forged";
    const after = await f.sync.push(input);
    expect(await readFile(join(f.directory, "blocks/0001.md"), "utf8")).toBe(f.base.markdown["blocks/0001.md"]);
    expect(after.session.blocks[0].path).toMatch(/^blocks\/sync_[a-f0-9-]{36}_[a-f0-9]{16}\.md$/);
    expect(after.markdown[after.session.blocks[0].path]).toBe("新版本 B\n");
    expect(after.session).toMatchObject({ futureField: { nested: "保留" }, createdAt: f.base.session.createdAt });
    expect(after.session.blocks[0].createdAt).toBe(f.base.session.blocks[0].createdAt);
    expect((after.session as any).remoteSyncOperations).toEqual({ [input.operationId]: hash(JSON.stringify(input)) });
    expect(replicaRevision(after)).toBe(after.revision);
    expect(await new WorkspaceSyncService(f.root, f.state, f.coordinate).push(input)).toEqual(after);
    input.snapshot.session.title = "changed request";
    await expect(f.sync.push(input)).rejects.toMatchObject({ code: "operation_reused", statusCode: 409 });
  });
  it("checks the ledger before a stale baseline and returns the latest current snapshot", async () => {
    const f = await fixture(); const first = edit(f.base); const a = await f.sync.push(first);
    const b = await f.sync.push(edit(a, "version C"));
    expect(await f.sync.push(first)).toEqual(b);
  });
  it("serializes local writes and concurrent pushes and preserves the losing caller's draft", async () => {
    const f = await fixture(); const a = edit(f.base, "A"); const b = edit(f.base, "B");
    const results = await Promise.allSettled([f.sync.push(a), f.sync.push(b)]);
    expect(results.map(x => x.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { code: "revision_conflict" } });
    expect(b.snapshot.markdown["blocks/0001.md"]).toBe("B");
    let release!: () => void;
    const waiting = f.coordinate(f.notebookId, f.sessionId, () => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 0));
    let completed = false; const read = f.sync.snapshot(f.notebookId, f.sessionId).then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 10)); expect(completed).toBe(false);
    release(); await Promise.all([waiting, read]); expect(completed).toBe(true);
  });
  it("retains at least 1024 host operations and ignores the client's ledger", async () => {
    const f = await fixture(); const session = structuredClone(f.base.session) as any;
    session.remoteSyncOperations = Object.fromEntries(Array.from({ length: 1030 }, () => [randomUUID(), "a".repeat(64)]));
    await writeFile(join(f.directory, "session.json"), JSON.stringify(session));
    const base = await f.sync.snapshot(f.notebookId, f.sessionId); const input = edit(base);
    (input.snapshot.session as any).remoteSyncOperations = {};
    const after = await f.sync.push(input); const ledger = (after.session as any).remoteSyncOperations;
    expect(Object.keys(ledger)).toHaveLength(1024); expect(ledger[input.operationId]).toBe(hash(JSON.stringify(input)));
  });
  it("keeps locked content during an explicit unlock and rejects unlock plus edit or deletion", async () => {
    const f = await fixture(); const locked = structuredClone(f.base.session);
    locked.blocks[0].status = "locked";
    locked.locks = [{ id: "lock1", blockId: "0001", kind: "block", contentHash: hash(f.base.markdown["blocks/0001.md"]), createdAt: locked.createdAt, createdBy: "user", aiEditable: false }];
    await writeFile(join(f.directory, "session.json"), JSON.stringify(locked));
    const base = await f.sync.snapshot(f.notebookId, f.sessionId); const bad = edit(base);
    bad.snapshot.session.locks = []; bad.snapshot.session.blocks[0].status = "draft";
    await expect(f.sync.push(bad)).rejects.toMatchObject({ code: "block_locked", statusCode: 423 });
    bad.snapshot.session.blocks = [];
    await expect(f.sync.push(bad)).rejects.toMatchObject({ code: "block_locked" });
    const unlock = edit(base, base.markdown["blocks/0001.md"]); unlock.snapshot.session.locks = []; unlock.snapshot.session.blocks[0].status = "draft";
    const after = await f.sync.push(unlock);
    expect(after.session.blocks[0].path).toBe("blocks/0001.md");
    expect((await f.sync.push(edit(after))).markdown).not.toEqual(base.markdown);
  });
  it("protects old span content even when the incoming lock metadata is removed", async () => {
    const f = await fixture(); const content = "不能修改😀"; const digest = hash(content);
    const markdown = `before\n<!-- lock:start id="span1" hash="${digest}" -->\n${content}\n<!-- lock:end id="span1" -->\nafter`;
    const session = structuredClone(f.base.session);
    session.locks = [{ id: "span1", blockId: "0001", kind: "span", contentHash: digest, createdAt: session.createdAt, createdBy: "user", aiEditable: false }];
    await writeFile(join(f.directory, "blocks/0001.md"), markdown); await writeFile(join(f.directory, "session.json"), JSON.stringify(session));
    const base = await f.sync.snapshot(f.notebookId, f.sessionId);
    const invalid = edit(base, markdown.replace(content, "修改了")); invalid.snapshot.session.locks = [];
    await expect(f.sync.push(invalid)).rejects.toMatchObject({ code: "protected_span_changed", statusCode: 423 });
    const valid = edit(base, markdown.replace("before", "new introduction"));
    expect((await f.sync.push(valid)).revision).not.toBe(base.revision);
  });
  it("protects readonly Markdown and legacy span wrappers without lock sidecars", async () => {
    const f = await fixture(); const session = structuredClone(f.base.session); session.blocks[0].readonly = true;
    await writeFile(join(f.directory, "session.json"), JSON.stringify(session));
    let base = await f.sync.snapshot(f.notebookId, f.sessionId);
    await expect(f.sync.push(edit(base))).rejects.toMatchObject({ code: "block_locked" });
    session.blocks[0].readonly = false;
    const text = `prefix\n<!-- lock:start id="old" hash="${hash("旧内容")}" -->\n旧内容\n<!-- lock:end id="old" -->\nsuffix`;
    await writeFile(join(f.directory, "session.json"), JSON.stringify(session)); await writeFile(join(f.directory, "blocks/0001.md"), text);
    base = await f.sync.snapshot(f.notebookId, f.sessionId);
    await expect(f.sync.push(edit(base, text.replace("旧内容", "新内容")))).rejects.toMatchObject({ code: "protected_span_changed" });
    expect((await f.sync.push(edit(base, text.replace("prefix", "updated prefix")))).revision).not.toBe(base.revision);
  });
  it.each([true, false])("allows only exact standalone span unwrap, with metadata=%s, and permits later editing", async (withMetadata) => {
    const f = await fixture();
    const protectedText = "固定中文😀\r\n第二行";
    const wrapper = `<!-- lock:start id="unlock1" hash="${hash(protectedText)}" -->\r\n${protectedText}\r\n<!-- lock:end id="unlock1" -->`;
    const markdown = `前文\r\n${wrapper}\r\n后文`;
    const session = structuredClone(f.base.session);
    if (withMetadata) session.locks = [{ id: "unlock1", blockId: "0001", kind: "span", contentHash: hash(protectedText), createdAt: session.createdAt, createdBy: "user", aiEditable: false }];
    await writeFile(join(f.directory, "blocks/0001.md"), markdown); await writeFile(join(f.directory, "session.json"), JSON.stringify(session));
    const base = await f.sync.snapshot(f.notebookId, f.sessionId);
    const exact = markdown.replace(wrapper, protectedText);
    for (const invalidText of [exact.replace("前文", "changed outside"), exact.replace("固定中文", "changed inside"), exact.replaceAll("\r\n", "\n")]) {
      const invalid = edit(base, invalidText); invalid.snapshot.session.locks = [];
      await expect(f.sync.push(invalid)).rejects.toMatchObject({ code: "protected_span_changed", statusCode: 423 });
      expect(await f.sync.snapshot(f.notebookId, f.sessionId)).toEqual(base);
    }
    if (withMetadata) await expect(f.sync.push(edit(base, exact))).rejects.toMatchObject({ code: "protected_span_changed" });
    const unlock = edit(base, exact); unlock.snapshot.session.locks = [];
    const after = await f.sync.push(unlock);
    expect(after.markdown[after.session.blocks[0].path]).toBe(exact);
    expect(await f.sync.push(unlock)).toEqual(after);
    const changed = await f.sync.push(edit(after, exact.replace("固定中文", "后来修改")));
    expect(changed.markdown[changed.session.blocks[0].path]).toContain("后来修改");
  });
  it("keeps other spans and enclosing block locks intact during a targeted span unlock", async () => {
    const f = await fixture();
    const first = `<!-- lock:start id="one" hash="${hash("第一段")}" -->\n第一段\n<!-- lock:end id="one" -->`;
    const second = `<!-- lock:start id="two" hash="${hash("第二段")}" -->\n第二段\n<!-- lock:end id="two" -->`;
    const markdown = `prefix ${first}\nbetween\n${second} suffix`;
    const session = structuredClone(f.base.session);
    session.locks = ["one", "two"].map((id, index) => ({ id, blockId: "0001", kind: "span", contentHash: hash(index === 0 ? "第一段" : "第二段"), createdAt: session.createdAt, createdBy: "user", aiEditable: false }));
    session.blocks[0].status = "locked";
    await writeFile(join(f.directory, "blocks/0001.md"), markdown); await writeFile(join(f.directory, "session.json"), JSON.stringify(session));
    let base = await f.sync.snapshot(f.notebookId, f.sessionId);
    let input = edit(base, markdown.replace(first, "第一段")); input.snapshot.session.locks = input.snapshot.session.locks.filter(lock => lock.id !== "one");
    input.snapshot.session.blocks[0].status = "draft";
    await expect(f.sync.push(input)).rejects.toMatchObject({ code: "block_locked" });
    const unlockBlock = edit(base, markdown); unlockBlock.snapshot.session.blocks[0].status = "draft";
    base = await f.sync.push(unlockBlock);
    input = edit(base, markdown.replace(first, "第一段")); input.snapshot.session.locks = input.snapshot.session.locks.filter(lock => lock.id !== "one");
    const droppingOther = structuredClone(input); droppingOther.snapshot.session.locks = [];
    await expect(f.sync.push(droppingOther)).rejects.toMatchObject({ code: "protected_span_changed" });
    const after = await f.sync.push(input);
    expect(after.session.locks.map(lock => lock.id)).toEqual(["two"]);
    expect(after.markdown[after.session.blocks[0].path]).toContain(second);
    await expect(f.sync.push(edit(after, after.markdown[after.session.blocks[0].path].replace("第二段", "篡改")))).rejects.toMatchObject({ code: "protected_span_changed" });
    const unlockSecond = edit(after, after.markdown[after.session.blocks[0].path].replace(second, "第二段")); unlockSecond.snapshot.session.locks = [];
    expect((await f.sync.push(unlockSecond)).session.locks).toEqual([]);
  });
  it("validates every proposed block before committing any part of a batch", async () => {
    const f = await fixture(); const input = edit(f.base);
    input.snapshot.session.blocks.push({ ...input.snapshot.session.blocks[0], id: "0002", path: "blocks/0002.md" });
    await expect(f.sync.push(input)).rejects.toMatchObject({ code: "invalid_markdown" });
    expect(await f.sync.snapshot(f.notebookId, f.sessionId)).toEqual(f.base);
  });
  it("collects decoded Chinese/space images, reference links, PDF/fromAssets/page sources and excludes code", async () => {
    const f = await fixture(); const input = edit(f.base, '![图](../assets/photos/%E4%B8%AD%E6%96%87%20image.png)\n![旧兼容](assets/photos/%E4%B8%AD%E6%96%87%20image.png)\n![再次][image]\n[image]: <../assets/photos/中文 image.png>\n\n`![code](../assets/no.png)`\n\n```md\n![code](../assets/no2.png)\n```');
    const photo = await addAsset(f, input, "assets/photos/中文 image.png");
    await addAsset(f, input, "assets/pdfs/source.pdf", Buffer.from("pdf"));
    await addAsset(f, input, "assets/pages/page 1.png", Buffer.from("page"));
    input.snapshot.session.blocks[0].fromAssets = ["assets/pdfs/source.pdf"];
    input.snapshot.session.blocks[0].sourcePageImagePath = "assets/pages/page 1.png";
    input.snapshot.session.blocks.push(createBlockRef({ id: "0002", type: "pdf", source: "pdf_import", path: "assets/pdfs/source.pdf", createdAt: f.base.session.createdAt }));
    const after = await f.sync.push(input); expect(after.assets).toHaveLength(3);
    expect(await f.sync.asset(f.notebookId, f.sessionId, "assets/photos/中文 image.png", photo.sha256)).toEqual(photo.bytes);
    await expect(f.sync.asset(f.notebookId, f.sessionId, "assets/photos/中文 image.png", "f".repeat(64))).rejects.toMatchObject({ code: "asset_changed" });
  });
  it("rejects a missing inline image before committing the new manifest", async () => {
    const f = await fixture(); const input = edit(f.base, "![missing](../assets/no.png)");
    await expect(f.sync.push(input)).rejects.toMatchObject({ code: "missing_asset" });
    expect(await f.sync.snapshot(f.notebookId, f.sessionId)).toEqual(f.base);
  });
  it("collects an image split across adjacent continuation fragments without interpreting split code", async () => {
    const f = await fixture(); const input = edit(f.base, "![图](../assets/");
    Object.assign(input.snapshot.session.blocks[0], { continuationGroup: "g1" });
    input.snapshot.session.blocks.push({ ...input.snapshot.session.blocks[0], id: "0002", path: "blocks/0002.md" });
    input.snapshot.markdown["blocks/0002.md"] = "photo.png)\n```md\n";
    input.snapshot.session.blocks.push({ ...input.snapshot.session.blocks[0], id: "0003", path: "blocks/0003.md" });
    input.snapshot.markdown["blocks/0003.md"] = "![code](../assets/not-real.png)\n```";
    await addAsset(f, input, "assets/photo.png");
    const after = await f.sync.push(input);
    expect(after.assets.map(asset => asset.path)).toEqual(["assets/photo.png"]);
    expect(after.session.blocks.map(block => (block as any).continuationGroup)).toEqual(["g1", "g1", "g1"]);
  });
  it("rejects staged hash/length mismatch, noncanonical base64, absent stage and immutable path replacement", async () => {
    const f = await fixture(); const input = edit(f.base, "![x](../assets/p.png)");
    input.snapshot.assets.push({ path: "assets/p.png", byteLength: 3, sha256: hash("abc") });
    await expect(f.sync.push(input)).rejects.toMatchObject({ code: "asset_not_staged" });
    await expect(f.sync.stageAsset({ operationId: input.operationId, sha256: hash("abc"), base64: "YWJj!!!" })).rejects.toMatchObject({ code: "invalid_asset" });
    await expect(f.sync.stageAsset({ operationId: input.operationId, sha256: hash("abc"), base64: Buffer.from("def").toString("base64") })).rejects.toMatchObject({ code: "asset_hash_mismatch" });
    await f.sync.stageAsset({ operationId: input.operationId, sha256: hash("abc"), base64: "YWJj" });
    input.snapshot.assets[0].byteLength = 2;
    await expect(f.sync.push(input)).rejects.toMatchObject({ code: "asset_hash_mismatch" });
    input.snapshot.assets[0].byteLength = 3; const after = await f.sync.push(input);
    const bad = edit(after, "![x](../assets/p.png)"); bad.snapshot.assets[0].sha256 = hash("def");
    await expect(f.sync.push(bad)).rejects.toMatchObject({ code: "immutable_asset_conflict" });
  });
  it("publishes concurrent large stages without partial final files and rejects changed download bytes", async () => {
    const f = await fixture(); const input = edit(f.base, "![x](../assets/large.png)");
    const bytes = Buffer.alloc(1024 * 1024, 17); const sha256 = hash(bytes);
    input.snapshot.assets.push({ path: "assets/large.png", sha256, byteLength: bytes.length });
    await Promise.all(Array.from({ length: 4 }, () => f.sync.stageAsset({ operationId: input.operationId, sha256, base64: bytes.toString("base64") })));
    await f.sync.push(input);
    expect(await f.sync.asset(f.notebookId, f.sessionId, "assets/large.png", sha256)).toEqual(bytes);
    await writeFile(join(f.directory, "assets/large.png"), "changed outside the protocol");
    await expect(f.sync.asset(f.notebookId, f.sessionId, "assets/large.png", sha256)).rejects.toMatchObject({ code: "asset_changed", statusCode: 409 });
  });
  it("rejects Windows aliases, ADS, absolute/encoded traversal and duplicate asset paths", async () => {
    for (const path of ["../x", "/x", "assets/x:y", "assets/CON.png", "assets/x. ", "assets/a\\b", "assets/../x"]) expect(() => validateReplicaPath(path)).toThrow();
    const f = await fixture();
    for (const path of ["../assets/%2e%2e/x.png", "file:///C:/x.png", "../assets/%5c..%5cx.png"]) {
      await expect(f.sync.push(edit(f.base, `![x](${path})`))).rejects.toMatchObject({ code: "unsafe_path" });
    }
    const input = edit(f.base); await addAsset(f, input, "assets/one.png");
    input.snapshot.assets.push({ ...input.snapshot.assets[0], path: "assets/ONE.png" });
    await expect(f.sync.push(input)).rejects.toMatchObject({ code: "duplicate_asset" });
    await expect(f.sync.snapshot("x".repeat(129), f.sessionId)).rejects.toMatchObject({ code: "invalid_id" });
    if (process.platform === "win32") await expect(f.sync.snapshot(f.notebookId, "session 1")).rejects.toMatchObject({ code: "noncanonical_id" });
  });
  it("rejects a Windows junction or symbolic link escaping the session", async () => {
    const f = await fixture(); const outside = join(f.root, "outside"); await mkdir(outside);
    await writeFile(join(outside, "secret.png"), "private"); await mkdir(join(f.directory, "assets"));
    await symlink(outside, join(f.directory, "assets", "escape"), process.platform === "win32" ? "junction" : "dir");
    const input = edit(f.base, "![x](../assets/escape/secret.png)");
    input.snapshot.assets.push({ path: "assets/escape/secret.png", byteLength: 7, sha256: hash("private") });
    await expect(f.sync.push(input)).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(join(outside, "secret.png"), "utf8")).toBe("private");
  });
  it("keeps a complete old manifest after injected failure and safely retries the same operation", async () => {
    const f = await fixture(); const input = edit(f.base);
    const failing = new WorkspaceSyncService(f.root, f.state, f.coordinate, { beforeCommit: async () => { throw new Error("simulated_crash_before_commit"); } });
    await expect(failing.push(input)).rejects.toThrow("simulated_crash_before_commit");
    expect(await f.sync.snapshot(f.notebookId, f.sessionId)).toEqual(f.base);
    const after = await f.sync.push(input); expect(after.revision).not.toBe(f.base.revision);
    const files = await readdir(join(f.directory, "blocks")); expect(files.filter(path => path.endsWith(".tmp"))).toEqual([]);
    expect(files).toHaveLength(2);
  });
  it.runIf(process.platform === "win32")("preserves the manifest when Windows holds it without delete sharing, then retries after release", async () => {
    const f = await fixture(); const input = edit(f.base); const path = join(f.directory, "session.json");
    const script = "$f=[IO.File]::Open($env:MATHNOTES_TEST_MANIFEST,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, MATHNOTES_TEST_MANIFEST: path }, windowsHide: true });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.on("data", bytes => { if (String(bytes).includes("LOCKED")) resolve(); }); child.once("error", reject); child.once("exit", code => { if (code) reject(new Error(`lock child ${code}`)); }); });
      await expect(f.sync.push(input)).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EACCES|EBUSY/) });
      expect(await f.sync.snapshot(f.notebookId, f.sessionId)).toEqual(f.base);
    } finally { child.stdin.end("release\n"); await new Promise<void>(resolve => child.once("exit", () => resolve())); }
    expect((await f.sync.push(input)).revision).not.toBe(f.base.revision);
  }, 15000);
});
