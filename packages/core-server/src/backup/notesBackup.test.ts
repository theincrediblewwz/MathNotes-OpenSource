import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNotesBackup, type NotesBackupManifest } from "./notesBackup";

describe("createNotesBackup", () => {
  let rootDir: string;
  let notesRootDir: string;
  let destinationParentDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-core-backup-"));
    notesRootDir = join(rootDir, "notes");
    destinationParentDir = join(rootDir, "backups");
    await mkdir(join(notesRootDir, "notebooks", "analysis", "sessions", "lecture", "blocks"), {
      recursive: true
    });
    await mkdir(join(notesRootDir, "settings"), { recursive: true });
    await writeFile(
      join(notesRootDir, "notebooks", "analysis", "sessions", "lecture", "session.json"),
      "{\"id\":\"lecture\"}\n",
      "utf8"
    );
    await writeFile(
      join(notesRootDir, "notebooks", "analysis", "sessions", "lecture", "blocks", "0001.md"),
      "## 定理\n",
      "utf8"
    );
    await writeFile(join(notesRootDir, "settings", "provider.json"), "secret-key", "utf8");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("copies only authoritative notebooks and records verifiable hashes", async () => {
    const result = await createNotesBackup({
      notesRootDir,
      destinationParentDir,
      appVersion: "0.2.0",
      now: new Date("2026-08-30T08:09:10.000Z")
    });
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as NotesBackupManifest;

    expect(result.backupDir).toContain("MathNotes-backup-20260830-080910Z");
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: "mathnotes-notes-backup",
      appVersion: "0.2.0",
      contentRoot: "notebooks",
      containsProviderSecrets: false,
      fileCount: 2
    });
    expect(manifest.files.map((file) => file.path)).toEqual([
      "notebooks/analysis/sessions/lecture/blocks/0001.md",
      "notebooks/analysis/sessions/lecture/session.json"
    ]);
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    await expect(readFile(join(result.backupDir, "settings", "provider.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses destinations inside the active notes root", async () => {
    await expect(createNotesBackup({
      notesRootDir,
      destinationParentDir: join(notesRootDir, "backups"),
      appVersion: "0.2.0"
    })).rejects.toThrow("不能位于当前笔记目录内部");
  });

  it("refuses symbolic links so a backup cannot escape the notebook tree", async () => {
    const target = join(rootDir, "outside.txt");
    const link = join(notesRootDir, "notebooks", "analysis", "outside-link.txt");
    await writeFile(target, "outside", "utf8");
    try {
      await symlink(target, link, "file");
    } catch (error) {
      if (isWindowsSymlinkPrivilegeError(error)) return;
      throw error;
    }

    await expect(createNotesBackup({ notesRootDir, destinationParentDir, appVersion: "0.2.0" }))
      .rejects.toThrow("备份拒绝符号链接");
  });
});

function isWindowsSymlinkPrivilegeError(error: unknown): boolean {
  return process.platform === "win32" && typeof error === "object" && error !== null &&
    "code" in error && (error.code === "EPERM" || error.code === "EACCES");
}
