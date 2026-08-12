#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requestLocal } from "./local_loopback_http.mjs";

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), "mathnotes-phase1e-image-"));
const notesRoot = path.join(fixture, "notes");
const sessionDir = path.join(notesRoot, "notebooks", "analysis", "sessions", "lecture");
const token = randomBytes(36).toString("base64url");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let child;

try {
  await mkdir(path.join(sessionDir, "blocks"), { recursive: true });
  await writeFile(path.join(sessionDir, "blocks", "0001.md"), "## 原文\n");
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

  child = spawn(process.execPath, [path.join(root, "output", "macos-sidecar", "core-server.mjs")], {
    env: {
      ...process.env,
      MATHNOTES_LOCAL_TOKEN: token,
      MATHNOTES_COMPANION_TOKEN: token,
      MATHNOTES_COMPANION_PORT: "19051",
      MATHNOTES_USER_DATA_DIR: path.join(fixture, "user-data"),
      MATHNOTES_NOTES_ROOT_DIR: notesRoot,
      MATHNOTES_TEMP_DIR: path.join(fixture, "temp"),
      MATHNOTES_APP_VERSION: "phase1e2-smoke"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const ready = await readReady(child.stdout);
  const base = `http://${ready.host}:${ready.port}`;
  const headers = { Authorization: `Bearer ${token}` };
  const sessionQuery = "notebookId=analysis&sessionId=lecture";
  const manifest = await json(await requestLocal(`${base}/local/v1/session/manifest?${sessionQuery}`, { headers }));
  const imageQuery = `${sessionQuery}&fileName=${encodeURIComponent("课堂 截图.fake")}&baseRevision=${manifest.revision}`;
  const imageUrl = `${base}/local/v1/session/image?${imageQuery}`;

  assert((await requestLocal(imageUrl, { method: "POST", body: png })).status === 401, "image route accepted no token");
  const importedResponse = await requestLocal(imageUrl, {
    method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: png
  });
  assert(importedResponse.status === 200, `image import failed: ${importedResponse.status}`);
  const imported = await json(importedResponse);
  assert(imported.blockId === "0002", "image block was not appended in order");
  assert(imported.manifest.blocks.at(-1)?.type === "image", "refreshed manifest omitted the image block");

  const stale = await requestLocal(imageUrl, {
    method: "POST", headers: { ...headers, "Content-Type": "application/octet-stream" }, body: png
  });
  assert(stale.status === 409, `stale image import was not rejected: ${stale.status}`);
  assert((await json(stale)).error === "revision_conflict", "stale image import returned the wrong code");

  const session = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
  assert(session.blocks.length === 2, "stale request appended another block");
  const imagePath = session.blocks[1].path;
  assert(imagePath.startsWith("assets/photos/") && imagePath.endsWith(".png"), "asset path was not normalized");
  assert((await readFile(path.join(sessionDir, imagePath))).equals(png), "asset bytes changed on disk");
  console.log("MACOS_PHASE1E2_IMAGE_IMPORT_OK imported=1 staleRejected=1 residue=0");
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
