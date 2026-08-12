#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { requestLocal } from "./local_loopback_http.mjs";

const root = await mkdtemp(path.join(tmpdir(), "mathnotes-sidecar-smoke-"));
const bundlePath = path.resolve("output", "macos-sidecar", "core-server.mjs");
const token = "smoke-token-".padEnd(48, "s");
const companionToken = "companion-smoke-token-".padEnd(48, "c");
const companionPort = await findAvailablePort();
const child = spawn(process.execPath, [bundlePath], {
  stdio: ["ignore", "pipe", "inherit"],
  env: {
    ...process.env,
    MATHNOTES_LOCAL_TOKEN: token,
    MATHNOTES_COMPANION_TOKEN: companionToken,
    MATHNOTES_COMPANION_PORT: String(companionPort),
    MATHNOTES_USER_DATA_DIR: path.join(root, "user-data"),
    MATHNOTES_NOTES_ROOT_DIR: path.join(root, "notes"),
    MATHNOTES_TEMP_DIR: path.join(root, "temp"),
    MATHNOTES_APP_VERSION: "sidecar-smoke"
  }
});

try {
  const readyLine = await firstLine(child.stdout);
  if (readyLine.includes(token) || readyLine.includes(companionToken)) {
    throw new Error("ready message leaked a sidecar token");
  }
  const ready = JSON.parse(readyLine);
  if (ready.type !== "mathnotes.ready" || ready.host !== "127.0.0.1" || !Number.isInteger(ready.port)) {
    throw new Error(`invalid ready message: ${readyLine}`);
  }
  if (
    ready.companionHost?.host !== "0.0.0.0"
    || ready.companionHost.port !== companionPort
    || ready.companionHost.url !== `http://127.0.0.1:${companionPort}`
  ) {
    throw new Error(`invalid companion host ready message: ${readyLine}`);
  }
  const endpoint = `http://${ready.host}:${ready.port}`;
  const unauthorized = await requestLocal(`${endpoint}/local/v1/health`);
  if (unauthorized.status !== 401) throw new Error(`missing token returned ${unauthorized.status}`);
  const health = await requestLocal(`${endpoint}/local/v1/health`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (health.status !== 200) throw new Error(`health returned ${health.status}`);
  const pairing = await requestLocal(`${ready.companionHost.url}/api/v1/pairing/verify`, {
    headers: { Authorization: `Bearer ${companionToken}` }
  });
  if (pairing.status !== 200) throw new Error(`companion pairing check returned ${pairing.status}`);
  child.kill("SIGTERM");
  const exit = await waitForExit(child, 5_000);
  const windowsSystemTermination = process.platform === "win32" && exit.signal === "SIGTERM";
  if (exit.code !== 0 && !windowsSystemTermination) {
    throw new Error(`sidecar exited with ${exit.code ?? exit.signal}`);
  }
  console.log(`MACOS_SIDECAR_SMOKE_OK instance=${ready.instanceId} port=${ready.port}`);
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await rm(root, { recursive: true, force: true });
}

async function firstLine(stream) {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) return line;
  }
  throw new Error("sidecar exited before ready");
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
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("unable to reserve a companion smoke port");
  }
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}
