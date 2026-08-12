import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256Canonical, sha256Text } from "./canonical";
import { createDeterministicEntityId } from "./ids";

export const legacyMigrationNamespaceId = "d792a3d3-990d-5b85-997a-74eb8d24686a";
export const legacyMigrationFixtureMarker = ".mathnotes-migration-fixture";
export const legacyMigrationOutputDir = ".sync-v3";

type LegacyLock = {
  id?: unknown;
  blockId?: unknown;
  kind?: unknown;
  contentHash?: unknown;
};

type LegacyBlock = {
  id?: unknown;
  type?: unknown;
  path?: unknown;
  source?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  [key: string]: unknown;
};

type LegacySession = {
  id?: unknown;
  title?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  blocks?: unknown;
  locks?: unknown;
};

export type LegacyBlockIdentity = {
  legacyId: string;
  stableId: string;
  legacyPath: string;
  type: string;
  source: string;
  revision: 1;
  baseRevision: null;
  writerId: string;
  operationId: string;
  contentHash: string;
  lockStateHash: string;
  deleted: false;
};

export type LegacySessionIdentity = {
  legacyId: string;
  stableId: string;
  legacyPath: string;
  orderRevision: 1;
  blockOrder: string[];
  blocks: LegacyBlockIdentity[];
};

export type LegacyNotebookIdentity = {
  legacyId: string;
  stableId: string;
  legacyPath: string;
  sessions: LegacySessionIdentity[];
};

export type LegacyIdentityManifest = {
  schemaVersion: 3;
  migrationVersion: 1;
  sourceKind: "mathnotes-legacy-files";
  namespaceId: string;
  sourceFingerprint: string;
  writerId: string;
  notebooks: LegacyNotebookIdentity[];
};

export type LegacyMigrationPlan = {
  mode: "dry-run";
  rootDir: string;
  sourceFingerprint: string;
  targetRelativePath: string;
  manifest: LegacyIdentityManifest;
  changes: Array<{
    kind: "create" | "replace";
    path: string;
    beforeHash: string | null;
    afterHash: string;
  }>;
  warnings: string[];
};

export type TreeSnapshot = {
  snapshotDir: string;
  sourceFingerprint: string;
  fileCount: number;
};

