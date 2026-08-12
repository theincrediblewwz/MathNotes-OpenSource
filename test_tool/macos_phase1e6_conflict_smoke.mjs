#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requestLocal } from "./local_loopback_http.mjs";

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), "mathnotes-phase1e6-conflict-"));
const notesRoot = path.join(fixture, "notes");
const sessionDir = path.join(notesRoot, "notebooks", "analysis", "sessions", "lecture");
const token = randomBytes(36).toString("base64url");
let child;

try {
  await mkdir(path.join(sessionDir, "blocks"), { recursive: true });
  await writeFile(path.join(sessionDir, "blocks", "0001.md"), "## 原文\n\n共同基线\n");
  await writeFile(path.join(sessionDir, "session.json"), JSON.stringify({
    id: "lecture", title: "第三讲", status: "draft",
    createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T01:00:00.000Z",
    currentDraftPolicy: "append_only",
    exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks: [{
      id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status: "draft",
      readonly: false, editableByAi: false,
      createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T01:00:00.000Z"
    }]
  }, null, 2));

  child = spawn(process.execPath, [path.join(root, "output", "macos-sidecar", "core-server.mjs")], {
    env: {
      ...process.env,
      MATHNOTES_LOCAL_TOKEN: token,
      MATHNOTES_COMPANION_TOKEN: token,
      MATHNOTES_COMPANION_PORT: "19051",
      MATHNOTES_USER_DATA_DIR: path.join(fixture, "user-data"),
      MATHNOTES_NOTES_ROOT_DIR: notesRoot,
      MATHNOTES_TEMP_DIR: path.join(fixture, "temp"),
      MATHNOTES_APP_VERSION: "phase1e6-smoke"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const ready = await readReady(child.stdout);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const sessionQuery = "notebookId=analysis&sessionId=lecture";
  const blockUrl = `http://${ready.host}:${ready.port}/local/v1/session/block?${sessionQuery}&blockId=0001`;
  const before = await json(await requestLocal(blockUrl, { headers }));
  const baseRevision = before.content.baseRevision;

  const accepted = await json(await requestLocal(blockUrl, {
    method: "POST", headers,
    body: JSON.stringify({ markdown: "当前版本", baseRevision })
  }));
  const currentRevision = accepted.block.content.baseRevision;

  const staleResponse = await requestLocal(blockUrl, {
    method: "POST", headers,
    body: JSON.stringify({ markdown: "离线来稿", baseRevision })
  });
  assert(staleResponse.status === 409, `stale save was not rejected: ${staleResponse.status}`);
  const stale = await json(staleResponse);
  assert(stale.error === "revision_conflict", "wrong stale error");
  assert(/^[a-f0-9]{64}$/.test(stale.conflictId), "missing durable conflict id");
  assert(await readFile(path.join(sessionDir, "blocks", "0001.md"), "utf8") === "当前版本", "canonical block changed");

  const conflictQuery = `${sessionQuery}&conflictId=${stale.conflictId}`;
  const detail = await json(await requestLocal(
    `http://${ready.host}:${ready.port}/local/v1/session/conflict?${conflictQuery}`, { headers }
  ));
  assert(detail.currentMarkdown === "当前版本", "current conflict side missing");
  assert(detail.incomingMarkdown === "离线来稿", "incoming conflict side missing");

  const replay = await json(await requestLocal(blockUrl, {
    method: "POST", headers,
    body: JSON.stringify({ markdown: "离线来稿", baseRevision })
  }));
  assert(replay.conflictId === stale.conflictId, "stale replay created a second conflict");

  const resolved = await json(await requestLocal(
    `http://${ready.host}:${ready.port}/local/v1/session/conflict/resolve?${conflictQuery}`,
    {
      method: "POST", headers,
      body: JSON.stringify({ resolution: "merged", markdown: "当前版本\n\n离线来稿", baseRevision: currentRevision })
    }
  ));
  assert(resolved.resolved === true && resolved.conflict.status === "resolved_merged", "merge did not resolve");
  assert(await readFile(path.join(sessionDir, "blocks", "0001.md"), "utf8") === "当前版本\n\n离线来稿", "merge not written");
  assert(await readFile(path.join(sessionDir, ".mathnotes", "conflicts", stale.conflictId, "incoming.md"), "utf8") === "离线来稿", "audit sidecar removed");
  console.log(`MACOS_PHASE1E6_CONFLICT_SMOKE_OK conflict=${stale.conflictId.slice(0, 12)} resolved=merged`);
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
