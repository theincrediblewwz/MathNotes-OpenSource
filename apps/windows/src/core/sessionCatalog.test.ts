import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockStore } from "./blockStore";
import { createNotebook, deleteNotebookSession, listNotebooks, listNotebookSessions, renameSessionTitle } from "./sessionCatalog";

describe("sessionCatalog", () => {
  let rootDir: string;
  let store: BlockStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-catalog-"));
    store = new BlockStore(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("lists real sessions without mock rows", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "first",
      title: "未命名",
      now: "2026-06-30T08:00:00.000Z"
    });
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "second",
      title: "泛函分析 第 4 讲",
      now: "2026-06-30T09:00:00.000Z"
    });

    const sessions = await listNotebookSessions({ rootDir, notebookId: "functional_analysis" });

    expect(sessions.map((session) => session.sessionId)).toEqual(["second", "first"]);
    expect(sessions.map((session) => session.title)).toEqual(["泛函分析 第 4 讲", "未命名"]);
  });

  it("creates and lists notebook metadata while preserving legacy notebook folders", async () => {
    await createNotebook({
      rootDir,
      notebookId: "pde_notes",
      title: "偏微分方程",
      now: "2026-07-15T08:00:00.000Z"
    });
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "legacy",
      title: "旧 Session",
      now: "2026-07-14T08:00:00.000Z"
    });

    const notebooks = await listNotebooks({ rootDir });

    expect(notebooks).toEqual([
      expect.objectContaining({ notebookId: "pde_notes", title: "偏微分方程", sessionCount: 0 }),
      expect.objectContaining({ notebookId: "functional_analysis", title: "functional_analysis", sessionCount: 1 })
    ]);
  });

  it("renames a session title in session.json", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "未命名",
      now: "2026-06-30T08:00:00.000Z"
    });

    await renameSessionTitle({
      rootDir,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "泛函分析 第 5 讲",
      now: "2026-06-30T09:00:00.000Z"
    });

    expect((await store.readSession("functional_analysis", "lecture")).title).toBe("泛函分析 第 5 讲");
  });

  it("deletes a real session folder and returns the remaining sessions", async () => {
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "first",
      title: "第一讲",
      now: "2026-06-30T08:00:00.000Z"
    });
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "second",
      title: "第二讲",
      now: "2026-06-30T09:00:00.000Z"
    });

    const remaining = await deleteNotebookSession({
      rootDir,
      notebookId: "functional_analysis",
      sessionId: "first"
    });

    expect(remaining.map((session) => session.sessionId)).toEqual(["second"]);
    await expect(store.readSession("functional_analysis", "first")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips broken session folders while listing", async () => {
    await mkdir(join(rootDir, "notebooks/functional_analysis/sessions/broken"), { recursive: true });
    await writeFile(join(rootDir, "notebooks/functional_analysis/sessions/broken/session.json"), "{bad", "utf8");

    await expect(listNotebookSessions({ rootDir, notebookId: "functional_analysis" })).resolves.toEqual([]);
  });
});
