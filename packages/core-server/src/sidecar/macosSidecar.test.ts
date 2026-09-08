import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRecord } from "@mathnotes/shared";
import { RuntimeProviderRegistry } from "../provider/runtimeProviderRegistry";
import { parseSidecarParentPid, startMacosSidecar } from "./macosSidecar";
import { createWorkspaceNotebook } from "../catalog/workspaceCommandService";

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

  it("routes replica create and recoverable management through the durable catalog queue", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-sidecar-replica-catalog-"));
    const token = "replica-catalog-fixture-".padEnd(48, "x");
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const host = await startMacosSidecar({ token, userDataDir: join(rootDir, "host-state"), notesRootDir: join(rootDir, "host-notes"),
      tempDir: join(rootDir, "host-temp"), appVersion: "test", companionHost: { token, port: 0 }, logger });
    let replica: Awaited<ReturnType<typeof startMacosSidecar>> | undefined;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    async function json(url: string, body?: unknown, expected = 200) {
      const response = await fetch(url, { headers, method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status).toBe(expected); return response.json();
    }
    try {
      const origin = host.ready.companionHost!.url;
      const identity = await json(origin + "/api/v3/workspace/identity");
      replica = await startMacosSidecar({ token, userDataDir: join(rootDir, "replica-state"), notesRootDir: join(rootDir, "replica-notes"),
        tempDir: join(rootDir, "replica-temp"), appVersion: "test", replicaHostId: identity.hostId, logger });
      const endpoint = `http://${replica.ready.host}:${replica.ready.port}/local/v1`;
      const sync = () => json(endpoint + "/replica/sync", { origin, token, hostId: identity.hostId });
      await sync();
      const { notebook } = await json(endpoint + "/notebooks", { title: "Created through Mac API" }, 201);
      const { session } = await json(endpoint + "/sessions", { notebookId: notebook.notebookId, title: "Queued session" }, 201);
      const target = { notebookId: notebook.notebookId, sessionId: session.sessionId };
      await json(endpoint + "/workspace/manage", { ...target, action: "rename", title: "Renamed through Mac API" });
      expect((await json(endpoint + "/replica/status")).catalogOperations).toHaveLength(3);
      expect((await sync()).catalogOperations).toEqual([]);
      const catalog = await json(origin + "/api/v3/workspace/catalog");
      expect(catalog.notebooks[0].sessions[0].title).toBe("Renamed through Mac API");
      await json(endpoint + "/workspace/manage", { ...target, action: "trash" });
      const { entries } = await json(endpoint + "/workspace/trash");
      expect(entries).toHaveLength(1);
      await sync();
      await json(endpoint + "/workspace/manage", { ...target, action: "restore", deletionId: entries[0].id });
      expect((await sync()).catalogOperations).toEqual([]);
      expect((await json(origin + "/api/v3/workspace/catalog")).notebooks[0].sessions).toHaveLength(1);
    } finally { await replica?.stop(); await host.stop(); }
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

  it("wires user-controlled protected spans through the authenticated local sidecar", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-sidecar-span-lock-"));
    const notesRootDir = join(rootDir, "notes");
    const sessionDir = await writeEmptySessionFixture(notesRootDir);
    const token = "u".repeat(48);
    const running = await startMacosSidecar({
      token,
      userDataDir: join(rootDir, "user-data"),
      notesRootDir,
      tempDir: join(rootDir, "temp"),
      appVersion: "test",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    const endpoint = `http://${running.ready.host}:${running.ready.port}`;
    const query = "notebookId=analysis&sessionId=lecture&blockId=0001";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      const before = await fetch(`${endpoint}/local/v1/session/block?${query}`, { headers });
      const beforeBlock = await before.json() as {
        content: { markdown: string; baseRevision: string };
      };
      const selectedText = "第三讲";
      const from = beforeBlock.content.markdown.indexOf(selectedText);
      const protectedResponse = await fetch(`${endpoint}/local/v1/session/block/span/protect?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          baseRevision: beforeBlock.content.baseRevision,
          from,
          to: from + selectedText.length,
          selectedText
        })
      });
      expect(protectedResponse.status).toBe(200);
      const protectedBody = await protectedResponse.json() as {
        protected: boolean;
        spanId: string;
        block: { content: { markdown: string; baseRevision: string; protectedSpanCount: number } };
      };
      expect(protectedBody).toMatchObject({ protected: true, spanId: expect.stringMatching(/^lock_[0-9a-f-]{36}$/) });
      expect(protectedBody.block.content.protectedSpanCount).toBe(1);
      expect(await readFile(join(sessionDir, "blocks", "0001_user.md"), "utf8")).toContain("<!-- lock:start");
      const protectedSession = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as SessionRecord;
      expect(protectedSession.locks).toEqual([
        expect.objectContaining({ id: protectedBody.spanId, kind: "span", createdBy: "user", aiEditable: false })
      ]);

      const unlockFrom = protectedBody.block.content.markdown.indexOf(selectedText);
      const unlockedResponse = await fetch(`${endpoint}/local/v1/session/block/span/unlock?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          baseRevision: protectedBody.block.content.baseRevision,
          from: unlockFrom,
          to: unlockFrom + selectedText.length,
          selectedText
        })
      });
      expect(unlockedResponse.status).toBe(200);
      await expect(unlockedResponse.json()).resolves.toMatchObject({
        protected: false,
        spanId: protectedBody.spanId,
        block: { content: { markdown: "# 第三讲\n", protectedSpanCount: 0 } }
      });
      const unlockedSession = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as SessionRecord;
      expect(unlockedSession.locks).toEqual([]);
    } finally {
      await running.stop();
    }
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

  it("commits an edited PNG with its original and sidecar through the trusted Mac route", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-sidecar-image-edit-"));
    const notesRootDir = join(rootDir, "notes");
    const sessionDir = await writeEmptySessionFixture(notesRootDir);
    const token = "e".repeat(48);
    const running = await startMacosSidecar({
      token,
      userDataDir: join(rootDir, "user-data"),
      notesRootDir,
      tempDir: join(rootDir, "temp"),
      appVersion: "test",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    const endpoint = `http://${running.ready.host}:${running.ready.port}`;
    const query = "notebookId=analysis&sessionId=lecture";
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const before = await fetch(`${endpoint}/local/v1/session/manifest?${query}`, { headers });
      const revision = ((await before.json()) as { revision: string }).revision;
      const source = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
      const output = Buffer.from(tinyPng());
      const form = new FormData();
      form.set("fileName", "课堂黑板.jpg");
      form.set("baseRevision", revision);
      form.set("metadata", JSON.stringify({
        operations: [{ type: "rotate", quarterTurns: 1 }],
        annotations: [{
          id: "arrow-1", type: "arrow",
          start: { x: 0.2, y: 0.2 }, end: { x: 0.8, y: 0.7 },
          color: "#187857", width: 0.006
        }]
      }));
      form.set("source", new Blob([Uint8Array.from(source)]), "source.jpg");
      form.set("output", new Blob([Uint8Array.from(output)], { type: "image/png" }), "edited.png");
      const response = await fetch(`${endpoint}/local/v1/session/image/edit?${query}`, {
        method: "POST", headers, body: form
      });
      expect(response.status).toBe(200);
      const edited = await response.json() as {
        blockId: string;
        sourceAssetPath: string;
        assetPath: string;
        metadataPath: string;
        sourceSha256: string;
      };
      expect(edited.blockId).toBe("0002");
      expect(await readFile(join(sessionDir, edited.sourceAssetPath))).toEqual(source);
      expect(await readFile(join(sessionDir, edited.assetPath))).toEqual(output);
      await expect(readFile(join(sessionDir, edited.metadataPath), "utf8")).resolves.toContain(
        `"sourceSha256": "${edited.sourceSha256}"`
      );
      const stored = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as SessionRecord;
      expect(stored.blocks[1]).toMatchObject({
        id: "0002",
        type: "image",
        path: edited.assetPath,
        fromAssets: [edited.sourceAssetPath]
      });
    } finally {
      await running.stop();
    }
  });

  it("imports a PDF with its native page count and completes a selected-page batch through the sidecar", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-sidecar-pdf-batch-"));
    const notesRootDir = join(rootDir, "notes");
    const sessionDir = await writeEmptySessionFixture(notesRootDir);
    const token = "b".repeat(48);
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
            name: "pdf-sidecar-fixture",
            async transcribe(input) {
              const page = input.imagePaths[0].match(/page-(\d+)/)?.[1] ?? "unknown";
              return { markdown: `## PDF 第 ${page} 页\n` };
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
      const manifestResponse = await fetch(`${endpoint}/local/v1/session/manifest?${query}`, { headers });
      const before = await manifestResponse.json() as { revision: string };
      const pdf = Buffer.from("%PDF-1.7\n1 0 obj<</Type /Catalog>>endobj\n%%EOF", "latin1");
      const importedResponse = await fetch(
        `${endpoint}/local/v1/session/pdf?${query}&fileName=paper.pdf&baseRevision=${before.revision}&pageCount=2`,
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/pdf" }, body: pdf }
      );
      expect(importedResponse.status).toBe(200);
      const imported = await importedResponse.json() as {
        blockId: string;
        assetPath: string;
        pageCount: number;
        manifest: { revision: string };
      };
      expect(imported).toMatchObject({ blockId: "0002", pageCount: 2 });

      const pages: Array<{ pageNumber: number; assetPath: string }> = [];
      for (const pageNumber of [1, 2]) {
        const stagedResponse = await fetch(
          `${endpoint}/local/v1/session/pdf-recognition/page?${query}&pdfBlockId=${imported.blockId}&pageNumber=${pageNumber}&baseRevision=${imported.manifest.revision}`,
          { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" }, body: Buffer.from(tinyPng()) }
        );
        expect(stagedResponse.status).toBe(201);
        const staged = await stagedResponse.json() as { page: { pageNumber: number; assetPath: string } };
        pages.push(staged.page);
      }

      const startedResponse = await fetch(`${endpoint}/local/v1/session/pdf-recognition/start?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          pdfBlockId: imported.blockId,
          pdfAssetPath: imported.assetPath,
          pageCount: imported.pageCount,
          concurrency: 2,
          baseRevision: imported.manifest.revision,
          pages
        })
      });
      expect(startedResponse.status).toBe(202);
      const started = await startedResponse.json() as { batch: { batchId: string } };
      const completed = await waitForPdfBatch(endpoint, token, query, started.batch.batchId);
      expect(completed).toMatchObject({ status: "completed", selectedPages: [1, 2], succeeded: 2, failed: 0 });

      const stored = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as SessionRecord;
      expect(stored.blocks.map((block) => block.id)).toEqual(["0001", "0002", "0003", "0004"]);
      expect(stored.blocks.slice(2).map((block) => ({
        page: block.sourcePageNumber,
        source: block.fromAssets,
        image: block.sourcePageImagePath
      }))).toEqual([
        expect.objectContaining({ page: 1, source: [imported.assetPath], image: expect.stringContaining("page-0001") }),
        expect.objectContaining({ page: 2, source: [imported.assetPath], image: expect.stringContaining("page-0002") })
      ]);
      await expect(readFile(join(sessionDir, "blocks", "0003_ai_transcript.md"), "utf8"))
        .resolves.toContain("PDF 第 0001 页");
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

  it("falls back to an available companion port when the requested port is occupied", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-companion-port-fallback-"));
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "0.0.0.0", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("missing occupied port");
    let running: Awaited<ReturnType<typeof startMacosSidecar>> | undefined;
    try {
      running = await startMacosSidecar({
        token: "l".repeat(48),
        userDataDir: join(rootDir, "user-data"),
        notesRootDir: join(rootDir, "notes"),
        tempDir: join(rootDir, "temp"),
        appVersion: "test",
        companionHost: { token: "c".repeat(48), port: address.port },
        logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      });
      expect(running.ready.companionHost?.port).toEqual(expect.any(Number));
      expect(running.ready.companionHost?.port).not.toBe(address.port);
      expect(running.ready.companionHost?.port).toBeGreaterThan(0);
    } finally {
      await running?.stop();
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => error ? reject(error) : resolve());
      });
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
      const verified = await verify.json() as {
        targets: { notebookId: string; sessionId: string; notebookTitle: string; title: string }[];
      };
      expect(verified).toMatchObject({
        targets: [expect.objectContaining({ notebookTitle: "手机收件箱", title: "手机照片" })]
      });

      // The existing phone protocol can upload immediately after exchanging the
      // QR, even when the Mac had no notebook or session before pairing.
      const target = verified.targets[0]!;
      const form = new FormData();
      form.set("notebookId", target.notebookId);
      form.set("sessionId", target.sessionId);
      form.set("captureId", "first-phone-photo");
      form.set("deviceId", issued.device.deviceId);
      form.set("material", new Blob([Uint8Array.from(tinyPng())], { type: "image/png" }), "first.png");
      const upload = await fetch(`${companion.url}/api/v1/uploads`, {
        method: "POST", headers: { authorization: `Bearer ${issued.token}` }, body: form
      });
      expect(upload.status).toBe(202);
      const accepted = await upload.json() as { assetPath: string };
      expect(await readFile(join(rootDir!, "notes", "notebooks", target.notebookId, "sessions", target.sessionId, accepted.assetPath)))
        .toEqual(Buffer.from(tinyPng()));

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

  it.each(["empty", "empty-notebook", "existing-session"])(
    "prepares one receiving session only on a trusted QR request (%s)", async (fixture) => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-phone-bootstrap-"));
    const notesRootDir = join(rootDir, "notes");
    if (fixture === "empty-notebook") await createWorkspaceNotebook({ rootDir: notesRootDir, title: "我的笔记" });
    if (fixture === "existing-session") await writeEmptySessionFixture(notesRootDir);
    const localToken = "l".repeat(48);
    const companionToken = "c".repeat(48);
    const running = await startMacosSidecar({
      token: localToken, userDataDir: join(rootDir, "user-data"), notesRootDir,
      tempDir: join(rootDir, "temp"), appVersion: "test", companionHost: { token: companionToken, port: 0 },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    const local = `http://${running.ready.host}:${running.ready.port}`;
    const headers = { authorization: `Bearer ${localToken}` };
    const catalog = async () => (await fetch(`${local}/local/v1/catalog`, { headers })).json();
    try {
      const before = await catalog();
      const route = `${local}/local/v1/companion/pairing-challenge`;
      expect((await fetch(route, { method: "POST" })).status).toBe(401);
      await fetch(`${running.ready.companionHost!.url}/api/v1/pairing/verify`, {
        headers: { authorization: `Bearer ${companionToken}` }
      });
      expect(await catalog()).toEqual(before);
      const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(route, { method: "POST", headers })));
      expect(responses.every((response) => response.status === 201)).toBe(true);
      const after = await catalog();
      expect(after.notebooks).toHaveLength(1);
      expect(after.notebooks[0].sessions).toHaveLength(1);
      expect(after.notebooks[0].sessions[0].title).toBe(fixture === "existing-session" ? "第三讲" : "手机照片");
      if (fixture === "empty-notebook") expect(after.notebooks[0].notebookId).toBe(before.notebooks[0].notebookId);
      if (fixture === "existing-session") expect(after).toEqual(before);
      await fetch(route, { method: "POST", headers });
      expect(await catalog()).toEqual(after);
    } finally { await running.stop(); }
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

  it("deletes and restores one block through a revision-bound Mac-only undo receipt", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-undo-"));
    const token = "u".repeat(48);
    const notesRootDir = join(rootDir, "notes");
    await writeEmptySessionFixture(notesRootDir);
    const running = await startMacosSidecar({
      token,
      userDataDir: join(rootDir, "user-data"),
      notesRootDir,
      tempDir: join(rootDir, "temp"),
      appVersion: "mac-test",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    const endpoint = `http://${running.ready.host}:${running.ready.port}`;
    const query = "notebookId=analysis&sessionId=lecture";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      const initial = await fetch(`${endpoint}/local/v1/session/manifest?${query}`, { headers });
      const initialManifest = await initial.json() as { revision: string };
      const deleted = await fetch(`${endpoint}/local/v1/session/blocks/delete?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ blockIds: ["0001"], baseRevision: initialManifest.revision })
      });
      expect(deleted.status).toBe(200);
      const deletedPayload = await deleted.json() as {
        manifest: { revision: string; blocks: unknown[] };
        undo: { deletionId: string; deletedBlockIds: string[] };
      };
      expect(deletedPayload.manifest.blocks).toEqual([]);
      expect(deletedPayload.undo.deletedBlockIds).toEqual(["0001"]);

      const restored = await fetch(`${endpoint}/local/v1/session/blocks/restore?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          deletionId: deletedPayload.undo.deletionId,
          baseRevision: deletedPayload.manifest.revision
        })
      });
      expect(restored.status).toBe(200);
      await expect(restored.json()).resolves.toMatchObject({
        restored: true,
        manifest: { blocks: [{ id: "0001" }] }
      });
      await expect(readFile(join(notesRootDir, "notebooks/analysis/sessions/lecture/blocks/0001_user.md"), "utf8"))
        .resolves.toBe("# 第三讲\n");
    } finally {
      await running.stop();
    }
  });

  it("creates a secrets-free notes backup through the Mac-only sidecar route", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-macos-backup-"));
    const token = "f".repeat(48);
    const notesRootDir = join(rootDir, "notes");
    const sessionDir = join(notesRootDir, "notebooks", "analysis", "sessions", "lecture");
    const destinationParentDir = join(rootDir, "backups");
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await mkdir(join(notesRootDir, "settings"), { recursive: true });
    await writeFile(join(sessionDir, "session.json"), "{\"id\":\"lecture\"}\n", "utf8");
    await writeFile(join(sessionDir, "blocks", "0001.md"), "# 第三讲\n", "utf8");
    await writeFile(join(notesRootDir, "settings", "provider.json"), "secret", "utf8");

    const running = await startMacosSidecar({
      token,
      userDataDir: join(rootDir, "user-data"),
      notesRootDir,
      tempDir: join(rootDir, "temp"),
      appVersion: "mac-test",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    const endpoint = `http://${running.ready.host}:${running.ready.port}`;
    try {
      const response = await fetch(`${endpoint}/local/v1/notes/backup`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ destinationParentDir })
      });
      expect(response.status).toBe(201);
      const payload = await response.json() as {
        backup: { backupDir: string; manifestPath: string; fileCount: number }
      };
      expect(payload.backup.fileCount).toBe(2);
      await expect(readFile(join(payload.backup.backupDir, "settings", "provider.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(payload.backup.manifestPath, "utf8"))
        .resolves.toContain('"containsProviderSecrets": false');
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

async function waitForPdfBatch(endpoint: string, token: string, query: string, batchId: string) {
  let last: unknown;
  for (let index = 0; index < 600; index += 1) {
    const response = await fetch(
      `${endpoint}/local/v1/session/pdf-recognition?${query}&batchId=${encodeURIComponent(batchId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const payload = await response.json() as { batch: { status: string } };
    last = payload.batch;
    if (["completed", "cancelled"].includes(payload.batch.status)) return payload.batch;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PDF recognition batch ${batchId} did not finish: ${JSON.stringify(last)}`);
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