export async function planLegacyNotesMigration(rootDir: string): Promise<LegacyMigrationPlan> {
  const absoluteRoot = resolve(rootDir);
  const sourceTree = await describeTree(absoluteRoot, { excludeMigrationOutput: true });
  const sourceFingerprint = sha256Canonical(sourceTree);
  const notebooksDir = join(absoluteRoot, "notebooks");
  const notebooks = await readDirectories(notebooksDir);
  const writerId = createDeterministicEntityId(legacyMigrationNamespaceId, "writer/mathnotes-legacy-migration-v1");
  const warnings: string[] = [];

  const notebookIdentities: LegacyNotebookIdentity[] = [];
  for (const notebookDirName of notebooks) {
    const notebookRelativePath = toPortablePath(join("notebooks", notebookDirName));
    const notebookMetadata = await readOptionalJson(join(notebooksDir, notebookDirName, "notebook.json"));
    const notebookLegacyId = stringValue(notebookMetadata?.id) ?? notebookDirName;
    const notebookStableId = createDeterministicEntityId(
      legacyMigrationNamespaceId,
      `notebook/${notebookRelativePath}`
    );
    const sessionsDir = join(notebooksDir, notebookDirName, "sessions");
    const sessionIdentities: LegacySessionIdentity[] = [];

    for (const sessionDirName of await readDirectories(sessionsDir)) {
      const sessionRelativePath = toPortablePath(join(notebookRelativePath, "sessions", sessionDirName));
      const sessionPath = join(sessionsDir, sessionDirName, "session.json");
      const session = await readRequiredJson(sessionPath) as LegacySession;
      const sessionLegacyId = stringValue(session.id) ?? sessionDirName;
      const sessionStableId = createDeterministicEntityId(
        legacyMigrationNamespaceId,
        `session/${sessionRelativePath}`
      );
      const blocks = arrayValue<LegacyBlock>(session.blocks, `${sessionRelativePath}/session.json blocks`);
      const locks = arrayValue<LegacyLock>(session.locks ?? [], `${sessionRelativePath}/session.json locks`);
      const seenLegacyBlockIds = new Set<string>();
      const blockIdentities: LegacyBlockIdentity[] = [];

      for (const block of blocks) {
        const blockLegacyId = requiredString(block.id, `${sessionRelativePath} block id`);
        if (seenLegacyBlockIds.has(blockLegacyId)) {
          throw new Error(`LEGACY_DUPLICATE_BLOCK_ID:${sessionRelativePath}:${blockLegacyId}`);
        }
        seenLegacyBlockIds.add(blockLegacyId);
        const blockPath = requiredString(block.path, `${sessionRelativePath}/${blockLegacyId} path`);
        const blockStableId = createDeterministicEntityId(
          legacyMigrationNamespaceId,
          `block/${sessionRelativePath}/${blockLegacyId}`
        );
        const absoluteBlockPath = safeResolveWithin(join(sessionsDir, sessionDirName), blockPath);
        const content = block.type === "markdown"
          ? await readFile(absoluteBlockPath, "utf8")
          : canonicalJson({
              block,
              assetSha256: await sha256File(absoluteBlockPath)
            });
        const blockLocks = locks
          .filter((lock) => stringValue(lock.blockId) === blockLegacyId)
          .map((lock) => ({
            id: requiredString(lock.id, `${sessionRelativePath}/${blockLegacyId} lock id`),
            kind: requiredString(lock.kind, `${sessionRelativePath}/${blockLegacyId} lock kind`),
            contentHash: requiredString(lock.contentHash, `${sessionRelativePath}/${blockLegacyId} lock hash`)
          }))
          .sort((left, right) => left.id.localeCompare(right.id));
        const contentHash = sha256Text(content);
        const lockStateHash = sha256Canonical(blockLocks);
        const operationId = createDeterministicEntityId(
          legacyMigrationNamespaceId,
          `initial-operation/${blockStableId}/${contentHash}/${lockStateHash}`
        );

        blockIdentities.push({
          legacyId: blockLegacyId,
          stableId: blockStableId,
          legacyPath: toPortablePath(relative(absoluteRoot, absoluteBlockPath)),
          type: stringValue(block.type) ?? "unknown",
          source: stringValue(block.source) ?? "unknown",
          revision: 1,
          baseRevision: null,
          writerId,
          operationId,
          contentHash,
          lockStateHash,
          deleted: false
        });
      }

      sessionIdentities.push({
        legacyId: sessionLegacyId,
        stableId: sessionStableId,
        legacyPath: sessionRelativePath,
        orderRevision: 1,
        blockOrder: blockIdentities.map((block) => block.stableId),
        blocks: blockIdentities
      });
    }

    notebookIdentities.push({
      legacyId: notebookLegacyId,
      stableId: notebookStableId,
      legacyPath: notebookRelativePath,
      sessions: sessionIdentities
    });
  }

  if (notebookIdentities.length === 0) warnings.push("LEGACY_NOTES_ROOT_HAS_NO_NOTEBOOKS");
  const manifest: LegacyIdentityManifest = {
    schemaVersion: 3,
    migrationVersion: 1,
    sourceKind: "mathnotes-legacy-files",
    namespaceId: legacyMigrationNamespaceId,
    sourceFingerprint,
    writerId,
    notebooks: notebookIdentities
  };
  const targetRelativePath = `${legacyMigrationOutputDir}/identity-map.json`;
  const target = join(absoluteRoot, targetRelativePath);
  const before = await readOptionalText(target);
  const after = formatJson(manifest);
  const changes = before === after ? [] : [{
    kind: before === null ? "create" as const : "replace" as const,
    path: targetRelativePath,
    beforeHash: before === null ? null : sha256Text(before),
    afterHash: sha256Text(after)
  }];

  return {
    mode: "dry-run",
    rootDir: absoluteRoot,
    sourceFingerprint,
    targetRelativePath,
    manifest,
    changes,
    warnings
  };
}

export async function applyLegacyNotesMigration(args: {
  plan: LegacyMigrationPlan;
  allowFixtureWrite: true;
}): Promise<{ written: boolean; targetPath: string }> {
  await assertFixtureRoot(args.plan.rootDir);
  const freshPlan = await planLegacyNotesMigration(args.plan.rootDir);
  if (freshPlan.sourceFingerprint !== args.plan.sourceFingerprint) {
    throw new Error("LEGACY_MIGRATION_SOURCE_CHANGED");
  }
  if (canonicalJson(freshPlan.manifest) !== canonicalJson(args.plan.manifest)) {
    throw new Error("LEGACY_MIGRATION_PLAN_STALE");
  }
  const targetPath = join(args.plan.rootDir, args.plan.targetRelativePath);
  if (freshPlan.changes.length === 0) return { written: false, targetPath };
  await writeTextAtomic(targetPath, formatJson(args.plan.manifest));
  return { written: true, targetPath };
}

