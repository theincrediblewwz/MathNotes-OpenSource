// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRecord } from "@mathnotes/shared";

describe("mathnotes-network-node CLI", () => {
  let root: string | undefined;
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("serves a temporary read-only fixture and releases the port on SIGTERM", async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-network-node-"));
    const notesRootDir = await createNotesFixture(root);
    const configPath = join(root, "network-node.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      host: "127.0.0.1",
      port: 0,
      userDataDir: join(root, "runtime"),
      notesRootDir,
      legacyTokenEnv: "MATHNOTES_HEADLESS_TEST_TOKEN"
    }), "utf8");

    child = spawn(process.execPath, [
      resolve(import.meta.dirname, "../../dist/headless/networkNodeCli.cjs"),
      "--config",
      configPath
    ], {
      env: { ...process.env, MATHNOTES_HEADLESS_TEST_TOKEN: "headless-secret" },
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    const readyLine = await readLine(child);
    expect(readyLine).not.toContain("headless-secret");
    const ready = JSON.parse(readyLine) as { url: string };
    const unauthorized = await fetch(`${ready.url}/api/v1/pairing/verify`);
    expect(unauthorized.status).toBe(401);
    const headers = { authorization: "Bearer headless-secret" };
    const catalog = await fetch(`${ready.url}/api/v1/pairing/verify`, { headers });
    await expect(catalog.json()).resolves.toMatchObject({
      targets: [{ notebookId: "analysis", sessionId: "lecture", title: "Lecture" }]
    });
    const manifest = await fetch(
      `${ready.url}/api/v2/companion/session/manifest?notebookId=analysis&sessionId=lecture`,
      { headers }
    );
    expect(manifest.status).toBe(200);
    await expect(manifest.json()).resolves.toMatchObject({ version: 2, title: "Lecture", blockCount: 1 });

    const challengeResponse = await fetch(`${ready.url}/api/v2/pairing/challenge`, {
      method: "POST",
      headers
    });
    expect(challengeResponse.status).toBe(201);
    const challenge = await challengeResponse.json() as { challengeId: string; userCode: string };
    const exchange = await fetch(`${ready.url}/api/v2/pairing/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        userCode: challenge.userCode,
        deviceLabel: "Headless PWA"
      })
    });
    expect(exchange.status).toBe(201);
    const issued = await exchange.json() as { token: string };
    const pairedCatalog = await fetch(`${ready.url}/api/v1/pairing/verify`, {
      headers: { authorization: `Bearer ${issued.token}` }
    });
    expect(pairedCatalog.status).toBe(200);
    await expect(pairedCatalog.json()).resolves.toMatchObject({
      targets: [{ notebookId: "analysis", sessionId: "lecture", title: "Lecture" }]
    });

    const url = ready.url;
    child.send?.({ type: "mathnotes-shutdown" });
    await waitForExit(child);
    await expect(fetch(`${url}/api/v1/health`)).rejects.toThrow();
    const stopped = await runCliOnce(["--config", configPath, "--status"], {
      MATHNOTES_HEADLESS_TEST_TOKEN: "headless-secret"
    });
    expect(stopped.code).toBe(3);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ state: "stopped", health: "not_applicable" });
  }, 20_000);

  it("preflights Tailscale Serve, reports ready, and detects a stale killed process", async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-network-node-"));
    const notesRootDir = await createNotesFixture(root);
    const configPath = join(root, "network-node-v2.json");
    const fixedPort = await getFreePort();
    await writeFile(configPath, JSON.stringify({
      version: 2,
      exposureMode: "tailscale_serve",
      advertisedUrlEnv: "MATHNOTES_HEADLESS_TEST_URL",
      port: fixedPort,
      userDataDir: join(root, "runtime"),
      notesRootDir,
      legacyTokenEnv: "MATHNOTES_HEADLESS_TEST_TOKEN"
    }), "utf8");
    const environment = {
      MATHNOTES_HEADLESS_TEST_TOKEN: "headless-secret",
      MATHNOTES_HEADLESS_TEST_URL: "https://mathnotes-test.example.ts.net"
    };

    const preflight = await runCliOnce(["--config", configPath, "--check"], environment);
    expect(preflight.code).toBe(0);
    expect(preflight.stdout).not.toContain("headless-secret");
    expect(JSON.parse(preflight.stdout)).toMatchObject({
      kind: "mathnotes-network-preflight",
      exposureMode: "tailscale_serve",
      listenHost: "127.0.0.1"
    });

    child = spawnNode(["--config", configPath], environment);
    const readyLine = await readLine(child);
    expect(readyLine).not.toContain("headless-secret");
    const ready = JSON.parse(readyLine) as { host: string; localUrl: string; advertisedUrl: string; url: string };
    expect(ready).toMatchObject({
      host: "127.0.0.1",
      advertisedUrl: "https://mathnotes-test.example.ts.net",
      url: "https://mathnotes-test.example.ts.net"
    });
    expect(ready.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const running = await runCliOnce(["--config", configPath, "--status"], environment);
    expect(running.code).toBe(0);
    expect(JSON.parse(running.stdout)).toMatchObject({
      state: "ready",
      health: "ok",
      exposureMode: "tailscale_serve"
    });

    child.kill("SIGKILL");
    await waitForExit(child);
    const stale = await runCliOnce(["--config", configPath, "--status"], environment);
    expect(stale.code).toBe(3);
    expect(JSON.parse(stale.stdout)).toMatchObject({
      state: "stale",
      health: "unreachable",
      reasonCode: "local_health_unreachable"
    });
  }, 20_000);
});

async function createNotesFixture(root: string): Promise<string> {
  const notesRootDir = join(root, "notes");
  const sessionDir = join(notesRootDir, "notebooks", "analysis", "sessions", "lecture");
  await mkdir(join(sessionDir, "blocks"), { recursive: true });
  await writeFile(join(sessionDir, "blocks", "0001.md"), "# Lecture\n\n$T_nx \\to Tx$\n", "utf8");
  const session: SessionRecord = {
    id: "lecture",
    title: "Lecture",
    status: "draft",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:01:00.000Z",
    currentDraftPolicy: "append_only",
    exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks: [{
      id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status: "draft",
      readonly: false, editableByAi: false, createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:01:00.000Z"
    }]
  };
  await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return notesRootDir;
}

function spawnNode(args: string[], environment: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [
    resolve(import.meta.dirname, "../../dist/headless/networkNodeCli.cjs"),
    ...args
  ], {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runCliOnce(args: string[], environment: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const processHandle = spawnNode(args, environment);
    let stdout = "";
    let stderr = "";
    processHandle.stdout?.setEncoding("utf8");
    processHandle.stderr?.setEncoding("utf8");
    processHandle.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    processHandle.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    processHandle.once("exit", (code) => resolveRun({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to reserve a test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function readLine(child: ChildProcess): Promise<string> {
  return new Promise((resolveLine, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) resolveLine(stdout.slice(0, newline));
    });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("exit", (code) => reject(new Error(`network node exited before ready (${code}): ${stderr}`)));
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error("network node did not stop")), 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}
