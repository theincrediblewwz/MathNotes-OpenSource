#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { requestLocal } from "./local_loopback_http.mjs";

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), "mathnotes-phase1e5-provider-"));
const token = randomBytes(36).toString("base64url");
const secret = "black-box-memory-only-key";
let child;

try {
  child = await launch();
  const ready = await readReady(child.stdout);
  const base = `http://${ready.host}:${ready.port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  assert((await requestLocal(`${base}/local/v1/provider`)).status === 401, "provider status accepted no token");
  const unavailable = await requestLocal(`${base}/local/v1/provider/test`, {
    method: "POST", headers
  });
  assert(unavailable.status === 503, `unconfigured provider test must be rejected: ${unavailable.status}`);
  assert(JSON.parse(await unavailable.text()).error === "provider_unavailable", "unconfigured provider test lost its sanitized code");
  const configured = await requestLocal(`${base}/local/v1/provider`, {
    method: "POST", headers,
    body: JSON.stringify({
      providerId: "mimo_2_5", model: "mimo-v2.5",
      baseUrl: "https://api.xiaomimimo.com/v1", apiKey: secret
    })
  });
  assert(configured.status === 200, `provider configure failed: ${configured.status}`);
  const configuredText = await configured.text();
  assert(!configuredText.includes(secret), "provider response leaked the key");
  assert(JSON.parse(configuredText).configured === true, "provider did not become configured");
  const assistantSecret = "assistant-memory-only-key";
  const configuredAssistant = await requestLocal(`${base}/local/v1/provider?purpose=assistant`, {
    method: "POST", headers,
    body: JSON.stringify({
      providerId: "glm_5_2", model: "glm-5.2v",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: assistantSecret
    })
  });
  assert(configuredAssistant.status === 200, `assistant provider configure failed: ${configuredAssistant.status}`);
  const assistantText = await configuredAssistant.text();
  assert(!assistantText.includes(assistantSecret), "assistant provider response leaked the key");
  assert(JSON.parse(assistantText).inherited === false, "assistant provider did not stay independent");
  const assistantStatus = await requestLocal(`${base}/local/v1/provider?purpose=assistant`, { headers });
  const assistantStatusText = await assistantStatus.text();
  assert(JSON.parse(assistantStatusText).model === "glm-5.2v", "assistant purpose status did not reach the registry");
  const recognitionStatus = await requestLocal(`${base}/local/v1/provider`, { headers });
  assert(JSON.parse(await recognitionStatus.text()).model === "mimo-v2.5", "recognition purpose leaked into assistant");
  child.kill("SIGTERM");
  await waitForExit(child);

  child = await launch();
  const restarted = await readReady(child.stdout);
  const restartedStatus = await requestLocal(`http://${restarted.host}:${restarted.port}/local/v1/provider`, { headers });
  const restartedText = await restartedStatus.text();
  assert(JSON.parse(restartedText).configured === false, "sidecar persisted a runtime key across restart");
  assert(!restartedText.includes(secret), "restart response leaked the key");
  console.log("MACOS_PHASE1E5_PROVIDER_OK auth=1 redacted=1 memoryOnly=1 paidCalls=0");
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await rm(fixture, { recursive: true, force: true });
}

function launch() {
  return spawn(process.execPath, [path.join(root, "output", "macos-sidecar", "core-server.mjs")], {
    env: {
      ...process.env,
      MATHNOTES_LOCAL_TOKEN: token,
      MATHNOTES_COMPANION_TOKEN: token,
      MATHNOTES_COMPANION_PORT: "19051",
      MATHNOTES_USER_DATA_DIR: path.join(fixture, "user-data"),
      MATHNOTES_NOTES_ROOT_DIR: path.join(fixture, "notes"),
      MATHNOTES_TEMP_DIR: path.join(fixture, "temp"),
      MATHNOTES_APP_VERSION: "phase1e5-smoke"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
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

function waitForExit(process) {
  if (process.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => process.once("exit", resolve));
}

function assert(condition, message) { if (!condition) throw new Error(message); }
