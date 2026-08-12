// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceIdentityService, NETWORK_API_ROUTES, RevisionEventLog } from "@mathnotes/core-server";
import type { RecognitionProvider } from "@mathnotes/shared";
import { BlockStore } from "./blockStore";
import { buildCompanionSessionSnapshot, readCompanionAsset } from "./companionReadService";
import { IngestServer } from "./ingestServer";
import { MockRecognitionProvider } from "./mockRecognitionProvider";
import { PhotoIngestPipeline } from "./photoIngestPipeline";
import { PdfIngestPipeline } from "./pdfIngestPipeline";

describe("IngestServer", () => {
  let root: string;
  let store: BlockStore;
  let server: IngestServer;
  let url: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-http-"));
    store = new BlockStore(root);
    await store.createSession({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      now: "2026-06-26T10:00:00.000Z"
    });
    const pdfPipeline = new PdfIngestPipeline({ store });

    server = new IngestServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      getActivePairingTarget: () => ({ notebookId: "functional_analysis", sessionId: "lecture", title: "Lecture" }),
      getPairingTargets: async () => [{ notebookId: "functional_analysis", sessionId: "lecture", title: "Lecture" }],
      getCompanionSession: (notebookId, sessionId) => buildCompanionSessionSnapshot({ store, notebookId, sessionId }),
      getCompanionAsset: (notebookId, sessionId, assetPath) =>
        readCompanionAsset({ store, notebookId, sessionId, assetPath }),
      acceptPdf: (input) => pdfPipeline.acceptPdf(input),
      pipeline: new PhotoIngestPipeline({
        store,
        provider: new MockRecognitionProvider()
      })
    });

    url = await startAtFetchSafePort(server);
  });

  afterEach(async () => {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("responds to health checks", async () => {
    const response = await fetch(`${url}/api/v1/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects uploads without a bearer token", async () => {
    const response = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      body: createUploadForm(Buffer.from("fake jpeg bytes"))
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "unauthorized"
    });
  });

  it("enforces the shared capability inventory and denies unregistered management routes", async () => {
    for (const route of NETWORK_API_ROUTES) {
      if (route.audience === "public") continue;
      const response = await fetch(`${url}${route.path}`, { method: route.method });
      expect(response.status, route.id).toBe(401);
    }

    const unregistered = await fetch(`${url}/api/v1/provider/config`, {
      headers: { Authorization: "Bearer test-token" }
    });
    expect(unregistered.status).toBe(404);
  });

  it("accepts a PDF as pending material without creating blocks", async () => {
    const bytes = createMinimalPdf();
    const form = createUploadForm(bytes, "capture_pdf_001", "application/pdf");
    form.set("materialType", "pdf");
    form.set("sourceName", "handwritten lecture.pdf");
    form.delete("photo");
    form.set("material", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), "handwritten lecture.pdf");

    const response = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: form
    });

    expect(response.status).toBe(202);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ materialType: "pdf", duplicate: false, fileName: "handwritten lecture.pdf", pageCount: 1 });
    expect((await store.readSession("functional_analysis", "lecture")).blocks).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain(store.getSessionDir("functional_analysis", "lecture"));
    expect(await readFile(join(store.getSessionDir("functional_analysis", "lecture"), ...receipt.inboxPath.split("/")))).toEqual(bytes);
  });

  it("durably accepts authenticated uploads before recognition completes", async () => {
    await server.stop();
    let finishRecognition!: () => void;
    const recognitionGate = new Promise<void>((resolve) => {
      finishRecognition = resolve;
    });
    const provider: RecognitionProvider = {
      name: "slow-provider",
      async transcribe() {
        await recognitionGate;
        return { markdown: "finished" };
      }
    };
    server = new IngestServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      pipeline: new PhotoIngestPipeline({ store, provider })
    });
    url = await startAtFetchSafePort(server);
    const bytes = Buffer.from("fake jpeg bytes");

    const response = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-token"
      },
      body: createUploadForm(bytes)
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      uploadId: `upload_${sha256(bytes).slice(0, 16)}`,
      duplicate: false,
      assetPath: "assets/photos/photo_001.jpg",
      imageBlockId: "0001",
      recognitionJobId: "recognition_0001",
      recognitionStatus: "pending"
    });

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks.map((block) => block.type)).toEqual(["image"]);
    const uploads = JSON.parse(
      await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/logs/uploads.json"), "utf8")
    );
    expect(uploads).toEqual([
      expect.objectContaining({
        uploadId: `upload_${sha256(bytes).slice(0, 16)}`,
        recognitionJobId: "recognition_0001",
        recognitionStatus: "pending"
      })
    ]);
    const jobs = JSON.parse(
      await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/logs/recognition_jobs.json"), "utf8")
    );
    finishRecognition();
    expect(jobs).toEqual([
      expect.objectContaining({
        id: "recognition_0001",
        status: expect.stringMatching(/^(pending|running)$/)
      })
    ]);
    await vi.waitFor(async () => {
      const updated = JSON.parse(
        await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/logs/uploads.json"), "utf8")
      );
      expect(updated[0]).toMatchObject({ recognitionStatus: "succeeded", transcriptBlockId: "0002" });
    });
  });

  it("accepts normalized image transform metadata and rejects invalid sidecars", async () => {
    const bytes = Buffer.from("edited png bytes");
    const valid = createUploadForm(bytes, "capture_transform", "image/png");
    valid.set("imageTransform", JSON.stringify({
      version: 1,
      sourceAsset: "original.jpg",
      sourceSha256: "a".repeat(64),
      outputAsset: "edited.png",
      outputMimeType: "image/png",
      operations: [{ type: "crop", rect: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 } }],
      createdAt: "2026-07-15T00:00:00.000Z"
    }));
    const accepted = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: valid
    });
    expect(accepted.status).toBe(202);
    expect(JSON.parse(await readFile(
      join(root, "notebooks/functional_analysis/sessions/lecture/assets/photos/photo_001.annotation.json"),
      "utf8"
    ))).toMatchObject({ outputAsset: "assets/photos/photo_001.jpg" });

    const invalid = createUploadForm(Buffer.from("bad metadata bytes"), "capture_invalid", "image/png");
    invalid.set("imageTransform", JSON.stringify({ version: 1, sourceAsset: "../private.jpg" }));
    const rejected = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: invalid
    });
    expect(rejected.status).toBe(400);
  });

  it("verifies the pairing token and returns the active target", async () => {
    const unauthorized = await fetch(`${url}/api/v1/pairing/verify`);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`${url}/api/v1/pairing/verify`, {
      headers: { Authorization: "Bearer test-token" }
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      version: 1,
      activeTarget: { notebookId: "functional_analysis", sessionId: "lecture", title: "Lecture" },
      targets: [{ notebookId: "functional_analysis", sessionId: "lecture", title: "Lecture" }],
      capabilities: {
        upload: { image: true, pdf: true },
        recognition: { status: false, retry: false }
      }
    });
  });

  it("serves only authenticated companion snapshots from advertised sessions", async () => {
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown: "# Read only",
      now: "2026-06-26T10:01:00.000Z"
    });
    const query = "notebookId=functional_analysis&sessionId=lecture";

    const unauthorized = await fetch(`${url}/api/v1/companion/session?${query}`);
    expect(unauthorized.status).toBe(401);

    const missing = await fetch(`${url}/api/v1/companion/session?notebookId=functional_analysis&sessionId=missing`, {
      headers: { Authorization: "Bearer test-token" }
    });
    expect(missing.status).toBe(404);

    const response = await fetch(`${url}/api/v1/companion/session?${query}`, {
      headers: { Authorization: "Bearer test-token" }
    });
    expect(response.status).toBe(200);
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({
      version: 1,
      notebookId: "functional_analysis",
      sessionId: "lecture",
      title: "Lecture",
      blockCount: 1,
      html: expect.stringContaining("Read only")
    });

    const unchanged = await fetch(`${url}/api/v1/companion/session?${query}`, {
      headers: {
        Authorization: "Bearer test-token",
        "If-None-Match": etag!
      }
    });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
  });

  it("streams companion metadata and documents separately in protocol v2", async () => {
    const markdown = `# 分离传输\n\n${"长正文。".repeat(200_000)}`;
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown,
      now: "2026-06-26T10:01:00.000Z"
    });
    const query = "notebookId=functional_analysis&sessionId=lecture";
    const headers = { Authorization: "Bearer test-token" };

    const manifestResponse = await fetch(`${url}/api/v2/companion/session/manifest?${query}`, { headers });
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get("x-mathnotes-companion-protocol")).toBe("2");
    const manifest = await manifestResponse.json();
    expect(manifest).toMatchObject({
      version: 2,
      notebookId: "functional_analysis",
      sessionId: "lecture"
    });
    expect(manifest.markdownBytes).toBeGreaterThan(Buffer.byteLength(markdown, "utf8"));
    expect(manifest).not.toHaveProperty("markdown");
    expect(manifest).not.toHaveProperty("html");

    const markdownResponse = await fetch(
      `${url}/api/v2/companion/session/document?${query}&format=markdown`,
      { headers }
    );
    expect(markdownResponse.status).toBe(200);
    expect(markdownResponse.headers.get("content-type")).toContain("text/markdown");
    expect(await markdownResponse.text()).toContain(markdown);

    const htmlResponse = await fetch(
      `${url}/api/v2/companion/session/document?${query}&format=html`,
      { headers }
    );
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    expect(await htmlResponse.text()).toContain("分离传输");
  });

  it("serves the uploaded transcript through the same authenticated companion connection", async () => {
    const response = await upload(Buffer.from("upload then read companion"));
    expect(response.status).toBe(202);

    await vi.waitFor(async () => {
      const session = await store.readSession("functional_analysis", "lecture");
      expect(session.blocks.map((block) => block.type)).toEqual(["image", "markdown"]);
    });

    const snapshot = await fetch(
      `${url}/api/v1/companion/session?notebookId=functional_analysis&sessionId=lecture`,
      { headers: { Authorization: "Bearer test-token" } }
    );
    expect(snapshot.status).toBe(200);
    await expect(snapshot.json()).resolves.toMatchObject({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      blockCount: 1,
      html: expect.stringContaining("Mock 识别占位")
    });
  });

  it("serves companion images separately through the authenticated asset route", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    await store.saveEmbeddedAsset({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      fileName: "large.png",
      bytes
    });
    await store.appendMarkdownBlock({
      notebookId: "functional_analysis",
      sessionId: "lecture",
      source: "user",
      markdown: "![diagram](../assets/embedded/large.png)",
      now: "2026-06-26T10:01:00.000Z"
    });
    const query = "notebookId=functional_analysis&sessionId=lecture";
    const snapshotResponse = await fetch(`${url}/api/v1/companion/session?${query}`, {
      headers: { Authorization: "Bearer test-token" }
    });
    const snapshot = await snapshotResponse.json();
    expect(JSON.stringify(snapshot).length).toBeLessThan(20_000);
    expect(snapshot.assets).toEqual([
      expect.objectContaining({ path: "assets/embedded/large.png", mimeType: "image/png" })
    ]);

    const unauthorized = await fetch(
      `${url}/api/v1/companion/asset?${query}&path=${encodeURIComponent(snapshot.assets[0].path)}`
    );
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: "unauthorized" });

    const response = await fetch(
      `${url}/api/v1/companion/asset?${query}&path=${encodeURIComponent(snapshot.assets[0].path)}`,
      { headers: { Authorization: "Bearer test-token" } }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

    const escaped = await fetch(
      `${url}/api/v1/companion/asset?${query}&path=${encodeURIComponent("../session.json")}`,
      { headers: { Authorization: "Bearer test-token" } }
    );
    expect(escaped.status).toBe(400);
    await expect(escaped.json()).resolves.toEqual({ error: "invalid_asset_path" });
  }, 10_000);

  it("publishes companion change events to the matching authenticated stream", async () => {
    const controller = new AbortController();
    const response = await fetch(
      `${url}/api/v1/companion/events?notebookId=functional_analysis&sessionId=lecture`,
      { headers: { Authorization: "Bearer test-token" }, signal: controller.signal }
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const ready = decoder.decode((await reader.read()).value);
    expect(ready).toContain("event: ready");

    server.publishCompanionChange("functional_analysis", "lecture", "revision-2");
    const changed = decoder.decode((await reader.read()).value);
    expect(changed).toContain("id: 1");
    expect(changed).toContain("event: session-changed");
    expect(changed).toContain("revision-2");
    controller.abort();
  });

  it("accepts scoped device tokens while preserving the legacy pairing token", async () => {
    await server.stop();
    const identities = new DeviceIdentityService({ filePath: join(root, "device-identities.json") });
    await identities.start();
    const readChallenge = await identities.createChallenge(["companion.read"]);
    const readDevice = await identities.exchangeChallenge({
      challengeId: readChallenge.challengeId,
      userCode: readChallenge.userCode,
      deviceLabel: "Read-only phone"
    });
    server = new IngestServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      deviceIdentityService: identities,
      getActivePairingTarget: () => ({ notebookId: "functional_analysis", sessionId: "lecture", title: "Lecture" }),
      getPairingTargets: async () => [{ notebookId: "functional_analysis", sessionId: "lecture", title: "Lecture" }]
    });
    url = await startAtFetchSafePort(server);

    const networkChallenge = await server.createDevicePairingChallenge();
    const exchange = await fetch(`${url}/api/v2/pairing/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        challengeId: networkChallenge.challengeId,
        userCode: networkChallenge.userCode,
        deviceLabel: "Exchanged phone"
      })
    });
    expect(exchange.status).toBe(201);
    expect(exchange.headers.get("cache-control")).toBe("no-store");
    const exchanged = await exchange.json();
    expect(exchanged.device).toMatchObject({ label: "Exchanged phone" });
    const exchangedVerification = await fetch(`${url}/api/v1/pairing/verify`, {
      headers: { Authorization: `Bearer ${exchanged.token}` }
    });
    expect(exchangedVerification.status).toBe(200);

    const verified = await fetch(`${url}/api/v1/pairing/verify`, {
      headers: { Authorization: `Bearer ${readDevice.token}` }
    });
    expect(verified.status).toBe(200);
    const forbiddenUpload = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readDevice.token}` },
      body: createUploadForm(Buffer.from("scoped upload"))
    });
    expect(forbiddenUpload.status).toBe(401);

    const legacy = await fetch(`${url}/api/v1/pairing/verify`, {
      headers: { Authorization: "Bearer test-token" }
    });
    expect(legacy.status).toBe(200);
    await identities.revokeDevice(readDevice.device.deviceId);
    const revoked = await fetch(`${url}/api/v1/pairing/verify`, {
      headers: { Authorization: `Bearer ${readDevice.token}` }
    });
    expect(revoked.status).toBe(401);
  });

  it("replays missed revision events after restart and requires resync outside the retained window", async () => {
    await server.stop();
    const eventFile = join(root, "revision-events.json");
    server = createServerWithRevisionLog(eventFile, 2);
    url = await startAtFetchSafePort(server);
    server.publishCompanionChange("functional_analysis", "lecture", "revision-1");
    server.publishCompanionChange("functional_analysis", "lecture", "revision-2");
    await vi.waitFor(async () => {
      const persisted = JSON.parse(await readFile(eventFile, "utf8"));
      expect(persisted.nextId).toBe(3);
    });
    await server.stop();

    server = createServerWithRevisionLog(eventFile, 2);
    url = await startAtFetchSafePort(server);
    const replayController = new AbortController();
    const replayResponse = await fetch(
      `${url}/api/v1/companion/events?notebookId=functional_analysis&sessionId=lecture&lastEventId=1`,
      { headers: { Authorization: "Bearer test-token" }, signal: replayController.signal }
    );
    const replayText = await readEventStreamUntil(replayResponse, "revision-2");
    expect(replayText).toContain("id: 2");
    expect(replayText).toContain("event: session-changed");
    replayController.abort();

    server.publishCompanionChange("functional_analysis", "lecture", "revision-3");
    await vi.waitFor(async () => {
      const persisted = JSON.parse(await readFile(eventFile, "utf8"));
      expect(persisted.nextId).toBe(4);
    });
    const resetController = new AbortController();
    const resetResponse = await fetch(`${url}/api/v1/companion/catalog-events`, {
      headers: { Authorization: "Bearer test-token", "Last-Event-ID": "0" },
      signal: resetController.signal
    });
    const resetText = await readEventStreamUntil(resetResponse, "resync-required");
    expect(resetText).toContain("event: resync-required");
    expect(resetText).toContain('"scope":"catalog"');
    resetController.abort();
  });

  it("publishes authenticated catalog and deletion events", async () => {
    const unauthorized = await fetch(`${url}/api/v1/companion/catalog-events`);
    expect(unauthorized.status).toBe(401);

    const catalogController = new AbortController();
    const catalogResponse = await fetch(`${url}/api/v1/companion/catalog-events`, {
      headers: { Authorization: "Bearer test-token" },
      signal: catalogController.signal
    });
    const catalogReader = catalogResponse.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await catalogReader.read()).value)).toContain("event: ready");
    server.publishCompanionCatalogChange("renamed", "functional_analysis", "lecture");
    const catalogChanged = decoder.decode((await catalogReader.read()).value);
    expect(catalogChanged).toContain("event: catalog-changed");
    expect(catalogChanged).toContain('\"kind\":\"renamed\"');

    const sessionController = new AbortController();
    const sessionResponse = await fetch(
      `${url}/api/v1/companion/events?notebookId=functional_analysis&sessionId=lecture`,
      { headers: { Authorization: "Bearer test-token" }, signal: sessionController.signal }
    );
    const sessionReader = sessionResponse.body!.getReader();
    expect(decoder.decode((await sessionReader.read()).value)).toContain("event: ready");
    server.publishCompanionDeleted("functional_analysis", "lecture");
    expect(decoder.decode((await sessionReader.read()).value)).toContain("event: session-deleted");

    sessionController.abort();
    catalogController.abort();
  });

  it("rejects authenticated uploads to a session outside the advertised catalog", async () => {
    const form = createUploadForm(Buffer.from("wrong target"));
    form.set("sessionId", "missing");
    const response = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: form
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "pairing_target_unavailable" });
  });

  function createServerWithRevisionLog(eventFile: string, maxEvents: number): IngestServer {
    return new IngestServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      getPairingTargets: async () => [{ notebookId: "functional_analysis", sessionId: "lecture", title: "Lecture" }],
      revisionEventLog: new RevisionEventLog({ filePath: eventFile, maxEvents })
    });
  }

  it("returns the same durable receipt for an identical capture retry", async () => {
    const bytes = Buffer.from("same capture bytes");
    const first = await upload(bytes);
    expect(first.status).toBe(202);
    const firstBody = await first.json();

    const retry = await upload(bytes);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      uploadId: firstBody.uploadId,
      imageBlockId: firstBody.imageBlockId,
      recognitionJobId: firstBody.recognitionJobId,
      duplicate: true
    });

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks.filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("serializes concurrent identical capture retries", async () => {
    const bytes = Buffer.from("concurrent capture bytes");
    const [left, right] = await Promise.all([upload(bytes), upload(bytes)]);
    expect([left.status, right.status].sort()).toEqual([200, 202]);
    const [leftBody, rightBody] = await Promise.all([left.json(), right.json()]);
    expect(leftBody.uploadId).toBe(rightBody.uploadId);
    expect(leftBody.imageBlockId).toBe(rightBody.imageBlockId);

    const session = await store.readSession("functional_analysis", "lecture");
    expect(session.blocks.filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("rejects capture identity reuse with different bytes", async () => {
    expect((await upload(Buffer.from("first bytes"))).status).toBe(202);

    const conflict = await upload(Buffer.from("different bytes"));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: "upload_error"
    });
  });

  it("rejects invalid hashes and unsupported image types before acceptance", async () => {
    const bytes = Buffer.from("invalid upload metadata");
    const badHash = createUploadForm(bytes);
    badHash.set("sha256", "wrong-hash");
    const hashResponse = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: badHash
    });
    expect(hashResponse.status).toBe(400);

    const badMime = createUploadForm(bytes, "capture_bad_mime", "text/plain");
    const mimeResponse = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: badMime
    });
    expect(mimeResponse.status).toBe(415);
    expect((await store.readSession("functional_analysis", "lecture")).blocks).toEqual([]);
  });

  it("rejects photos above the configured upload limit", async () => {
    await server.stop();
    server = new IngestServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      maxUploadBytes: 4,
      pipeline: new PhotoIngestPipeline({ store, provider: new MockRecognitionProvider() })
    });
    url = await startAtFetchSafePort(server);

    const response = await upload(Buffer.from("too large"));
    expect(response.status).toBe(413);
    expect((await store.readSession("functional_analysis", "lecture")).blocks).toEqual([]);
  });

  it("keeps the upload accepted when background recognition fails", async () => {
    await server.stop();
    const provider: RecognitionProvider = {
      name: "offline-provider",
      async transcribe() {
        throw new Error("provider offline");
      }
    };
    server = new IngestServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      pipeline: new PhotoIngestPipeline({ store, provider })
    });
    url = await startAtFetchSafePort(server);

    const response = await upload(Buffer.from("accepted despite provider failure"));
    expect(response.status).toBe(202);
    await vi.waitFor(async () => {
      const uploads = JSON.parse(
        await readFile(join(root, "notebooks/functional_analysis/sessions/lecture/logs/uploads.json"), "utf8")
      );
      expect(uploads[0]).toMatchObject({ recognitionStatus: "failed" });
    });

    const retry = await upload(Buffer.from("accepted despite provider failure"));
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ duplicate: true, recognitionStatus: "failed" });
  });

  it("can create a fresh pipeline for each upload", async () => {
    await server.stop();
    let providerIndex = 0;
    server = new IngestServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      createPipeline: () => {
        providerIndex += 1;
        const provider = providerReturning(`provider-${providerIndex}`);
        return new PhotoIngestPipeline({
          store,
          provider
        });
      }
    });
    url = await startAtFetchSafePort(server);

    for (const [index, text] of ["first upload", "second upload"].entries()) {
      const bytes = Buffer.from(text);
      const response = await fetch(`${url}/api/v1/uploads`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token"
        },
        body: createUploadForm(bytes, `capture_${index + 1}`)
      });
      expect(response.status).toBe(202);
    }

    await vi.waitFor(async () => {
      const session = await store.readSession("functional_analysis", "lecture");
      expect(session.blocks.filter((block) => block.type === "markdown")).toHaveLength(2);
    }, { timeout: 10_000 });
    expect(providerIndex).toBe(2);
  });

  function upload(bytes: Buffer): Promise<Response> {
    return fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
      body: createUploadForm(bytes)
    });
  }
});

