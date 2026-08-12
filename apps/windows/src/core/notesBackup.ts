import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";

export const notesBackupSchemaVersion = 1;

export type NotesBackupFile = {
  path: string;
  size: number;
  sha256: string;
};

export type NotesBackupManifest = {
  schemaVersion: typeof notesBackupSchemaVersion;
  kind: "mathnotes-notes-backup";
  createdAt: string;
  appVersion: string;
  contentRoot: "notebooks";
  containsProviderSecrets: false;
  fileCount: number;
  totalBytes: number;
  files: NotesBackupFile[];
};

export type CreateNotesBackupResult = {
  backupDir: string;
  manifestPath: string;
  fileCount: number;
  totalBytes: number;
};

export async function createNotesBackup(args: {
  notesRootDir: string;
  destinationParentDir: string;
  appVersion: string;
  now?: Date;
}): Promise<CreateNotesBackupResult> {
  const notesRootDir = path.resolve(args.notesRootDir);
  const destinationParentDir = path.resolve(args.destinationParentDir);
  assertBackupDestination(notesRootDir, destinationParentDir);

  const createdAt = (args.now ?? new Date()).toISOString();
  const backupName = `MathNotes-backup-${backupTimestamp(createdAt)}`;
  const backupDir = await availableBackupDir(destinationParentDir, backupName);
  const temporaryDir = `${backupDir}.tmp-${randomUUID()}`;
  const sourceNotebooksDir = path.join(notesRootDir, "notebooks");
  const destinationNotebooksDir = path.join(temporaryDir, "notebooks");

  await mkdir(destinationParentDir, { recursive: true });
  await mkdir(destinationNotebooksDir, { recursive: true });

  try {
    const files = await copyTreeWithHashes(sourceNotebooksDir, destinationNotebooksDir, "notebooks");
    files.sort((left, right) => left.path.localeCompare(right.path));
    const manifest: NotesBackupManifest = {
      schemaVersion: notesBackupSchemaVersion,
      kind: "mathnotes-notes-backup",
      createdAt,
      appVersion: args.appVersion,
      contentRoot: "notebooks",
      containsProviderSecrets: false,
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      files
    };
    const manifestPath = path.join(temporaryDir, "backup-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(temporaryDir, backupDir);

    return {
      backupDir,
      manifestPath: path.join(backupDir, "backup-manifest.json"),
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes
    };
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

function assertBackupDestination(notesRootDir: string, destinationParentDir: string): void {
  const destinationRelativeToNotes = path.relative(notesRootDir, destinationParentDir);
  if (!destinationRelativeToNotes || (!destinationRelativeToNotes.startsWith("..") && !path.isAbsolute(destinationRelativeToNotes))) {
    throw new Error("备份位置不能位于当前笔记目录内部，请选择其他文件夹。");
  }
}

async function copyTreeWithHashes(sourceDir: string, destinationDir: string, relativeRoot: string): Promise<NotesBackupFile[]> {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const files: NotesBackupFile[] = [];
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    const relativePath = path.posix.join(relativeRoot, entry.name);

    if (entry.isSymbolicLink()) {
      throw new Error(`备份拒绝符号链接：${relativePath}`);
    }
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      files.push(...await copyTreeWithHashes(sourcePath, destinationPath, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;

    const metadata = await lstat(sourcePath);
    await copyFile(sourcePath, destinationPath);
    files.push({
      path: relativePath,
      size: metadata.size,
      sha256: await sha256File(destinationPath)
    });
  }
  return files;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function availableBackupDir(parentDir: string, baseName: string): Promise<string> {
  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = path.join(parentDir, suffix === 0 ? baseName : `${baseName}-${suffix}`);
    try {
      await lstat(candidate);
    } catch (error) {
      if (isMissingFile(error)) return candidate;
      throw error;
    }
  }
  throw new Error("同一时间戳的备份数量过多，请稍后重试。");
}

function backupTimestamp(isoDate: string): string {
  return isoDate.replace(/[-:]/g, "").replace("T", "-").replace(/\.\d{3}Z$/, "Z");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
