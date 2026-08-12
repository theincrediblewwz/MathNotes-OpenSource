#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requestLocal } from "./local_loopback_http.mjs";

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), "mathnotes-phase1e7-organize-"));
const notesRoot = path.join(fixture, "notes");
const sourceDir = path.join(notesRoot, "notebooks", "analysis", "sessions", "source");
const targetDir = path.join(notesRoot, "notebooks", "analysis", "sessions", "target");
const token = randomBytes(36).toString("base64url");
let child;

try {
  await createSession(sourceDir, "source", [
    ["0001", "甲"], ["0002", "乙"], ["0003", "丙"]
  ]);
  await createSession(targetDir, "target", [["0001", "目标正文"]]);
  child = spawn(process.execPath, [path.join(root, "output", "macos-sidecar", "core-server.mjs")], {
    env: {
      ...process.env,
      MATHNOTES_LOCAL_TOKEN: token,
      MATHNOTES_COMPANION_TOKEN: token,
      MATHNOTES_COMPANION_PORT: "19057",
      MATHNOTES_USER_DATA_DIR: path.join(fixture, "user-data"),
      MATHNOTES_NOTES_ROOT_DIR: notesRoot,
      MATHNOTES_TEMP_DIR: path.join(fixture, "temp"),
      MATHNOTES_APP_VERSION: "phase1e7-smoke"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const ready = await readReady(child.stdout);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `http://${ready.host}:${ready.port}`;
  const query = "notebookId=analysis&sessionId=source";

  const reordered = await requestLocal(`${base}/local/v1/session/blocks/reorder?${query}`, {
    method: "POST", headers,
    body: JSON.stringify({ blockIds: ["0003"], direction: "up" })
  });
  assert(reordered.status === 200, `reorder failed: ${reordered.status}`);
  assert((await readSession(sourceDir)).blocks.map((block) => block.id).join(",") === "0001,0003,0002",
    "reorder did not preserve stable ids");

  const copied = await requestLocal(`${base}/local/v1/session/blocks/transfer?${query}`, {
    method: "POST", headers,
    body: JSON.stringify({
      targetNotebookId: "analysis", targetSessionId: "target",
      blockIds: ["0003"], mode: "copy"
    })
  });
  assert(copied.status === 200, `copy failed: ${copied.status}`);
  const copyResult = JSON.parse(await copied.text());
  assert(copyResult.sourceCleanupPending === false, "copy unexpectedly reported cleanup");
  const target = await readSession(targetDir);
  assert(target.blocks.length === 2, "target did not receive copied block");
  assert(await readFile(path.join(targetDir, target.blocks[1].path), "utf8") === "丙\n",
    "copied Markdown bytes changed");

  const moved = await requestLocal(`${base}/local/v1/session/blocks/transfer?${query}`, {
    method: "POST", headers,
    body: JSON.stringify({
      targetNotebookId: "analysis", targetSessionId: "target",
      blockIds: ["0002"], mode: "move"
    })
  });
  assert(moved.status === 200, `move failed: ${moved.status}`);
  assert((await readSession(sourceDir)).blocks.map((block) => block.id).join(",") === "0001,0003",
    "move did not clean the source manifest");
  assert((await readSession(targetDir)).blocks.length === 3, "move did not append to target");

  const deleted = await requestLocal(`${base}/local/v1/session/blocks/delete?${query}`, {
    method: "POST", headers,
    body: JSON.stringify({ blockIds: ["0001"] })
  });
  assert(deleted.status === 200, `delete failed: ${deleted.status}`);
  const deleteResult = JSON.parse(await deleted.text());
  assert(deleteResult.manifest.blocks.map((block) => block.order).join(",") === "0",
    "delete response did not renumber remaining display order");
  assert((await readSession(sourceDir)).blocks.map((block) => block.id).join(",") === "0003",
    "delete did not update the source manifest");
  console.log("MACOS_PHASE1E7_BLOCK_ORGANIZE_SMOKE_OK reordered=1 copied=1 moved=1 deleted=1");
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await rm(fixture, { recursive: true, force: true });
}

async function createSession(sessionDir, id, entries) {
  await mkdir(path.join(sessionDir, "blocks"), { recursive: true });
  const blocks = [];
  for (const [blockId, markdown] of entries) {
    const relativePath = `blocks/${blockId}.md`;
    await writeFile(path.join(sessionDir, relativePath), `${markdown}\n`, "utf8");
    blocks.push({
      id: blockId, type: "markdown", path: relativePath, source: "user", status: "draft",
      readonly: false, editableByAi: false, renderInNote: true,
      createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z"
    });
  }
  await writeFile(path.join(sessionDir, "session.json"), `${JSON.stringify({
    id, title: id, status: "draft",
    createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z",
    currentDraftPolicy: "append_only",
    exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks
  }, null, 2)}\n`, "utf8");
}

async function readSession(sessionDir) {
  return JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
}

function readReady(stream) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(() => reject(new Error("sidecar ready timeout")), 8_000);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      text += chunk;
      const lineEnd = text.indexOf("\n");
      if (lineEnd < 0) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(text.slice(0, lineEnd))); }
      catch (error) { reject(error); }
    });
    stream.on("error", reject);
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
