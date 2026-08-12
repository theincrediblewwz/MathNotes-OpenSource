import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPhase0b3Event,
  collectPhase0b3Evidence,
  createPhase0b3RunId,
  createPhase0b3Paths,
  initializePhase0b3Run,
  resolveWithin
} from "./macos_phase0b3_acceptance_lib.mjs";

test("phase0b3 default run id removes ISO milliseconds", () => {
  assert.equal(
    createPhase0b3RunId(new Date("2026-07-23T06:48:06.645Z"), 0xef917f),
    "phase0b3-20260723T064806Z-917f00"
  );
});

test("phase0b3 paths remain inside the dedicated acceptance root", () => {
  const paths = createPhase0b3Paths({ homeDir: "/Users/mathnotes", runId: "phase0b3-20260723T120000Z-a1b2c3" });
  assert.equal(paths.runRoot, path.resolve("/Users/mathnotes/data/MathNotes-dev/acceptance/phase0b3/phase0b3-20260723T120000Z-a1b2c3"));
  assert.throws(() => resolveWithin(paths.acceptanceRoot, "../notes"), /PHASE0B3_PATH_OUTSIDE_ROOT/);
  assert.throws(
    () => createPhase0b3Paths({ homeDir: "/Users/mathnotes", runId: "../../real-notes" }),
    /PHASE0B3_RUN_ID_INVALID/
  );
});

test("phase0b3 collector requires all real workflow evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mathnotes-phase0b3-test-"));
  try {
    const homeDir = path.join(root, "Users", "mathnotes");
    const paths = createPhase0b3Paths({ homeDir, runId: "phase0b3-20260723T120000Z-a1b2c3" });
    const appPath = path.join(root, "MathNotes.app");
    const binaryPath = path.join(appPath, "Contents", "MacOS", "MathNotes");
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, "fixture binary");
    await initializePhase0b3Run({ paths, appPath, sourceCommit: "e624c15", now: new Date("2026-07-23T12:00:00Z") });

    const sessionRoot = path.join(paths.notesRoot, "notebooks", "math", "sessions", "lecture");
    await mkdir(path.join(sessionRoot, "blocks"), { recursive: true });
    await mkdir(path.join(sessionRoot, "assets", "photos"), { recursive: true });
    await mkdir(path.join(sessionRoot, "exports"), { recursive: true });
    await writeFile(path.join(sessionRoot, "assets", "photos", "board.jpg"), "photo");
    await writeFile(path.join(sessionRoot, "blocks", "0001.md"), "draft");
    await writeFile(path.join(sessionRoot, "exports", "lecture.md"), "export");
    await writeFile(path.join(sessionRoot, "session.json"), JSON.stringify({
      id: "lecture",
      blocks: [{ id: "0001", source: "ai_transcription", editable_by_ai: false, locks: [{ id: "lock-1" }] }]
    }));
    for (const event of [
      "window_visible",
      "notebook_created",
      "session_created",
      "android_upload_started",
      "android_upload_landed",
      "provider_first_token",
      "draft_written",
      "block_edited",
      "block_locked",
      "markdown_exported",
      "app_restarted",
      "state_restored"
    ]) {
      await appendPhase0b3Event({ paths, event, now: new Date("2026-07-23T12:00:01Z") });
    }

    const summary = await collectPhase0b3Evidence({ paths, now: new Date("2026-07-23T12:10:00Z") });
    assert.equal(summary.passed, true);
    assert.deepEqual(summary.gates, {
      notebookAndSession: true,
      androidUpload: true,
      providerDraft: true,
      editAndLock: true,
      markdownExport: true,
      restartRecovery: true
    });
    assert.equal(JSON.parse(await readFile(paths.summaryPath, "utf8")).passed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("phase0b3 collector reports incomplete evidence without inventing success", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mathnotes-phase0b3-empty-"));
  try {
    const paths = createPhase0b3Paths({
      homeDir: path.join(root, "Users", "wu"),
      runId: "phase0b3-20260723T120000Z-a1b2c3"
    });
    const appPath = path.join(root, "MathNotes.app");
    const binaryPath = path.join(appPath, "Contents", "MacOS", "MathNotes");
    await mkdir(path.dirname(binaryPath), { recursive: true });
    await writeFile(binaryPath, "fixture binary");
    await initializePhase0b3Run({ paths, appPath, sourceCommit: "e624c15" });
    const summary = await collectPhase0b3Evidence({ paths });
    assert.equal(summary.passed, false);
    assert.equal(Object.values(summary.gates).some(Boolean), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
