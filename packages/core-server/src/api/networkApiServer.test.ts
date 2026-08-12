// @vitest-environment node

import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceIdentityService } from "../device/deviceIdentityService";
import type { IngestPhotoResult, PhotoIngestPort } from "./networkApiContracts";
import { NetworkApiServer } from "./networkApiServer";

describe("NetworkApiServer", () => {
  const servers: NetworkApiServer[] = [];
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
    await Promise.allSettled(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("runs one hundred bounded start and stop cycles", async () => {
    const server = new NetworkApiServer({ host: "127.0.0.1", port: 0, token: "test-token" });
    servers.push(server);
    for (let index = 0; index < 100; index += 1) {
      const url = await startAtFetchSafePort(server);
      const response = await fetch(`${url}/api/v1/health`);
      expect(response.status).toBe(200);
      await server.stop();
    }
  }, 30_000);

  it("fails closed with 503 when an upload port is not configured", async () => {
    const server = new NetworkApiServer({ host: "127.0.0.1", port: 0, token: "test-token" });
    servers.push(server);
    const url = await startAtFetchSafePort(server);
    const form = new FormData();
    form.set("notebookId", "analysis");
    form.set("sessionId", "lecture");
    form.set("material", new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), "photo.jpg");
    const response = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: form
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "upload_error" });
  });

  it("reports real received bytes and acceptance for companion uploads", async () => {
    const activities: Array<{
      status: string;
      receivedBytes: number;
      totalBytes?: number;
      fileName?: string;
    }> = [];
    const accepted: IngestPhotoResult = {
      uploadId: "upload-progress",
      notebookId: "analysis",
      sessionId: "lecture",
      originalName: "board.jpg",
      mimeType: "image/jpeg",
      sha256: "b".repeat(64),
      assetPath: "assets/photos/board.jpg",
      imageBlockId: "0002",
      transcriptBlockId: "0003",
      recognitionJobId: "recognition-progress",
      recognitionStatus: "pending",
      receivedAt: "2026-07-29T00:00:00.000Z",
      duplicate: false
    };
    const server = new NetworkApiServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      pipeline: {
        acceptPhoto: async () => accepted,
        processAcceptedRecognition: async (result) => result
      },
      getPairingTargets: async () => [{ notebookId: "analysis", sessionId: "lecture", title: "Lecture" }],
      onUploadActivity: (activity) => activities.push(activity)
    });
    servers.push(server);
    const url = await startAtFetchSafePort(server);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const form = new FormData();
    form.set("notebookId", "analysis");
    form.set("sessionId", "lecture");
    form.set("sourceName", "board.jpg");
    form.set("captureId", "capture-progress");
    form.set("byteLength", String(bytes.byteLength));
    form.set("material", new Blob([bytes], { type: "image/jpeg" }), "board.jpg");

    const response = await fetch(`${url}/api/v1/uploads`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: form
    });

    expect(response.status).toBe(202);
    expect(activities.some((activity) =>
      activity.status === "receiving" &&
      activity.receivedBytes === bytes.byteLength &&
      activity.totalBytes === bytes.byteLength &&
      activity.fileName === "board.jpg"
    )).toBe(true);
    expect(activities.at(-1)).toMatchObject({
      status: "accepted",
      receivedBytes: bytes.byteLength,
      totalBytes: bytes.byteLength
    });
  });

  it("advertises actual upload capabilities and exposes recognition status with retry", async () => {
    const failed: IngestPhotoResult = {
      uploadId: "upload-1",
      notebookId: "analysis",
      sessionId: "lecture",
      originalName: "board.jpg",
      mimeType: "image/jpeg",
      sha256: "a".repeat(64),
      assetPath: "assets/photos/board.jpg",
      imageBlockId: "0002",
      transcriptBlockId: "0003",
      recognitionJobId: "recognition-1",
      recognitionStatus: "failed",
      receivedAt: "2026-07-28T01:00:00.000Z",
      duplicate: false,
      warnings: ["provider unavailable"]
    };
    const pending = { ...failed, recognitionStatus: "pending" as const, warnings: [] };
    const pipeline: PhotoIngestPort = {
      acceptPhoto: async () => pending,
      processAcceptedRecognition: async (accepted) => ({
        ...accepted,
        recognitionStatus: "succeeded"
      }),
      getAcceptedUpload: async () => failed,
      retryAcceptedRecognition: async () => pending
    };
    const server = new NetworkApiServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      pipeline,
      getPairingTargets: async () => [{
        notebookId: "analysis",
        sessionId: "lecture",
        title: "Lecture"
      }]
    });
    servers.push(server);
    const url = await startAtFetchSafePort(server);
    const headers = { authorization: "Bearer test-token" };

    const catalog = await fetch(`${url}/api/v1/pairing/verify`, { headers });
    await expect(catalog.json()).resolves.toMatchObject({
      capabilities: {
        upload: { image: true, pdf: false },
        recognition: { status: true, retry: true }
      }
    });

    const status = await fetch(`${url}/api/v1/uploads/status?uploadId=upload-1`, { headers });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      uploadId: "upload-1",
      recognitionStatus: "failed",
      warnings: ["provider unavailable"]
    });

    const retry = await fetch(`${url}/api/v1/uploads/retry-recognition`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ uploadId: "upload-1" })
    });
    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toMatchObject({
      uploadId: "upload-1",
      recognitionStatus: "pending"
    });
  });

  it("rolls back its event subscription and listener when binding fails", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("missing occupied port");
    const server = new NetworkApiServer({ host: "127.0.0.1", port: address.port, token: "test-token" });
    servers.push(server);
    await expect(server.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    const started = await server.start();
    expect((await fetch(`${started.url}/api/v1/health`)).status).toBe(200);
  });

  it("serves a bounded PWA shell without swallowing API or unknown routes", async () => {
    const root = await createPwaFixture(temporaryRoots);
    const server = new NetworkApiServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      pwaStaticRootDir: root
    });
    servers.push(server);
    const url = await startAtFetchSafePort(server);

    const index = await fetch(`${url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(index.headers.get("content-security-policy")).toContain("connect-src 'self' http: https:");
    expect(index.headers.get("content-security-policy")).toContain("font-src 'self' data:");
    expect(index.headers.get("content-security-policy")).toContain("style-src 'self' 'unsafe-inline'");
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(await index.text()).toContain("MathNotes PWA fixture");

    const asset = await fetch(`${url}/assets/app-12345678.js`, { method: "HEAD" });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await asset.text()).toBe("");

    const serviceWorker = await fetch(`${url}/sw.js`);
    expect(serviceWorker.headers.get("service-worker-allowed")).toBe("/");
    expect(serviceWorker.headers.get("cache-control")).toBe("no-cache");

    const health = await fetch(`${url}/api/v1/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });
    const missing = await fetch(`${url}/not-a-client-route`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "not_found" });
  });

  it("builds one companion snapshot for adjacent manifest and document requests", async () => {
    let snapshotBuilds = 0;
    const snapshot = {
      version: 1 as const,
      notebookId: "analysis",
      sessionId: "lecture",
      title: "Lecture",
      revision: "revision-1",
      updatedAt: "2026-07-29T00:00:00.000Z",
      blockCount: 1,
      markdown: "# Lecture\n",
      html: "<h1>Lecture</h1>",
      assets: []
    };
    const server = new NetworkApiServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      getPairingTargets: async () => [{
        notebookId: "analysis",
        sessionId: "lecture",
        title: "Lecture"
      }],
      getCompanionSession: async () => {
        snapshotBuilds += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return snapshot;
      }
    });
    servers.push(server);
    const url = await startAtFetchSafePort(server);
    const headers = { authorization: "Bearer test-token" };
    const target = "notebookId=analysis&sessionId=lecture";

    const [manifest, markdown, html] = await Promise.all([
      fetch(`${url}/api/v2/companion/session/manifest?${target}`, { headers }),
      fetch(`${url}/api/v2/companion/session/document?${target}&format=markdown`, { headers }),
      fetch(`${url}/api/v2/companion/session/document?${target}&format=html`, { headers })
    ]);

    expect([manifest.status, markdown.status, html.status]).toEqual([200, 200, 200]);
    expect(snapshotBuilds).toBe(1);
    expect(await markdown.text()).toBe(snapshot.markdown);
    expect(await html.text()).toBe(snapshot.html);

    server.publishCompanionChange("analysis", "lecture");
    const refreshed = await fetch(`${url}/api/v2/companion/session/manifest?${target}`, { headers });
    expect(refreshed.status).toBe(200);
    expect(snapshotBuilds).toBe(2);
  });

  it("reads catalog targets whose workspace IDs contain Unicode without allowing path traversal", async () => {
    const notebookId = "try";
    const sessionId = "20260728073706_未命名_session_12ce79";
    const snapshot = {
      version: 1 as const,
      notebookId,
      sessionId,
      title: "未命名 Session",
      revision: "revision-unicode",
      updatedAt: "2026-07-29T03:30:00.000Z",
      blockCount: 1,
      markdown: "# 未命名 Session\n",
      html: "<h1>未命名 Session</h1>",
      assets: []
    };
    const server = new NetworkApiServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      getPairingTargets: async () => [{ notebookId, sessionId, title: snapshot.title }],
      getCompanionSession: async () => snapshot
    });
    servers.push(server);
    const url = await startAtFetchSafePort(server);
    const headers = { authorization: "Bearer test-token" };
    const target = new URLSearchParams({ notebookId, sessionId });

    const response = await fetch(`${url}/api/v2/companion/session/manifest?${target}`, { headers });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ notebookId, sessionId });

    const traversal = new URLSearchParams({ notebookId: "..", sessionId });
    const rejected = await fetch(`${url}/api/v2/companion/session/manifest?${traversal}`, { headers });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({ error: "invalid_target" });
  });

  it("answers cross-origin and private-network preflight requests", async () => {
    const server = new NetworkApiServer({ host: "127.0.0.1", port: 0, token: "test-token" });
    servers.push(server);
    const url = await startAtFetchSafePort(server);
    const response = await fetch(`${url}/api/v1/pairing/verify`, {
      method: "OPTIONS",
      headers: {
        origin: "https://phone.tailnet.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,x-mathnotes-device-id",
        "access-control-request-private-network": "true"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://phone.tailnet.example");
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(response.headers.get("access-control-allow-private-network")).toBe("true");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("lets only the trusted host issue a one-time device pairing challenge", async () => {
    const root = await mkdtemp(join(tmpdir(), "mathnotes-device-pairing-"));
    temporaryRoots.push(root);
    const deviceIdentityService = new DeviceIdentityService({
      filePath: join(root, "companion-device-identities.json")
    });
    await deviceIdentityService.start();
    const server = new NetworkApiServer({
      host: "127.0.0.1",
      port: 0,
      token: "host-secret",
      deviceIdentityService,
      getPairingTargets: async () => [{
        notebookId: "analysis",
        sessionId: "lecture",
        title: "Lecture"
      }]
    });
    servers.push(server);
    const url = await startAtFetchSafePort(server);

    const anonymousChallenge = await fetch(`${url}/api/v2/pairing/challenge`, { method: "POST" });
    expect(anonymousChallenge.status).toBe(401);

    const hostChallenge = await fetch(`${url}/api/v2/pairing/challenge`, {
      method: "POST",
      headers: { authorization: "Bearer host-secret" }
    });
    expect(hostChallenge.status).toBe(201);
    expect(hostChallenge.headers.get("cache-control")).toBe("no-store");
    const challenge = await hostChallenge.json() as { challengeId: string; userCode: string };

    const exchange = await fetch(`${url}/api/v2/pairing/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        userCode: challenge.userCode,
        deviceLabel: "PWA test"
      })
    });
    expect(exchange.status).toBe(201);
    const issued = await exchange.json() as { token: string };
    expect(issued.token).not.toBe("host-secret");

    const pairedChallenge = await fetch(`${url}/api/v2/pairing/challenge`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}` }
    });
    expect(pairedChallenge.status).toBe(401);

    const catalog = await fetch(`${url}/api/v1/pairing/verify`, {
      headers: { authorization: `Bearer ${issued.token}` }
    });
    expect(catalog.status).toBe(200);
    await expect(catalog.json()).resolves.toMatchObject({
      targets: [{ notebookId: "analysis", sessionId: "lecture", title: "Lecture" }]
    });

    const replay = await fetch(`${url}/api/v2/pairing/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        userCode: challenge.userCode,
        deviceLabel: "Replay"
      })
    });
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toEqual({ error: "challenge_consumed" });
  });

  it("rejects dotfiles, encoded traversal, and a junction escaping the static root", async () => {
    const root = await createPwaFixture(temporaryRoots);
    const outside = await mkdtemp(join(tmpdir(), "mathnotes-pwa-outside-"));
    temporaryRoots.push(outside);
    await writeFile(join(outside, "secret.txt"), "not public");
    await symlink(outside, join(root, "escape"), "junction");
    const server = new NetworkApiServer({ host: "127.0.0.1", port: 0, token: "test-token", pwaStaticRootDir: root });
    servers.push(server);
    const url = await startAtFetchSafePort(server);

    expect((await fetch(`${url}/.env`)).status).toBe(400);
    expect((await fetch(`${url}/assets/%2e%2e%2fsecret.txt`)).status).toBe(400);
    expect((await fetch(`${url}/escape/secret.txt`)).status).toBe(403);
    const post = await fetch(`${url}/`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });
});

async function createPwaFixture(temporaryRoots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-pwa-static-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>MathNotes PWA fixture</title>");
  await writeFile(join(root, "manifest.webmanifest"), "{}");
  await writeFile(join(root, "sw.js"), "self.addEventListener('fetch', () => undefined)");
  await writeFile(join(root, "assets", "app-12345678.js"), "console.log('fixture')");
  return root;
}

async function startAtFetchSafePort(server: NetworkApiServer): Promise<string> {
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

function isFetchBadPort(error: unknown): boolean {
  if (!(error instanceof Error) || error.message !== "fetch failed") return false;
  return error.cause instanceof Error && error.cause.message === "bad port";
}
