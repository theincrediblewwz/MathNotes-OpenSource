#!/usr/bin/env node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { requestLocal } from "./local_loopback_http.mjs";

const blockCount = 120;
const root = await mkdtemp(path.join(tmpdir(), "mathnotes-macos-long-session-"));
const notesRoot = path.join(root, "notes");
const userDataDir = path.join(root, "user-data");
const tempDir = path.join(root, "temp");
const bundlePath = path.resolve("output", "macos-sidecar", "core-server.mjs");
const token = "long-session-token-".padEnd(48, "l");
const companionPort = await findAvailablePort();
await writeLongSessionFixture(notesRoot, blockCount);

const child = spawn(process.execPath, [bundlePath], {
  stdio: ["ignore", "pipe", "inherit"],
  env: {
    ...process.env,
    MATHNOTES_LOCAL_TOKEN: token,
    MATHNOTES_COMPANION_TOKEN: token,
    MATHNOTES_COMPANION_PORT: String(companionPort),
    MATHNOTES_USER_DATA_DIR: userDataDir,
    MATHNOTES_NOTES_ROOT_DIR: notesRoot,
    MATHNOTES_TEMP_DIR: tempDir,
    MATHNOTES_APP_VERSION: "long-session-smoke"
  }
});

try {
  const ready = JSON.parse(await firstLine(child.stdout));
  const base = `http://${ready.host}:${ready.port}`;
  const query = "notebookId=performance&sessionId=long_session";
  const manifestStarted = performance.now();
  const manifest = await jsonGet(`${base}/local/v1/session/manifest?${query}`, token);
  const manifestMs = performance.now() - manifestStarted;
  assert(manifest.blocks.length === blockCount, `expected ${blockCount} blocks, got ${manifest.blocks.length}`);

  const initialIDs = manifest.blocks.slice(0, 12).map((block) => block.id);
  const firstScreenStarted = performance.now();
  const initialBlocks = await mapLimited(initialIDs, 6, (blockID) => (
    jsonGet(`${base}/local/v1/session/block?${query}&blockId=${blockID}`, token)
  ));
  const firstScreenMs = performance.now() - firstScreenStarted;
  assert(initialBlocks.every((block) => block.content.kind === "markdown"), "first screen contains a non-Markdown block");
  assert(initialBlocks.some((block) => block.content.html.includes("katex-html")), "KaTeX HTML fallback missing");

  const allStarted = performance.now();
  const allBlocks = await mapLimited(manifest.blocks.map((block) => block.id), 8, (blockID) => (
    jsonGet(`${base}/local/v1/session/block?${query}&blockId=${blockID}`, token)
  ));
  const allBlocksMs = performance.now() - allStarted;
  assert(allBlocks.length === blockCount, "not all blocks were fetched");
  assert(manifestMs < 3_000, `manifest took ${manifestMs.toFixed(1)} ms`);
  assert(firstScreenMs < 5_000, `first screen took ${firstScreenMs.toFixed(1)} ms`);
  assert(allBlocksMs < 20_000, `all blocks took ${allBlocksMs.toFixed(1)} ms`);

  const report = {
    version: 1,
    blockCount,
    initialBlockCount: initialBlocks.length,
    manifestMs: Number(manifestMs.toFixed(1)),
    firstScreenMs: Number(firstScreenMs.toFixed(1)),
    allBlocksMs: Number(allBlocksMs.toFixed(1)),
    generatedAt: new Date().toISOString()
  };
  const reportDir = path.resolve("output", "acceptance");
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, "macos-long-session.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `MACOS_LONG_SESSION_SMOKE_OK blocks=${blockCount} manifestMs=${report.manifestMs} firstScreenMs=${report.firstScreenMs} allBlocksMs=${report.allBlocksMs}`
  );
} finally {
  child.kill("SIGTERM");
  await waitForExit(child, 5_000).catch(() => child.kill("SIGKILL"));
  await rm(root, { recursive: true, force: true });
}

async function writeLongSessionFixture(notesRoot, count) {
  const now = "2026-07-29T00:00:00.000Z";
  const notebookDir = path.join(notesRoot, "notebooks", "performance");
  const sessionDir = path.join(notebookDir, "sessions", "long_session");
  const blocksDir = path.join(sessionDir, "blocks");
  await mkdir(blocksDir, { recursive: true });
  await writeFile(path.join(notebookDir, "notebook.json"), json({
    id: "performance",
    title: "性能验收",
    createdAt: now,
    updatedAt: now
  }));
  const blocks = [];
  for (let index = 1; index <= count; index += 1) {
    const id = String(index).padStart(4, "0");
    const blockPath = `blocks/${id}_note.md`;
    const markdown = [
      `## 内容段 ${index}`,
      "",
      `用于长 Session 稳定性验收的第 ${index} 个内容段。`,
      "",
      "$$",
      "\\begin{cases}",
      `u_${index}(t) + \\nabla p = 0, \\\\`,
      "\\nabla \\cdot u = 0.",
      "\\end{cases}",
      "$$"
    ].join("\n");
    await writeFile(path.join(sessionDir, blockPath), markdown);
    blocks.push({
      id,
      type: "markdown",
      path: blockPath,
      source: index % 3 === 0 ? "ai_transcription" : "user",
      status: "draft",
      readonly: false,
      editableByAi: false,
      renderInNote: true,
      createdAt: now,
      updatedAt: now
    });
  }
  await writeFile(path.join(sessionDir, "session.json"), json({
    id: "long_session",
    title: "120 块长 Session",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    blocks,
    locks: [],
    currentDraftPolicy: "append_only",
    exportPolicy: { includeMetadataComments: true, includeImageLinks: true }
  }));
}

async function jsonGet(url, bearer) {
  const response = await requestLocal(url, {
    headers: { Authorization: `Bearer ${bearer}` }
  });
  assert(response.status === 200, `${url} returned ${response.status}`);
  return JSON.parse(await response.text());
}

async function mapLimited(values, concurrency, task) {
  const output = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await task(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

function firstLine(stream) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    lines.once("line", resolve);
    lines.once("close", () => reject(new Error("sidecar exited before ready")));
  });
}

function waitForExit(processHandle, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("sidecar stop timed out")), timeoutMs);
    processHandle.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function findAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "unable to reserve a companion port");
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