async function startAtFetchSafePort(server: IngestServer): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const url = (await server.start()).url;
    try {
      const response = await fetch(`${url}/api/v1/health`);
      if (response.ok) return url;
    } catch (error) {
      if (!isFetchBadPort(error)) throw error;
    }
    await server.stop();
  }
  throw new Error("Unable to allocate a Fetch-safe test port");
}

async function readEventStreamUntil(response: Response, marker: string): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let index = 0; index < 12 && !text.includes(marker); index += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

function isFetchBadPort(error: unknown): boolean {
  if (!(error instanceof Error) || error.message !== "fetch failed") return false;
  return error.cause instanceof Error && error.cause.message === "bad port";
}

function providerReturning(markdown: string): RecognitionProvider {
  return {
    name: markdown,
    async transcribe() {
      return { markdown };
    }
  };
}

function createUploadForm(bytes: Buffer, captureId = "capture_001", mimeType = "image/jpeg"): FormData {
  const form = new FormData();
  form.set("notebookId", "functional_analysis");
  form.set("sessionId", "lecture");
  form.set("captureId", captureId);
  form.set("deviceId", "android_phone");
  form.set("createdAt", "2026-06-26T10:01:00.000Z");
  form.set("sha256", sha256(bytes));
  form.set("photo", new Blob([new Uint8Array(bytes)], { type: mimeType }), "photo 001.jpg");
  return form;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createMinimalPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream"
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}
