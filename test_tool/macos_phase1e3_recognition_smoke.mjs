#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requestLocal } from "./local_loopback_http.mjs";

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), "mathnotes-phase1e3-recognition-"));
const notesRoot = path.join(fixture, "notes");
const sessionDir = path.join(notesRoot, "notebooks", "analysis", "sessions", "lecture");
const token = randomBytes(36).toString("base64url");
let child;

try {
  await mkdir(path.join(sessionDir, "assets", "photos"), { recursive: true });
  await writeFile(path.join(sessionDir, "assets", "photos", "board.png"), Buffer.from([1, 2, 3]));
  await writeFile(path.join(sessionDir, "session.json"), JSON.stringify({
    id: "lecture", title: "第三讲", status: "draft",
    createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z",
    currentDraftPolicy: "append_only",
    exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks: [{
      id: "0001", type: "image", path: "assets/photos/board.png", source: "user", status: "draft",
      readonly: false, editableByAi: false, renderInNote: true,
      createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z"
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
      MATHNOTES_APP_VERSION: "phase1e3-smoke"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const ready = await readReady(child.stdout);
  const base = `http://${ready.host}:${ready.port}`;
  const query = "notebookId=analysis&sessionId=lecture";
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const route = `${base}/local/v1/session/recognition?${query}`;

  assert((await requestLocal(route, {
    method: "POST", body: JSON.stringify({ imageBlockId: "0001" })
  })).status === 401, "recognition route accepted no token");
  const createdResponse = await requestLocal(route, {
    method: "POST", headers, body: JSON.stringify({ imageBlockId: "0001" })
  });
  assert(createdResponse.status === 202, `recognition start failed: ${createdResponse.status}`);
  const created = await json(createdResponse);
  const task = await waitForTerminal(base, token, query, created.task.id);
  assert(task.status === "failed", `unconfigured provider did not fail explicitly: ${task.status}`);
  assert(task.failureKind === "provider_unavailable", `wrong unavailable failure kind: ${task.failureKind}`);
  assert(task.error?.includes("识别服务尚未配置"), `wrong unavailable error: ${task.error}`);

  const events = await json(await requestLocal(
    `${base}/local/v1/session/recognition/events?${query}&taskId=${encodeURIComponent(task.id)}`,
    { headers }
  ));
  assert(events.events.length >= 2, "recognition events were not replayable");
  assert(events.events.every((event, index, all) => index === 0 || event.sequence > all[index - 1].sequence),
    "recognition sequence was not monotonic");

  const session = JSON.parse(await readFile(path.join(sessionDir, "session.json"), "utf8"));
  assert(session.blocks.length === 2, "recognition did not append exactly one transcript block");
  assert(session.blocks[1].source === "ai_transcription", "recognition appended the wrong block type");
  const markdown = await readFile(path.join(sessionDir, session.blocks[1].path), "utf8");
  assert(markdown.includes("识别失败") && markdown.includes("识别服务尚未配置"),
    "failed recognition draft did not preserve a clear diagnosis");
  const jobs = JSON.parse(await readFile(path.join(sessionDir, "logs", "session_recognition_jobs.json"), "utf8"));
  assert(jobs.length === 1 && jobs[0].status === "failed", "terminal task was not persisted");
  console.log("MACOS_PHASE1E3_RECOGNITION_OK auth=1 task=1 replay=1 noMock=1 persisted=1");
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await rm(fixture, { recursive: true, force: true });
}

async function waitForTerminal(base, token, query, taskId) {
  for (let index = 0; index < 300; index += 1) {
    const response = await requestLocal(
      `${base}/local/v1/session/recognition?${query}&taskId=${encodeURIComponent(taskId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const task = (await json(response)).task;
    if (["succeeded", "failed", "cancelled"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`recognition task ${taskId} did not finish`);
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

async function json(response) { return JSON.parse(await response.text()); }
function assert(condition, message) { if (!condition) throw new Error(message); }
