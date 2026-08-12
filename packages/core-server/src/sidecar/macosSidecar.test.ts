import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "@mathnotes/shared";
import { RuntimeProviderRegistry } from "../provider/runtimeProviderRegistry";
import { parseSidecarParentPid, startMacosSidecar } from "./macosSidecar";

describe("macOS sidecar", () => {
  let rootDir: string | undefined;

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("accepts only a different positive parent process id", () => {
    expect(parseSidecarParentPid(undefined, 100)).toBeUndefined();
    expect(parseSidecarParentPid("101", 100)).toBe(101);
    expect(() => parseSidecarParentPid("100", 100)).toThrow("different running process");
    expect(() => parseSidecarParentPid("not-a-pid", 100)).toThrow("different running process");
  });

  it("publishes a token-free ready contract and protects loopback health", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-sidecar-"));
    const token = "s".repeat(48);
    const running = await startMacosSidecar({
      token,
      userDataDir: join(rootDir, "user-data"),
      notesRootDir: join(rootDir, "notes"),
      tempDir: join(rootDir, "temp"),
      appVersion: "test",
      instanceId: "instance-test",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    const endpoint = `http://${running.ready.host}:${running.ready.port}`;
    try {
      expect(running.ready).toEqual({
        type: "mathnotes.ready",
        apiVersion: 1,
        instanceId: "instance-test",
        host: "127.0.0.1",
        port: expect.any(Number)
      });
      expect(running.core.environment.platformCapabilities).toMatchObject({
        canListenOnLan: true,
        canSpawnProcesses: true,
        canWatchFiles: true
      });
      expect(JSON.stringify(running.ready)).not.toContain(token);
      expect((await requestHealth(endpoint)).status).toBe(401);
      expect((await requestHealth(endpoint, "wrong-token")).status).toBe(401);
      const health = await requestHealth(endpoint, token);
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ ok: true, apiVersion: 1 });
    } finally {
      await running.stop();
    }
    await expect(requestHealth(endpoint)).rejects.toThrow();
  });

  it("wires one authenticated image recognition turn through the running sidecar", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-sidecar-recognition-"));
    const notesRootDir = join(rootDir, "notes");
    const sessionDir = await writeRecognitionFixture(notesRootDir);
    const token = "r".repeat(48);
    const running = await startMacosSidecar({
      token,
      userDataDir: join(rootDir, "user-data"),
      notesRootDir,
      tempDir: join(rootDir, "temp"),
      appVersion: "test",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providerFactory: {
        async createRecognitionProvider() {
          return {
            name: "sidecar-fixture",
            async transcribe() { return { markdown: "## Sidecar 转写\n" }; },
            async transcribeWithEvents(input) {
              input.onEvent({ type: "stdout", text: "## Sidecar " });
              input.onEvent({ type: "stdout", text: "转写\n" });
              return { markdown: "## Sidecar 转写\n" };
            }
          };
        },
        async createAssistantProvider() { throw new Error("not used"); }
      }
    });
    const endpoint = `http://${running.ready.host}:${running.ready.port}`;
    const query = "notebookId=analysis&sessionId=lecture";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      const created = await fetch(`${endpoint}/local/v1/session/recognition?${query}`, {
        method: "POST", headers, body: JSON.stringify({ imageBlockId: "0001" })
      });
      expect(created.status).toBe(202);
      const taskId = ((await created.json()) as { task: { id: string; transcriptBlockId: string } }).task.id;
      const task = await waitForRecognition(endpoint, token, query, taskId);
      expect(task).toMatchObject({ status: "succeeded", providerName: "sidecar-fixture" });
      expect(task.error).toBeUndefined();
      expect(await readFile(join(sessionDir, "blocks", `${task.transcriptBlockId}_ai_transcript.md`), "utf8"))
        .toBe("## Sidecar 转写\n");
    } finally {
      await running.stop();
    }

  });

  it("hosts the portable companion API and accepts a paired image upload", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-companion-host-"));
    const notesRootDir = join(rootDir, "notes");
    const sessionDir = await writeEmptySessionFixture(notesRootDir);
    const localToken = "l".repeat(48);
    const companionToken = "c".repeat(48);
    const running = await startMacosSidecar({
      token: localToken,
      userDataDir: join(rootDir, "user-data"),
      notesRootDir,
      tempDir: join(rootDir, "temp"),
      appVersion: "test",
      companionHost: { token: companionToken, port: 0 },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providerFactory: {
        async createRecognitionProvider() {
          return {
            name: "companion-fixture",
            async transcribe() { return { markdown: "## 网络转写\n" }; },
            async transcribeWithEvents(input) {
              input.onEvent({ type: "stdout", text: "## 网络转写\n" });
              return { markdown: "## 网络转写\n" };
            }
          };
        },
        async createAssistantProvider() { throw new Error("not used"); }
      }
    });
    const companion = running.ready.companionHost;
    expect(companion).toMatchObject({ host: "0.0.0.0", port: expect.any(Number) });
    expect(JSON.stringify(running.ready)).not.toContain(companionToken);
    if (!companion) throw new Error("companion host did not start");
    expect(companion.url).toBe(`http://127.0.0.1:${companion.port}`);
    try {
      const verify = await fetch(`${companion.url}/api/v1/pairing/verify`, {
        headers: { authorization: `Bearer ${companionToken}` }
      });
      expect(verify.status).toBe(200);
      await expect(verify.json()).resolves.toMatchObject({
        targets: [expect.objectContaining({ notebookId: "analysis", sessionId: "lecture" })],
        capabilities: {
          upload: { image: true, pdf: true },
          recognition: { status: true, retry: true }
        }
      });

      const form = new FormData();
      form.set("notebookId", "analysis");
      form.set("sessionId", "lecture");
      form.set("captureId", "capture-1");
      form.set("deviceId", "android-test");
      form.set("sourceName", "board.png");
      form.set("byteLength", String(tinyPng().length));
      form.set(
        "material",
        new Blob([Uint8Array.from(tinyPng())], { type: "image/png" }),
        "board.png"
      );
      const upload = await fetch(`${companion.url}/api/v1/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${companionToken}` },
        body: form
      });
      expect(upload.status).toBe(202);
      const accepted = await upload.json() as {
        imageBlockId: string;
        transcriptBlockId: string;
        recognitionJobId: string;
      };
      expect(accepted.imageBlockId).toBe("0002");
      expect(accepted.transcriptBlockId).toBe("0003");

      const localEndpoint = `http://${running.ready.host}:${running.ready.port}`;
      const sessionQuery = "notebookId=analysis&sessionId=lecture";
      const localHeaders = { authorization: `Bearer ${localToken}` };
      const uploadActivity = await fetch(
        `${localEndpoint}/local/v1/session/companion-activity?${sessionQuery}`,
        { headers: localHeaders }
      );
      await expect(uploadActivity.json()).resolves.toMatchObject({
        activity: {
          captureId: "capture-1",
          fileName: "board.png",
          receivedBytes: tinyPng().length,
          totalBytes: tinyPng().length,
          status: "accepted"
        }
      });
      const discoveredTasks = await fetch(
        `${localEndpoint}/local/v1/session/recognition?${sessionQuery}`,
        { headers: localHeaders }
      );
      await expect(discoveredTasks.json()).resolves.toMatchObject({
        tasks: [expect.objectContaining({ id: accepted.recognitionJobId })]
      });

      const task = await waitForRecognition(
        localEndpoint,
        localToken,
        sessionQuery,
        accepted.recognitionJobId
      );
      expect(task).toMatchObject({ status: "succeeded", providerName: "companion-fixture" });
      expect(await readFile(join(sessionDir, "blocks", "0003_ai_transcript.md"), "utf8"))
        .toBe("## 网络转写\n");

      const document = await fetch(
        `${companion.url}/api/v2/companion/session/document?notebookId=analysis&sessionId=lecture&format=markdown`,
        { headers: { authorization: `Bearer ${companionToken}` } }
      );
      expect(document.status).toBe(200);
      expect(await document.text()).toContain("网络转写");

      const pdf = Buffer.from("%PDF-1.7\n1 0 obj<</Type /Page>>endobj\n%%EOF", "latin1");
      const pdfForm = new FormData();
      pdfForm.set("notebookId", "analysis");
      pdfForm.set("sessionId", "lecture");
      pdfForm.set("materialType", "pdf");
      pdfForm.set("captureId", "capture-pdf-1");
      pdfForm.set("deviceId", "pwa-test");
      pdfForm.set("material", new Blob([pdf], { type: "application/pdf" }), "lecture.pdf");
      const pdfUpload = await fetch(`${companion.url}/api/v1/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${companionToken}` },
        body: pdfForm
      });
      expect(pdfUpload.status).toBe(202);
      const acceptedPdf = await pdfUpload.json() as {
        pdfBlockId: string;
        assetPath: string;
        pageCount: number;
      };
      expect(acceptedPdf).toMatchObject({ pdfBlockId: "0004", pageCount: 1 });
      expect(await readFile(join(sessionDir, acceptedPdf.assetPath))).toEqual(pdf);

      const manifest = await fetch(
        `${companion.url}/api/v2/companion/session/manifest?notebookId=analysis&sessionId=lecture`,
        { headers: { authorization: `Bearer ${companionToken}` } }
      );
      expect(manifest.status).toBe(200);
      await expect(manifest.json()).resolves.toMatchObject({
        assets: [expect.objectContaining({ mimeType: "application/pdf" })]
      });
    } finally {
      await running.stop();
    }

    const restarted = await startMacosSidecar({
      token: localToken,
      userDataDir: join(rootDir, "user-data"),
      notesRootDir,
      tempDir: join(rootDir, "temp-restarted"),
      appVersion: "test",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    try {
      const persistedActivity = await fetch(
        `http://${restarted.ready.host}:${restarted.ready.port}/local/v1/session/companion-activity?notebookId=analysis&sessionId=lecture`,
        { headers: { authorization: `Bearer ${localToken}` } }
      );
      await expect(persistedActivity.json()).resolves.toMatchObject({
        activity: {
          captureId: "capture-pdf-1",
          status: "accepted"
        }
      });
    } finally {
      await restarted.stop();
    }
  });

  it("issues one active short code locally and exchanges it for a scoped companion token", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-device-pairing-"));
    const localToken = "h".repeat(48);
    const companionToken = "c".repeat(48);
    const userDataDir = join(rootDir, "user-data");
    const running = await startMacosSidecar({
      token: localToken,
      userDataDir,
      notesRootDir: join(rootDir, "notes"),
      tempDir: join(rootDir, "temp"),
      appVersion: "test",
      companionHost: { token: companionToken, port: 0 },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    const companion = running.ready.companionHost;
    if (!companion) throw new Error("companion host did not start");
    expect(companion.host).toBe("0.0.0.0");
    expect(companion.url).toBe(`http://127.0.0.1:${companion.port}`);
    try {
      const challengeResponse = await fetch(
        `http://${running.ready.host}:${running.ready.port}/local/v1/companion/pairing-challenge`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${localToken}` }
        }
      );
      expect(challengeResponse.status).toBe(201);
      const challenge = (await challengeResponse.json()) as {
        challenge: { userCode: string; challengeId: string };
      };

      const exchange = await fetch(`${companion.url}/api/v2/pairing/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userCode: challenge.challenge.userCode,
          deviceLabel: "PWA fixture"
        })
      });
      expect(exchange.status).toBe(201);
      const issued = (await exchange.json()) as {
        token: string;
        device: { deviceId: string; label: string; scopes: string[] };
      };
      expect(issued.device).toMatchObject({
        label: "PWA fixture",
        scopes: expect.arrayContaining(["companion.read", "material.upload"])
      });
      expect(issued.token).not.toBe(companionToken);

      const verify = await fetch(`${companion.url}/api/v1/pairing/verify`, {
        headers: { authorization: `Bearer ${issued.token}` }
      });
      expect(verify.status).toBe(200);

      const reused = await fetch(`${companion.url}/api/v2/pairing/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userCode: challenge.challenge.userCode,
          deviceLabel: "Second fixture"
        })
      });
      expect(reused.status).toBe(400);
      await expect(reused.json()).resolves.toMatchObject({ error: "challenge_not_found" });

      const persisted = await readFile(join(userDataDir, "companion-device-identities.json"), "utf8");
      expect(persisted).not.toContain(issued.token);
      expect(persisted).not.toContain(challenge.challenge.userCode);
    } finally {
      await running.stop();
    }
  });

  it("fails explicitly when the production sidecar has no configured provider", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-sidecar-unavailable-"));
    const notesRootDir = join(rootDir, "notes");
    await writeRecognitionFixture(notesRootDir);
    const token = "u".repeat(48);
    const running = await startMacosSidecar({
      token,
      userDataDir: join(rootDir, "user-data"), notesRootDir, tempDir: join(rootDir, "temp"),
      appVersion: "test", logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    const endpoint = `http://${running.ready.host}:${running.ready.port}`;
    const query = "notebookId=analysis&sessionId=lecture";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      const created = await fetch(`${endpoint}/local/v1/session/recognition?${query}`, {
        method: "POST", headers, body: JSON.stringify({ imageBlockId: "0001" })
      });
      const taskId = ((await created.json()) as { task: { id: string } }).task.id;
      expect(await waitForRecognition(endpoint, token, query, taskId))
        .toMatchObject({
          status: "failed",
          failureKind: "provider_unavailable",
          error: "识别服务尚未配置或未能恢复，请在设置中保存并测试识别服务。"
        });
    } finally {
      await running.stop();
    }
  });

  it("accepts an authenticated runtime provider configuration without persisting or echoing the key", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-sidecar-provider-"));
    const token = "p".repeat(48);
    const apiKey = "sidecar-memory-only-key";
    const running = await startMacosSidecar({
      token,
      userDataDir: join(rootDir, "user-data"), notesRootDir: join(rootDir, "notes"), tempDir: join(rootDir, "temp"),
      appVersion: "test", logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    const endpoint = `http://${running.ready.host}:${running.ready.port}`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      const configured = await fetch(`${endpoint}/local/v1/provider`, {
        method: "POST", headers, body: JSON.stringify({
          providerId: "glm_5_2", model: "glm-5.2v", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey
        })
      });
      expect(configured.status).toBe(200);
      expect(await configured.text()).not.toContain(apiKey);
      const status = await fetch(`${endpoint}/local/v1/provider`, { headers });
      await expect(status.json()).resolves.toMatchObject({ configured: true, providerId: "glm_5_2" });
    } finally {
      await running.stop();
    }

    const persistedFiles = await Promise.all([
      readFile(join(rootDir, "user-data", "provider.json"), "utf8").catch(() => ""),
      readFile(join(rootDir, "notes", "provider.json"), "utf8").catch(() => "")
    ]);
    expect(persistedFiles.join("\n")).not.toContain(apiKey);
  });

  it("keeps recognition and assistant purposes independent and tests connectivity through a local fake endpoint", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-sidecar-diagnostics-"));
    const token = "d".repeat(48);
    const recognitionKey = "recognition-probe-secret";
    const dialogueKey = "dialogue-probe-secret";
    const calls: Array<{ url: string; body: string }> = [];
    const registry = new RuntimeProviderRegistry(async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const running = await startMacosSidecar({
      token,
      userDataDir: join(rootDir, "user-data"),
      notesRootDir: join(rootDir, "notes"),
      tempDir: join(rootDir, "temp"),
      appVersion: "test",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      providerRegistry: registry
    });
    const endpoint = `http://${running.ready.host}:${running.ready.port}`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      const configuredRecognition = await fetch(`${endpoint}/local/v1/provider`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId: "mimo_2_5",
          model: "recognition-model",
          baseUrl: "https://recognition.example.test/v1",
          apiKey: recognitionKey
        })
      });
      expect(configuredRecognition.status).toBe(200);
      const recognitionStatus = await fetch(`${endpoint}/local/v1/provider`, { headers });
      await expect(recognitionStatus.json()).resolves.toMatchObject({
        configured: true,
        providerId: "mimo_2_5",
        model: "recognition-model"
      });
      const inheritedAssistant = await fetch(`${endpoint}/local/v1/provider?purpose=assistant`, { headers });
      await expect(inheritedAssistant.json()).resolves.toMatchObject({
        configured: true,
        purpose: "assistant",
        inherited: true,
        model: "recognition-model"
      });

      const configuredAssistant = await fetch(`${endpoint}/local/v1/provider?purpose=assistant`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          providerId: "glm_5_2",
          model: "dialogue-model",
          baseUrl: "https://dialogue.example.test/v1",
          apiKey: dialogueKey
        })
      });
      expect(configuredAssistant.status).toBe(200);
      const assistantStatus = await fetch(`${endpoint}/local/v1/provider?purpose=assistant`, { headers });
      await expect(assistantStatus.json()).resolves.toMatchObject({
        configured: true,
        purpose: "assistant",
        inherited: false,
        model: "dialogue-model"
      });
      const recognitionStillSeparate = await fetch(`${endpoint}/local/v1/provider`, { headers });
      await expect(recognitionStillSeparate.json()).resolves.toMatchObject({
        configured: true,
        model: "recognition-model"
      });

      const probe = await fetch(`${endpoint}/local/v1/provider/test?purpose=assistant`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(probe.status).toBe(200);
      const probeBody = await probe.text();
      expect(probeBody).toContain('"ok":true');
      expect(probeBody).not.toContain(dialogueKey);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://dialogue.example.test/v1/chat/completions");
      expect(calls[0].body).not.toContain(dialogueKey);

      const clearedAssistant = await fetch(`${endpoint}/local/v1/provider/clear?purpose=assistant`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      await expect(clearedAssistant.json()).resolves.toMatchObject({
        purpose: "assistant",
        inherited: true,
        model: "recognition-model"
      });
    } finally {
      await running.stop();
    }
  });
});

