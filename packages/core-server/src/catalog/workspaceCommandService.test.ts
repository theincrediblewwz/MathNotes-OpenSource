import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readNotesCatalog } from "./sessionCatalog";
import {
  createWorkspaceNotebook,
  createWorkspaceSession,
  WorkspaceCommandError
} from "./workspaceCommandService";

describe("workspace commands", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("creates a notebook and a session with the standard editable first block", async () => {
    const rootDir = await temporaryRoot();
    const notebook = await createWorkspaceNotebook({
      rootDir,
      title: "泛函分析",
      now: "2026-07-26T08:00:00.000Z"
    });
    const session = await createWorkspaceSession({
      rootDir,
      notebookId: notebook.notebookId,
      title: "第 1 讲",
      now: "2026-07-26T09:00:00.000Z"
    });

    const sessionDir = join(rootDir, "notebooks", notebook.notebookId, "sessions", session.sessionId);
    const record = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8"));
    const markdown = await readFile(join(sessionDir, "blocks", "0001_user_note.md"), "utf8");
    const catalog = await readNotesCatalog({ rootDir });

    expect(record).toMatchObject({
      id: session.sessionId,
      title: "第 1 讲",
      blocks: [{
        id: "0001",
        type: "markdown",
        path: "blocks/0001_user_note.md",
        source: "user"
      }]
    });
    expect(markdown).toContain("## 新 Session");
    expect(catalog.notebooks[0]).toMatchObject({
      notebookId: notebook.notebookId,
      title: "泛函分析",
      sessionCount: 1
    });
  });

  it("rejects empty titles and sessions for missing notebooks", async () => {
    const rootDir = await temporaryRoot();
    await expect(createWorkspaceNotebook({ rootDir, title: "  " })).rejects.toMatchObject({
      code: "invalid_title"
    });
    await expect(createWorkspaceSession({
      rootDir,
      notebookId: "missing",
      title: "第 1 讲"
    })).rejects.toBeInstanceOf(WorkspaceCommandError);
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "mathnotes-workspace-command-"));
    roots.push(root);
    return root;
  }
});
