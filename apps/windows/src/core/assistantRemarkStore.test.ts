import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlockStore } from "./blockStore";
import { AssistantRemarkStore, type AssistantRemark } from "./assistantRemarkStore";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const remark = (id = "remark_1"): AssistantRemark => ({ id, mode: "summarize", focus: { kind: "session", label: "当前笔记" },
  markdown: "旁注正文", providerName: "fixture", sourceBlockIds: [], createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-remarks-")); roots.push(root);
  const store = new BlockStore(root);
  await store.createSession({ notebookId: "book", sessionId: "note", title: "笔记", now: "2026-09-08T00:00:00Z" });
  return { root, store, remarks: new AssistantRemarkStore(store), live: store.getSessionDir("book", "note") };
}

describe("assistant remarks respect Session lifetime", () => {
  it.each(["", "..", "../note", "CON", "note:stream", "note. "])("never creates directories for invalid session ID %j", async sessionId => {
    const f = await fixture();
    expect(await f.remarks.list("book", sessionId)).toEqual([]);
    await expect(f.remarks.append({ notebookId: "book", sessionId, remark: remark() })).rejects.toMatchObject({ code: "invalid_id" });
    await expect(f.remarks.remove({ notebookId: "book", sessionId, remarkId: "remark_1" })).rejects.toMatchObject({ code: "invalid_id" });
    await expect(stat(join(f.root, "notebooks/book/sessions/assistant"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps missing and valid empty Session listings read-only", async () => {
    const f = await fixture();
    expect(await f.remarks.list("book", "missing")).toEqual([]);
    expect(await f.remarks.list("book", "note")).toEqual([]);
    expect(await f.remarks.list("", "note")).toEqual([]);
    await expect(stat(join(f.live, "assistant"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.store.getSessionDir("book", "missing"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.remarks.append({ notebookId: "book", sessionId: "missing", remark: remark() })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.remarks.remove({ notebookId: "book", sessionId: "missing", remarkId: "remark_1" })).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("serializes concurrent writes from separate stores without losing a remark", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 8 }, (_, i) => new AssistantRemarkStore(new BlockStore(f.root)).append({ notebookId: "book", sessionId: "note", remark: remark(`remark_${i}`) })));
    expect((await f.remarks.list("book", "note")).map(value => value.id).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `remark_${i}`));
    expect(await f.remarks.remove({ notebookId: "book", sessionId: "note", remarkId: "remark_0" })).toBe(true);
    expect(await f.remarks.list("book", "note")).toHaveLength(7);
  });
  it("does not migrate, append or archive into the old location after a catalog trash barrier", async () => {
    const f = await fixture(); const trash = join(f.root, "trash-payload");
    await mkdir(join(f.live, "assistant"));
    await writeFile(join(f.live, "assistant/remarks.json"), JSON.stringify([remark()]));
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = f.store.getWriteCoordinator().runWorkspace(async () => {
      entered(); await new Promise<void>(resolve => { release = resolve; }); await rename(f.live, trash);
    });
    await started;
    const listing = f.remarks.list("book", "note");
    const append = f.remarks.append({ notebookId: "book", sessionId: "note", remark: remark("late_ai") }).catch(error => error.code);
    const remove = f.remarks.remove({ notebookId: "book", sessionId: "note", remarkId: "remark_1" }).catch(error => error.code);
    release(); await barrier;
    expect(await listing).toEqual([]); expect(await append).toBe("ENOENT"); expect(await remove).toBe("ENOENT");
    await expect(stat(f.live)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(trash, "assistant/index.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(trash, "assistant/remarks.json"), "utf8"))).toEqual([remark()]);
  });
});
