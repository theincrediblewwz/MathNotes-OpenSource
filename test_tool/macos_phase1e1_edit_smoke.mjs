#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requestLocal } from "./local_loopback_http.mjs";

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), "mathnotes-phase1e-edit-"));
const notesRoot = path.join(fixture, "notes");
const sessionDir = path.join(notesRoot, "notebooks", "analysis", "sessions", "lecture");
const token = randomBytes(36).toString("base64url");
let child;

try {
  await mkdir(path.join(sessionDir, "blocks"), { recursive: true });
  await writeFile(path.join(sessionDir, "blocks", "0001.md"), "## 原文\n\n等待编辑\n");
  await writeFile(path.join(sessionDir, "session.json"), JSON.stringify({
    id: "lecture", title: "第三讲", status: "draft",
    createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T01:00:00.000Z",
    currentDraftPolicy: "append_only",
    exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks: [{
      id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status: "draft",
      readonly: false, editableByAi: false,
      createdAt: "2026-07-23T00:00:00.000Z", updatedAt: "2026-07-23T01:00:00.000Z"
    }]
  }, null, 2));

  const executable = process.execPath;
  child = spawn(executable, [path.join(root, "output", "macos-sidecar", "core-server.mjs")], {
    env: {
      ...process.env,
      MATHNOTES_LOCAL_TOKEN: token,
      MATHNOTES_COMPANION_TOKEN: token,
      MATHNOTES_COMPANION_PORT: "19051",
      MATHNOTES_USER_DATA_DIR: path.join(fixture, "user-data"),
      MATHNOTES_NOTES_ROOT_DIR: notesRoot,
      MATHNOTES_TEMP_DIR: path.join(fixture, "temp"),
      MATHNOTES_APP_VERSION: "phase1e-smoke"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const ready = await readReady(child.stdout);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const query = "notebookId=analysis&sessionId=lecture&blockId=0001";
  const blockUrl = `http://${ready.host}:${ready.port}/local/v1/session/block?${query}`;
  const before = await json(await requestLocal(blockUrl, { headers }));
  const baseRevision = before.content.baseRevision;
  assert(/^[a-f0-9]{64}$/.test(baseRevision), "missing base revision");

  const savedResponse = await requestLocal(blockUrl, {
    method: "POST", headers,
    body: JSON.stringify({ markdown: "## 新正文\n\n已安全保存\n", baseRevision })
  });
  assert(savedResponse.status === 200, `save failed: ${savedResponse.status}`);
  const saved = await json(savedResponse);
  assert(saved.block.content.markdown.includes("已安全保存"), "saved payload did not refresh");
  assert(saved.block.content.baseRevision !== baseRevision, "revision did not rotate");

  const stale = await requestLocal(blockUrl, {
    method: "POST", headers,
    body: JSON.stringify({ markdown: "不应覆盖", baseRevision })
  });
  assert(stale.status === 409, `stale save was not rejected: ${stale.status}`);
  assert((await json(stale)).error === "revision_conflict", "stale save returned the wrong code");
  assert((await readFile(path.join(sessionDir, "blocks", "0001.md"), "utf8")).includes("已安全保存"), "stale save overwrote disk");
  console.log("MACOS_PHASE1E1_EDIT_SMOKE_OK saved=1 staleRejected=1");
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await rm(fixture, { recursive: true, force: true });
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

async function json(response) {
  return JSON.parse(await response.text());
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
