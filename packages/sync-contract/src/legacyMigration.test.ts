import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLegacyNotesMigration,
  createFixtureSnapshot,
  fingerprintFixtureTree,
  isUuidV5,
  legacyMigrationFixtureMarker,
  planLegacyNotesMigration,
  restoreFixtureSnapshot
} from "./index";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("legacy Sync Contract v3 migration", () => {
  it("plans without writing, adds deterministic identities, and has no second-run changes", async () => {
    const rootDir = await createLegacyFixture();
    const sessionPath = join(rootDir, "notebooks", "analysis", "sessions", "lecture", "session.json");
    const originalSession = await readFile(sessionPath, "utf8");

    const firstPlan = await planLegacyNotesMigration(rootDir);
    expect(firstPlan.changes).toHaveLength(1);
    expect(firstPlan.changes[0]).toMatchObject({ kind: "create", path: ".sync-v3/identity-map.json" });
    expect(firstPlan.manifest.notebooks).toHaveLength(1);
    const notebook = firstPlan.manifest.notebooks[0];
    const session = notebook.sessions[0];
    expect(isUuidV5(notebook.stableId)).toBe(true);
    expect(isUuidV5(session.stableId)).toBe(true);
    expect(session.blockOrder).toHaveLength(2);
    expect(session.blocks.every((block) => isUuidV5(block.stableId) && block.revision === 1)).toBe(true);
    await expect(readFile(join(rootDir, ".sync-v3", "identity-map.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const applied = await applyLegacyNotesMigration({ plan: firstPlan, allowFixtureWrite: true });
    expect(applied.written).toBe(true);
    const secondPlan = await planLegacyNotesMigration(rootDir);
    expect(secondPlan.changes).toEqual([]);
    expect(secondPlan.manifest).toEqual(firstPlan.manifest);
    expect(await readFile(sessionPath, "utf8")).toBe(originalSession);
  });

  it("keeps stable IDs when legacy content changes but plans a new initial revision payload", async () => {
    const rootDir = await createLegacyFixture();
    const firstPlan = await planLegacyNotesMigration(rootDir);
    await applyLegacyNotesMigration({ plan: firstPlan, allowFixtureWrite: true });
    const firstBlock = firstPlan.manifest.notebooks[0].sessions[0].blocks[0];

    await writeFile(
      join(rootDir, "notebooks", "analysis", "sessions", "lecture", "blocks", "0001_user_note.md"),
      "## Updated theorem\n\n$$y^2$$\n",
      "utf8"
    );
    const changedPlan = await planLegacyNotesMigration(rootDir);
    const changedBlock = changedPlan.manifest.notebooks[0].sessions[0].blocks[0];
    expect(changedPlan.changes).toHaveLength(1);
    expect(changedPlan.changes[0].kind).toBe("replace");
    expect(changedBlock.stableId).toBe(firstBlock.stableId);
    expect(changedBlock.contentHash).not.toBe(firstBlock.contentHash);
    expect(changedBlock.operationId).not.toBe(firstBlock.operationId);

    const reapplied = await applyLegacyNotesMigration({ plan: changedPlan, allowFixtureWrite: true });
    expect(reapplied.written).toBe(true);
    expect((await planLegacyNotesMigration(rootDir)).changes).toEqual([]);
  });

  it("includes referenced asset bytes in non-Markdown block revisions", async () => {
    const rootDir = await createLegacyFixture();
    const firstPlan = await planLegacyNotesMigration(rootDir);
    const firstImage = firstPlan.manifest.notebooks[0].sessions[0].blocks[1];

    await writeFile(
      join(rootDir, "notebooks", "analysis", "sessions", "lecture", "assets", "photos", "board.jpg"),
      Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])
    );
    const changedPlan = await planLegacyNotesMigration(rootDir);
    const changedImage = changedPlan.manifest.notebooks[0].sessions[0].blocks[1];

    expect(changedImage.stableId).toBe(firstImage.stableId);
    expect(changedImage.contentHash).not.toBe(firstImage.contentHash);
    expect(changedImage.operationId).not.toBe(firstImage.operationId);
  });

  it("restores an exact pre-migration fixture snapshot", async () => {
    const rootDir = await createLegacyFixture();
    const snapshotParentDir = await temporaryDir("mathnotes-migration-snapshots-");
    const before = await fingerprintFixtureTree(rootDir);
    const snapshot = await createFixtureSnapshot({ rootDir, snapshotParentDir });
    const plan = await planLegacyNotesMigration(rootDir);
    await applyLegacyNotesMigration({ plan, allowFixtureWrite: true });
    await writeFile(join(rootDir, "extra-after-migration.txt"), "must disappear", "utf8");
    expect(await fingerprintFixtureTree(rootDir)).not.toBe(before);

    await restoreFixtureSnapshot({
      rootDir,
      snapshot,
      allowDestructiveFixtureRestore: true
    });

    expect(await fingerprintFixtureTree(rootDir)).toBe(before);
    await expect(readFile(join(rootDir, ".sync-v3", "identity-map.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(rootDir, "extra-after-migration.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses any migration write without the explicit fixture marker", async () => {
    const rootDir = await createLegacyFixture({ marker: false });
    const plan = await planLegacyNotesMigration(rootDir);
    await expect(applyLegacyNotesMigration({ plan, allowFixtureWrite: true }))
      .rejects.toThrow("LEGACY_MIGRATION_FIXTURE_MARKER_REQUIRED");
  });
});

async function createLegacyFixture(options: { marker?: boolean } = {}): Promise<string> {
  const rootDir = await temporaryDir("mathnotes-legacy-fixture-");
  const sessionDir = join(rootDir, "notebooks", "analysis", "sessions", "lecture");
  await mkdir(join(sessionDir, "blocks"), { recursive: true });
  await mkdir(join(sessionDir, "assets", "photos"), { recursive: true });
  if (options.marker !== false) await writeFile(join(rootDir, legacyMigrationFixtureMarker), "fixture only\n", "utf8");
  await writeFile(
    join(rootDir, "notebooks", "analysis", "notebook.json"),
    `${JSON.stringify({ id: "functional_analysis", title: "泛函分析", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(join(sessionDir, "blocks", "0001_user_note.md"), "## Theorem\n\n$$x^2$$\n", "utf8");
  await writeFile(join(sessionDir, "assets", "photos", "board.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(
    join(sessionDir, "session.json"),
    `${JSON.stringify({
      id: "lecture_01",
      title: "泛函分析第 1 讲",
      status: "draft",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      blocks: [
        {
          id: "0001",
          type: "markdown",
          path: "blocks/0001_user_note.md",
          source: "user",
          status: "reviewed",
          readonly: false,
          editableByAi: false,
          createdAt: "2026-07-01T00:00:00.000Z",
          updatedAt: "2026-07-01T00:00:00.000Z"
        },
        {
          id: "0002",
          type: "image",
          path: "assets/photos/board.jpg",
          source: "android_camera",
          status: "draft",
          readonly: false,
          editableByAi: false,
          createdAt: "2026-07-01T00:01:00.000Z",
          updatedAt: "2026-07-01T00:01:00.000Z"
        }
      ],
      locks: [
        {
          id: "lock-legacy-1",
          blockId: "0001",
          kind: "block",
          contentHash: "legacy-lock-hash",
          createdAt: "2026-07-01T00:02:00.000Z",
          createdBy: "user",
          aiEditable: false
        }
      ],
      currentDraftPolicy: "append_only",
      exportPolicy: { includeMetadataComments: true, includeImageLinks: true }
    }, null, 2)}\n`,
    "utf8"
  );
  return rootDir;
}

async function temporaryDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}