async function writeRecognitionFixture(notesRootDir: string): Promise<string> {
  const sessionDir = join(notesRootDir, "notebooks", "analysis", "sessions", "lecture");
  await mkdir(join(sessionDir, "assets", "photos"), { recursive: true });
  await writeFile(join(sessionDir, "assets", "photos", "board.png"), Buffer.from([1, 2, 3]));
  const session: SessionRecord = {
    id: "lecture", title: "第三讲", status: "draft",
    createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z",
    currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks: [{
      id: "0001", type: "image", path: "assets/photos/board.png", source: "user", status: "draft",
      readonly: false, editableByAi: false, renderInNote: true,
      createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z"
    }]
  };
  await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  return sessionDir;
}

async function writeEmptySessionFixture(notesRootDir: string): Promise<string> {
  const sessionDir = join(notesRootDir, "notebooks", "analysis", "sessions", "lecture");
  await mkdir(join(sessionDir, "blocks"), { recursive: true });
  await writeFile(join(sessionDir, "blocks", "0001_user.md"), "# 第三讲\n");
  const session: SessionRecord = {
    id: "lecture", title: "第三讲", status: "draft",
    createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z",
    currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
    locks: [],
    blocks: [{
      id: "0001", type: "markdown", path: "blocks/0001_user.md", source: "user", status: "draft",
      readonly: false, editableByAi: false, renderInNote: true,
      createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z"
    }]
  };
  await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  return sessionDir;
}

function tinyPng(): Uint8Array {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
}

async function waitForRecognition(endpoint: string, token: string, query: string, taskId: string) {
  for (let index = 0; index < 600; index += 1) {
    const response = await fetch(`${endpoint}/local/v1/session/recognition?${query}&taskId=${taskId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const task = ((await response.json()) as { task: {
      status: string; providerName?: string; error?: string; transcriptBlockId: string
    } }).task;
    if (["succeeded", "failed", "cancelled"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`recognition task ${taskId} did not finish`);
}

function requestHealth(endpoint: string, token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(`${endpoint}/local/v1/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
