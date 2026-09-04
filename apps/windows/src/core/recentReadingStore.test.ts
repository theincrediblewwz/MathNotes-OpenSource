import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRecentSessions, recentReadingHistoryLimit, recordRecentSession } from "./recentReadingStore";

describe("recentReadingStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("orders successful opens, deduplicates sessions and resolves current titles", async () => {
    const fixture = await createFixture();
    await writeSession(fixture.notesRoot, "analysis", "lecture-1", "第一讲", "2026-08-28T09:00:00.000Z");
    await writeSession(fixture.notesRoot, "analysis", "lecture-2", "第二讲", "2026-08-29T09:00:00.000Z");
    await recordRecentSession({ ...fixture, notebookId: "analysis", sessionId: "lecture-1", openedAt: "2026-08-30T01:00:00.000Z" });
    await recordRecentSession({ ...fixture, notebookId: "analysis", sessionId: "lecture-2", openedAt: "2026-08-30T02:00:00.000Z" });
    await recordRecentSession({ ...fixture, notebookId: "analysis", sessionId: "lecture-1", openedAt: "2026-08-30T03:00:00.000Z" });

    await expect(listRecentSessions({ ...fixture, rootDir: fixture.notesRoot })).resolves.toEqual([
      expect.objectContaining({ sessionId: "lecture-1", title: "第一讲", notebookTitle: "泛函分析", openedAt: "2026-08-30T03:00:00.000Z" }),
      expect.objectContaining({ sessionId: "lecture-2", title: "第二讲", notebookTitle: "泛函分析", openedAt: "2026-08-30T02:00:00.000Z" })
    ]);
  });

  it("caps history and discards sessions that no longer exist", async () => {
    const fixture = await createFixture();
    for (let index = 0; index < recentReadingHistoryLimit + 3; index += 1) {
      const sessionId = `lecture-${index}`;
      await writeSession(fixture.notesRoot, "analysis", sessionId, `第 ${index} 讲`, "2026-08-29T09:00:00.000Z");
      await recordRecentSession({ ...fixture, notebookId: "analysis", sessionId, openedAt: new Date(Date.UTC(2026, 7, 30, 0, index)).toISOString() });
    }
    await rm(join(fixture.notesRoot, "notebooks", "analysis", "sessions", `lecture-${recentReadingHistoryLimit + 2}`), { recursive: true });

    const recent = await listRecentSessions({ ...fixture, rootDir: fixture.notesRoot, limit: 4 });
    expect(recent).toHaveLength(4);
    expect(recent.map((item) => item.sessionId)).toEqual([
      `lecture-${recentReadingHistoryLimit + 1}`,
      `lecture-${recentReadingHistoryLimit}`,
      `lecture-${recentReadingHistoryLimit - 1}`,
      `lecture-${recentReadingHistoryLimit - 2}`
    ]);
    const stored = JSON.parse(await readFile(join(fixture.userDataDir, "recent-reading.v1.json"), "utf8"));
    expect(stored.entries).toHaveLength(recentReadingHistoryLimit - 1);
  });

  it("treats malformed user metadata as an empty optional history", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.userDataDir, "recent-reading.v1.json"), "{broken", "utf8");
    await expect(listRecentSessions({ ...fixture, rootDir: fixture.notesRoot })).resolves.toEqual([]);
  });

  async function createFixture(): Promise<{ userDataDir: string; notesRoot: string }> {
    const root = await mkdtemp(join(tmpdir(), "mathnotes-recent-reading-"));
    roots.push(root);
    const userDataDir = join(root, "user-data");
    const notesRoot = join(root, "notes");
    await Promise.all([mkdir(userDataDir, { recursive: true }), mkdir(notesRoot, { recursive: true })]);
    return { userDataDir, notesRoot };
  }
});

async function writeSession(rootDir: string, notebookId: string, sessionId: string, title: string, updatedAt: string): Promise<void> {
  const notebookDir = join(rootDir, "notebooks", notebookId);
  const sessionDir = join(notebookDir, "sessions", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(notebookDir, "notebook.json"), `${JSON.stringify({
    id: notebookId,
    title: "泛函分析",
    createdAt: updatedAt,
    updatedAt
  })}\n`, "utf8");
  await writeFile(join(sessionDir, "session.json"), `${JSON.stringify({
    id: sessionId,
    title,
    status: "draft",
    createdAt: updatedAt,
    updatedAt,
    blocks: [],
    locks: []
  })}\n`, "utf8");
}
