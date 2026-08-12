import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemCompanionStore } from "./filesystemCompanionStore";

describe("FilesystemCompanionStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("reads a Unicode session ID emitted by the workspace catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "mathnotes-unicode-session-"));
    roots.push(root);
    const notebookId = "try";
    const sessionId = "20260728073706_未命名_session_12ce79";
    const sessionDir = join(root, "notebooks", notebookId, "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify({
      id: sessionId,
      title: "未命名 Session",
      createdAt: "2026-07-28T07:37:06.000Z",
      updatedAt: "2026-07-28T07:37:06.000Z",
      blocks: [],
      locks: []
    }));

    const store = new FilesystemCompanionStore(root);
    await expect(store.readSession(notebookId, sessionId)).resolves.toMatchObject({ id: sessionId });
    expect(() => store.getSessionDir("..", sessionId)).toThrow("invalid_target");
  });
});