export async function createFixtureSnapshot(args: {
  rootDir: string;
  snapshotParentDir: string;
}): Promise<TreeSnapshot> {
  const rootDir = resolve(args.rootDir);
  await assertFixtureRoot(rootDir);
  const sourceTree = await describeTree(rootDir);
  const snapshotDir = join(resolve(args.snapshotParentDir), `mathnotes-migration-snapshot-${randomUUID()}`);
  await mkdir(dirname(snapshotDir), { recursive: true });
  await cp(rootDir, snapshotDir, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  const copiedTree = await describeTree(snapshotDir);
  if (canonicalJson(copiedTree) !== canonicalJson(sourceTree)) {
    await rm(snapshotDir, { recursive: true, force: true });
    throw new Error("LEGACY_MIGRATION_SNAPSHOT_VERIFY_FAILED");
  }
  return {
    snapshotDir,
    sourceFingerprint: sha256Canonical(sourceTree),
    fileCount: sourceTree.length
  };
}

export async function restoreFixtureSnapshot(args: {
  rootDir: string;
  snapshot: TreeSnapshot;
  allowDestructiveFixtureRestore: true;
}): Promise<void> {
  const rootDir = resolve(args.rootDir);
  const snapshotDir = resolve(args.snapshot.snapshotDir);
  await assertFixtureRoot(rootDir);
  await assertFixtureRoot(snapshotDir);
  const snapshotTree = await describeTree(snapshotDir);
  if (sha256Canonical(snapshotTree) !== args.snapshot.sourceFingerprint) {
    throw new Error("LEGACY_MIGRATION_SNAPSHOT_CHANGED");
  }

  const previousDir = `${rootDir}.rollback-${randomUUID()}`;
  await rename(rootDir, previousDir);
  try {
    await cp(snapshotDir, rootDir, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    const restoredTree = await describeTree(rootDir);
    if (sha256Canonical(restoredTree) !== args.snapshot.sourceFingerprint) {
      throw new Error("LEGACY_MIGRATION_ROLLBACK_VERIFY_FAILED");
    }
    await rm(previousDir, { recursive: true, force: true });
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    await rename(previousDir, rootDir);
    throw error;
  }
}

export async function fingerprintFixtureTree(rootDir: string): Promise<string> {
  return sha256Canonical(await describeTree(resolve(rootDir)));
}

async function assertFixtureRoot(rootDir: string): Promise<void> {
  const marker = join(resolve(rootDir), legacyMigrationFixtureMarker);
  try {
    const metadata = await lstat(marker);
    if (!metadata.isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`LEGACY_MIGRATION_FIXTURE_MARKER_REQUIRED:${marker}`);
  }
}

async function describeTree(rootDir: string, options: { excludeMigrationOutput?: boolean } = {}): Promise<Array<{
  path: string;
  size: number;
  sha256: string;
}>> {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  await walk(rootDir, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));

  async function walk(currentDir: string, relativeDir: string): Promise<void> {
    for (const entry of await readdir(currentDir, { withFileTypes: true })) {
      const relativePath = toPortablePath(join(relativeDir, entry.name));
      if (options.excludeMigrationOutput && (relativePath === legacyMigrationOutputDir || relativePath.startsWith(`${legacyMigrationOutputDir}/`))) {
        continue;
      }
      const absolutePath = join(currentDir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`LEGACY_MIGRATION_REJECTS_SYMLINK:${relativePath}`);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const metadata = await lstat(absolutePath);
      files.push({ path: relativePath, size: metadata.size, sha256: await sha256File(absolutePath) });
    }
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function readDirectories(rootDir: string): Promise<string[]> {
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

async function readRequiredJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function readOptionalJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return await readRequiredJson(filePath);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  const backup = `${filePath}.bak-${randomUUID()}`;
  await writeFile(temporary, content, "utf8");
  try {
    await rename(temporary, filePath);
  } catch (error) {
    if (!(await pathExists(filePath))) throw error;
    await rename(filePath, backup);
    try {
      await rename(temporary, filePath);
      await rm(backup, { force: true });
    } catch (replacementError) {
      await rm(filePath, { force: true });
      await rename(backup, filePath);
      throw replacementError;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function safeResolveWithin(rootDir: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error(`LEGACY_BLOCK_PATH_OUTSIDE_SESSION:${relativePath}`);
  const root = resolve(rootDir);
  const target = resolve(root, relativePath);
  const relation = relative(root, target);
  if (!relation || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) return target;
  throw new Error(`LEGACY_BLOCK_PATH_OUTSIDE_SESSION:${relativePath}`);
}

function toPortablePath(value: string): string {
  return value.split(sep).join(posix.sep);
}

function arrayValue<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`LEGACY_INVALID_ARRAY:${label}`);
  return value as T[];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (result === null) throw new Error(`LEGACY_INVALID_STRING:${label}`);
  return result;
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
