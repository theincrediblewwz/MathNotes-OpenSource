#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requestLocal } from "./local_loopback_http.mjs";

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), "mathnotes-phase1e4-export-"));
const notesRoot = path.join(fixture, "notes");
const sessionDir = path.join(notesRoot, "notebooks", "analysis", "sessions", "lecture");
const token = randomBytes(36).toString("base64url");
let child;

try {
  await mkdir(path.join(sessionDir, "blocks"), { recursive: true });
  await writeFile(path.join(sessionDir, "blocks", "0001.md"), "## 第三讲\n\n\\(T_n \\to T\\)\n");
  await writeFile(path.join(sessionDir, "session.json"), JSON.stringify({
    id: "lecture", title: "第三讲", status: "draft",
    createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T01:00:00.000Z",
    currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [], blocks: [{
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
      MATHNOTES_APP_VERSION: "phase1e4-smoke"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const ready = await readReady(child.stdout);
  const base = `http://${ready.host}:${ready.port}`;
  const headers = { Authorization: `Bearer ${token}` };
  const query = "notebookId=analysis&sessionId=lecture";
  const manifest = await json(await requestLocal(`${base}/local/v1/session/manifest?${query}`, { headers }));
  const exportUrl = `${base}/local/v1/session/export?${query}&baseRevision=${manifest.revision}`;
  assert((await requestLocal(exportUrl, { method: "POST" })).status === 401, "export accepted no token");
  const createdResponse = await requestLocal(exportUrl, { method: "POST", headers });
  assert(createdResponse.status === 200, `export failed: ${createdResponse.status}`);
  const createdText = await createdResponse.text();
  const created = JSON.parse(createdText);
  assert(created.relativeExportPath === "exports/lecture.md", "export did not return a portable identifier");
  assert(!createdText.includes(sessionDir), "export response leaked the session path");
  const download = await requestLocal(`${base}/local/v1/session/export?${query}`, { headers });
  assert(download.status === 200, `export download failed: ${download.status}`);
  const markdown = await download.text();
  assert(markdown.includes("$T_n \\to T$"), "download did not use portable math");
  assert(markdown === await readFile(path.join(sessionDir, "exports", "lecture.md"), "utf8"), "download differs from durable export");
  const stale = await requestLocal(`${base}/local/v1/session/export?${query}&baseRevision=${"a".repeat(64)}`, {
    method: "POST", headers
  });
  assert(stale.status === 409 && (await json(stale)).error === "revision_conflict", "stale export was not rejected");
  console.log("MACOS_PHASE1E4_EXPORT_OK auth=1 portable=1 staleRejected=1 pathFree=1 durable=1");
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
      try { resolve(JSON.parse(text.slice(0, lineEnd))); } catch (error) { reject(error); }
    });
    stream.on("error", reject);
  });
}

async function json(response) { return JSON.parse(await response.text()); }
function assert(condition, message) { if (!condition) throw new Error(message); }
