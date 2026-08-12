import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNotesCatalog } from "./sessionCatalog";

describe("readNotesCatalog", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("returns an empty catalog when the notes root has no notebooks", async () => {
    const rootDir = await temporaryRoot();
    await expect(readNotesCatalog({ rootDir })).resolves.toEqual({ notebooks: [] });
  });

  it("lists metadata and legacy notebooks with sessions sorted by update time", async () => {
    const rootDir = await temporaryRoot();
    await writeNotebook(rootDir, "pde", {
      id: "pde",
      title: "偏微分方程",
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-20T08:00:00.000Z"
    });
    await writeSession(rootDir, "pde", "older", "第一讲", "2026-07-20T09:00:00.000Z");
    await writeSession(rootDir, "pde", "newer", "第二讲", "2026-07-21T09:00:00.000Z");
    await writeSession(rootDir, "legacy", "lecture", "旧笔记", "2026-07-19T09:00:00.000Z");

    const catalog = await readNotesCatalog({ rootDir });

    expect(catalog.notebooks.map((item) => item.notebookId)).toEqual(["pde", "legacy"]);
    expect(catalog.notebooks[0]).toMatchObject({ title: "偏微分方程", sessionCount: 2 });
    expect(catalog.notebooks[0].sessions.map((item) => item.sessionId)).toEqual(["newer", "older"]);
    expect(catalog.notebooks[1]).toMatchObject({ title: "legacy", sessionCount: 1 });
  });

  it("skips a broken session without hiding healthy siblings", async () => {
    const rootDir = await temporaryRoot();
    await writeSession(rootDir, "analysis", "healthy", "泛函分析", "2026-07-21T09:00:00.000Z");
    const broken = join(rootDir, "notebooks", "analysis", "sessions", "broken");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "session.json"), "{broken", "utf8");

    const catalog = await readNotesCatalog({ rootDir });

    expect(catalog.notebooks).toHaveLength(1);
    expect(catalog.notebooks[0].sessions.map((item) => item.sessionId)).toEqual(["healthy"]);
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "mathnotes-core-catalog-"));
    roots.push(root);
    return root;
  }
});

async function writeNotebook(rootDir: string, notebookId: string, metadata: unknown): Promise<void> {
  const directory = join(rootDir, "notebooks", notebookId);
  await mkdir(join(directory, "sessions"), { recursive: true });
  await writeFile(join(directory, "notebook.json"), `${JSON.stringify(metadata)}\n`, "utf8");
}

async function writeSession(
  rootDir: string,
  notebookId: string,
  sessionId: string,
  title: string,
  updatedAt: string
): Promise<void> {
  const directory = join(rootDir, "notebooks", notebookId, "sessions", sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "session.json"), `${JSON.stringify({
    id: sessionId,
    title,
    status: "draft",
    createdAt: updatedAt,
    updatedAt,
    blocks: [],
    locks: []
  })}\n`, "utf8");
}
