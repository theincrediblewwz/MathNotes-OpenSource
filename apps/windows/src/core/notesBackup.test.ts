import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNotesBackup, type NotesBackupManifest } from "./notesBackup";
import { listNotebooks, listNotebookSessions } from "./sessionCatalog";

describe("createNotesBackup", () => {
  let rootDir: string;
  let notesRootDir: string;
  let destinationParentDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-backup-"));
    notesRootDir = join(rootDir, "MyMathNotes");
    destinationParentDir = join(rootDir, "backups");
    await mkdir(join(notesRootDir, "notebooks", "analysis", "sessions", "lecture", "blocks"), { recursive: true });
    await mkdir(join(notesRootDir, "settings"), { recursive: true });
    await writeFile(
      join(notesRootDir, "notebooks", "analysis", "sessions", "lecture", "session.json"),
      `${JSON.stringify({
        id: "lecture",
        title: "泛函分析 第 3 讲",
        status: "draft",
        createdAt: "2026-07-15T10:00:00.000Z",
        updatedAt: "2026-07-15T10:00:00.000Z",
        blocks: [],
        locks: []
      })}\n`
    );
    await writeFile(join(notesRootDir, "notebooks", "analysis", "sessions", "lecture", "blocks", "0001.md"), "## 定理\n");
    await writeFile(join(notesRootDir, "settings", "provider.json"), "{\"apiKey\":\"must-not-leave-device\"}\n");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("backs up authoritative notebook content with hashes and no provider secrets", async () => {
    const result = await createNotesBackup({
      notesRootDir,
      destinationParentDir,
      appVersion: "0.1.6",
      now: new Date("2026-07-15T10:20:30.000Z")
    });

    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as NotesBackupManifest;
    expect(result.backupDir).toContain("MathNotes-backup-20260715-102030Z");
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: "mathnotes-notes-backup",
      appVersion: "0.1.6",
      contentRoot: "notebooks",
      containsProviderSecrets: false,
      fileCount: 2
    });
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    await expect(readFile(join(result.backupDir, "notebooks", "analysis", "sessions", "lecture", "blocks", "0001.md"), "utf8"))
      .resolves.toBe("## 定理\n");
    await expect(readFile(join(result.backupDir, "settings", "provider.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(listNotebooks({ rootDir: result.backupDir })).resolves.toMatchObject([
      { notebookId: "analysis", sessionCount: 1 }
    ]);
    await expect(listNotebookSessions({ rootDir: result.backupDir, notebookId: "analysis" })).resolves.toMatchObject([
      { sessionId: "lecture", title: "泛函分析 第 3 讲" }
    ]);
  });

  it("never writes a backup inside the active notes root", async () => {
    await expect(createNotesBackup({
      notesRootDir,
      destinationParentDir: join(notesRootDir, "backups"),
      appVersion: "0.1.6"
    })).rejects.toThrow("不能位于当前笔记目录内部");
  });
});
