#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const root = await mkdtemp(path.join(tmpdir(), "mathnotes-phase1d-smoke-"));
const notesRoot = path.join(root, "notes");
const bundlePath = path.resolve("output", "macos-sidecar", "core-server.mjs");
const token = "phase1d-token-".padEnd(48, "s");
await run(process.execPath, [path.resolve("test_tool", "create_macos_phase1d_fixture.mjs"), notesRoot]);
const child = spawn(process.execPath, [bundlePath], {
  stdio: ["ignore", "pipe", "inherit"],
  env: {
    ...process.env,
    MATHNOTES_LOCAL_TOKEN: token,
    MATHNOTES_COMPANION_TOKEN: token,
    MATHNOTES_COMPANION_PORT: "19051",
    MATHNOTES_USER_DATA_DIR: path.join(root, "user-data"),
    MATHNOTES_NOTES_ROOT_DIR: notesRoot,
    MATHNOTES_TEMP_DIR: path.join(root, "temp"),
    MATHNOTES_APP_VERSION: "phase1d-smoke"
  }
});

try {
  const ready = JSON.parse(await firstLine(child.stdout));
  const base = `http://${ready.host}:${ready.port}`;
  const query = "notebookId=functional_analysis&sessionId=lecture_03";
  const unauthorized = await httpGet(`${base}/local/v1/session/manifest?${query}`);
  assert(unauthorized.status === 401, `unauthorized manifest returned ${unauthorized.status}`);

  const catalog = await jsonGet(`${base}/local/v1/catalog`, token);
  assert(catalog.notebooks?.[0]?.title === "泛函分析", "catalog fixture missing");
  const manifestStarted = performance.now();
  const manifestResponse = await httpGet(`${base}/local/v1/session/manifest?${query}`, token);
  const manifestMs = performance.now() - manifestStarted;
  const manifestText = manifestResponse.body.toString("utf8");
  const manifest = JSON.parse(manifestText);
  assert(manifest.blocks.length === 12, `expected 12 blocks, got ${manifest.blocks.length}`);
  assert(manifest.blocks[0].id === "0001" && manifest.blocks[11].id === "0012", "block order changed");
  assert(!manifestText.includes(notesRoot), "manifest leaked an absolute path");

  const blockStarted = performance.now();
  const block = await jsonGet(`${base}/local/v1/session/block?${query}&blockId=0001`, token);
  const firstBlockMs = performance.now() - blockStarted;
  assert(block.content.kind === "markdown", "first block is not markdown");
  assert(block.content.html.includes("<math"), "math was not rendered");
  assert(block.content.html.includes("data:image/png;base64,"), "embedded image was not inlined");
  assert(!block.content.html.includes("<script>window.bad"), "raw HTML executed");

  const pdf = await httpGet(
    `${base}/local/v1/session/asset?${query}&path=${encodeURIComponent("assets/pdfs/lecture-handout.pdf")}`,
    token
  );
  assert(pdf.status === 200 && pdf.body.subarray(0, 4).toString("ascii") === "%PDF", "PDF asset failed");
  console.log(
    `MACOS_PHASE1D_CONTENT_SMOKE_OK blocks=12 fetchedBodies=1 assets=1 manifestMs=${manifestMs.toFixed(1)} firstBlockMs=${firstBlockMs.toFixed(1)}`
  );
} finally {
  child.kill("SIGTERM");
  await waitForExit(child, 5_000).catch(() => child.kill("SIGKILL"));
  await rm(root, { recursive: true, force: true });
}

function httpGet(url, bearer) {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function jsonGet(url, bearer) {
  const response = await httpGet(url, bearer);
  assert(response.status === 200, `${url} returned ${response.status}`);
  return JSON.parse(response.body.toString("utf8"));
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

function run(command, args) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, { stdio: "ignore" });
    childProcess.once("error", reject);
    childProcess.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
