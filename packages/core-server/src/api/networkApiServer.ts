import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import Busboy from "busboy";
import {
  authorizeCoreApiCapability,
  principalForNetworkRoute,
  resolveNetworkApiRoute,
  type NetworkApiRouteId
} from "./capabilityPolicy";
import { DeviceIdentityError, type DeviceIdentityService, type DeviceScope } from "../device/deviceIdentityService";
import { RevisionEventLog, type RevisionEvent } from "../events/revisionEventLog";
import { assertValidImageTransformSidecar, type ImageTransformSidecar } from "@mathnotes/shared";
import {
  CompanionAssetError,
  type CompanionAsset,
  type CompanionSessionSnapshot,
  type CompanionUploadActivity,
  type IngestPdfArgs,
  type IngestPdfResult,
  type IngestPhotoResult,
  type PairingTarget,
  type PhotoIngestPort,
  UploadError
} from "./networkApiContracts";
import { PwaStaticHost } from "./pwaStaticHost";
import { isSafeWorkspaceIdentifier } from "../session/workspaceIdentifier";

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type NetworkApiServerOptions = {
  host: string;
  port: number;
  token: string;
  pipeline?: PhotoIngestPort;
  createPipeline?: () => PhotoIngestPort | Promise<PhotoIngestPort>;
  acceptPdf?: (input: IngestPdfArgs) => Promise<IngestPdfResult>;
  maxUploadBytes?: number;
  pairingTarget?: {
    notebookId: string;
    sessionId: string;
  };
  getPairingTargets?: () => Promise<PairingTarget[]>;
  getActivePairingTarget?: () => PairingTarget | undefined;
  getCompanionSession?: (notebookId: string, sessionId: string) => Promise<CompanionSessionSnapshot>;
  getCompanionAsset?: (notebookId: string, sessionId: string, assetPath: string) => Promise<CompanionAsset>;
  revisionEventLog?: RevisionEventLog;
  deviceIdentityService?: DeviceIdentityService;
  pwaStaticRootDir?: string;
  onUploadActivity?: (activity: CompanionUploadActivity) => void;
};

export type StartedNetworkApiServer = {
  host: string;
  port: number;
  url: string;
};

type ParsedUpload = {
  fields: Record<string, string>;
  material: {
    originalName: string;
    mimeType: string;
    bytes: Buffer;
  };
};

export class NetworkApiServer {
  private static readonly COMPANION_SNAPSHOT_REUSE_MS = 2_000;
  private readonly revisionEvents: RevisionEventLog;
  private readonly backgroundTasks = new Set<Promise<unknown>>();
  private readonly companionSnapshotCache = new Map<string, {
    expiresAt: number;
    snapshot: CompanionSessionSnapshot;
  }>();
  private readonly companionSnapshotFlights = new Map<string, Promise<CompanionSessionSnapshot>>();
  private server?: Server;
  private unsubscribeRevisionEvents?: () => void;
  private readonly companionStreams = new Set<{
    notebookId: string;
    sessionId: string;
    response: ServerResponse;
  }>();
  private readonly companionCatalogStreams = new Set<ServerResponse>();
  private readonly pwaStaticHost?: PwaStaticHost;

  constructor(private readonly options: NetworkApiServerOptions) {
    this.revisionEvents = options.revisionEventLog ?? new RevisionEventLog();
    this.pwaStaticHost = options.pwaStaticRootDir ? new PwaStaticHost(options.pwaStaticRootDir) : undefined;
  }

  async start(): Promise<StartedNetworkApiServer> {
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address === "object") {
        return this.serverInfo(address.port);
      }
    }

    await this.revisionEvents.start();
    this.unsubscribeRevisionEvents = this.revisionEvents.subscribe((event) => this.broadcastRevisionEvent(event));
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.keepAliveTimeout = 30_000;
    this.server.headersTimeout = 35_000;
    this.server.requestTimeout = 5 * 60_000;

    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(this.options.port, this.options.host, resolve);
      });
    } catch (error) {
      await this.rollbackFailedStart();
      throw error;
    }

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine ingest server address");
    }

    return this.serverInfo(address.port);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = undefined;
    this.unsubscribeRevisionEvents?.();
    this.unsubscribeRevisionEvents = undefined;

    for (const stream of this.companionStreams) stream.response.end();
    this.companionStreams.clear();
    for (const response of this.companionCatalogStreams) response.end();
    this.companionCatalogStreams.clear();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    if (this.backgroundTasks.size > 0) {
      await Promise.race([Promise.allSettled([...this.backgroundTasks]), delay(250)]);
    }
    await this.revisionEvents.close();
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    applyPrivateApiCors(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    try {
      if (this.pwaStaticHost && await this.pwaStaticHost.tryHandle(request, response, url)) return;
    } catch (error) {
      if (process.env.MATHNOTES_DEBUG_SERVER_ERRORS === "1") console.error("[MathNotes PWA static host]", error);
      if (!response.headersSent) writeJson(response, 500, { error: "static_host_error" });
      else response.destroy();
      return;
    }
    const route = resolveNetworkApiRoute(request.method ?? "", url.pathname);

    if (!route) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    const hasValidHostToken = verifyBearerToken(request.headers.authorization, this.options.token);
    const hasValidDeviceToken = hasValidHostToken
      ? false
      : await this.verifyDeviceToken(request.headers.authorization, route.id);
    const principal = principalForNetworkRoute(route, hasValidHostToken, hasValidDeviceToken);
    if (!authorizeCoreApiCapability(principal, route.capability)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    try {
      await this.dispatchAuthorizedRoute(route.id, request, response, url);
    } catch (error) {
      if (process.env.MATHNOTES_DEBUG_SERVER_ERRORS === "1") {
        console.error("[MathNotes ingest server]", error);
      }
      if (error instanceof UploadError) {
        writeJson(response, error.statusCode, { error: "upload_error", message: error.message });
        return;
      }

      if (error instanceof CompanionAssetError) {
        writeJson(response, error.statusCode, { error: error.message });
        return;
      }

      if (error instanceof CompanionProtocolError) {
        writeJson(response, error.statusCode, {
          error: error.message,
          stage: "snapshot",
          detail: process.env.MATHNOTES_DEBUG_SERVER_ERRORS === "1" ? error.detail : undefined
        });
        return;
      }

      if (error instanceof DeviceIdentityError) {
        writeJson(response, pairingErrorStatus(error), { error: error.code });
        return;
      }

      writeJson(response, 500, { error: "internal_error" });
    }
  }

  private async dispatchAuthorizedRoute(
    routeId: NetworkApiRouteId,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<void> {
    switch (routeId) {
      case "health":
        writeJson(response, 200, { ok: true });
        return;
      case "pairing.challenge":
        await this.handleDevicePairingChallenge(response);
        return;
      case "pairing.exchange":
        await this.handleDevicePairingExchange(request, response);
        return;
      case "pairing.verify":
        await this.handlePairingVerification(response);
        return;
      case "material.upload":
        await this.handleUpload(request, response);
        return;
      case "material.upload.status":
        await this.handleUploadStatus(response, url);
        return;
      case "material.recognition.retry":
        await this.handleRecognitionRetry(request, response);
        return;
      case "companion.session.v1":
        await this.handleCompanionSession(request, response, url);
        return;
      case "companion.session.manifest.v2":
        await this.handleCompanionManifest(request, response, url);
        return;
      case "companion.session.document.v2":
        await this.handleCompanionDocument(response, url);
        return;
      case "companion.asset":
        await this.handleCompanionAsset(response, url);
        return;
      case "companion.session.events":
        await this.handleCompanionEvents(request, response, url);
        return;
      case "companion.catalog.events":
        await this.handleCompanionCatalogEvents(request, response, url);
        return;
      default:
        assertNever(routeId);
    }
  }

  private async handleUpload(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = await parseMultipartUpload(
      request,
      this.options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
      (activity) => this.options.onUploadActivity?.(activity)
    );
    const notebookId = requiredField(parsed.fields, "notebookId");
    const sessionId = requiredField(parsed.fields, "sessionId");
    if (this.options.getPairingTargets) {
      const targets = await this.options.getPairingTargets();
      const allowed = targets.some((target) => target.notebookId === notebookId && target.sessionId === sessionId);
      if (!allowed) {
        writeJson(response, 409, { error: "pairing_target_unavailable" });
        return;
      }

    }

    const materialType = parsed.fields.materialType === "pdf" || parsed.material.mimeType === "application/pdf" ? "pdf" : "image";
    const commonInput = {
      notebookId,
      sessionId,
      originalName: parsed.fields.sourceName || parsed.material.originalName,
      mimeType: parsed.material.mimeType,
      bytes: parsed.material.bytes,
      sha256: parsed.fields.sha256,
      captureId: parsed.fields.captureId,
      deviceId: parsed.fields.deviceId,
      receivedAt: parsed.fields.createdAt || new Date().toISOString()
    };

    if (materialType === "pdf") {
      if (!this.options.acceptPdf) throw new UploadError("PDF intake is not available", 503);
      const result = await this.options.acceptPdf(commonInput);
      this.options.onUploadActivity?.(acceptedUploadActivity(parsed.fields, parsed.material.bytes.length));
      this.publishCompanionChange(notebookId, sessionId, result.receivedAt);
      writeJson(response, result.duplicate ? 200 : 202, pdfUploadResponse(result));
      return;
    }

    const pipeline = await this.pipelineForUpload();
    const result = await pipeline.acceptPhoto({
      ...commonInput,
      imageTransform: parseImageTransform(parsed.fields.imageTransform)
    });
    this.options.onUploadActivity?.(acceptedUploadActivity(parsed.fields, parsed.material.bytes.length));

    if (!result.duplicate) {
      this.trackBackgroundTask(
        pipeline.processAcceptedRecognition(result).finally(() => {
          this.publishCompanionChange(notebookId, sessionId, new Date().toISOString());
        })
      );
    }

    this.publishCompanionChange(notebookId, sessionId, result.receivedAt);

    writeJson(response, result.duplicate ? 200 : 202, uploadResponse(result));
  }

  private async handleUploadStatus(response: ServerResponse, url: URL): Promise<void> {
    const uploadId = url.searchParams.get("uploadId")?.trim();
    if (!uploadId) throw new UploadError("uploadId is required", 400);
    const pipeline = await this.pipelineForUpload();
    if (!pipeline.getAcceptedUpload) throw new UploadError("Upload status is not available", 503);
    writeJson(response, 200, uploadResponse(await pipeline.getAcceptedUpload(uploadId)));
  }

  private async handleRecognitionRetry(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request, 16 * 1024);
    const uploadId = stringField(body, "uploadId");
    if (!uploadId) throw new UploadError("uploadId is required", 400);
    const pipeline = await this.pipelineForUpload();
    if (!pipeline.retryAcceptedRecognition) {
      throw new UploadError("Recognition retry is not available", 503);
    }
    const retried = await pipeline.retryAcceptedRecognition(uploadId);
    this.trackBackgroundTask(
      pipeline.processAcceptedRecognition(retried).then((completed) => {
        if (!completed.notebookId || !completed.sessionId) return;
        this.publishCompanionChange(
          completed.notebookId,
          completed.sessionId,
          new Date().toISOString()
        );
      })
    );
    writeJson(response, 202, uploadResponse(retried));
  }

  private serverInfo(port: number): StartedNetworkApiServer {
    return {
      host: this.options.host,
      port,
      url: `http://${this.options.host}:${port}`
    };
  }

  private async pipelineForUpload(): Promise<PhotoIngestPort> {
    if (this.options.createPipeline) {
      return this.options.createPipeline();
    }
    if (this.options.pipeline) {
      return this.options.pipeline;
    }
    throw new UploadError("Photo intake is not available", 503);
  }

  private async handlePairingVerification(response: ServerResponse): Promise<void> {
    const fallbackTarget = this.options.pairingTarget
      ? { ...this.options.pairingTarget, title: this.options.pairingTarget.sessionId }
      : undefined;
    const targets = this.options.getPairingTargets
      ? await this.options.getPairingTargets()
      : [];
    const requestedActive = this.options.getActivePairingTarget?.() ?? fallbackTarget;
    const activeTarget = requestedActive
      ? targets.find((target) =>
          target.notebookId === requestedActive.notebookId && target.sessionId === requestedActive.sessionId
        ) ?? requestedActive
      : targets[0];
    if (targets.length === 0 && activeTarget) targets.push(activeTarget);
    writeJson(response, 200, {
      ok: true,
      version: 1,
      activeTarget: activeTarget ?? null,
      targets,
      capabilities: {
        upload: {
          image: Boolean(this.options.pipeline || this.options.createPipeline),
          pdf: Boolean(this.options.acceptPdf)
        },
        recognition: {
          status: Boolean(this.options.pipeline?.getAcceptedUpload),
          retry: Boolean(this.options.pipeline?.retryAcceptedRecognition)
        }
      }
    });
  }

  private async handleCompanionSession(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const target = await this.authorizeCompanionTarget(response, url);
    if (!target) return;
    if (!this.options.getCompanionSession) {
      writeJson(response, 503, { error: "companion_unavailable" });
      return;
    }
    const snapshot = await this.options.getCompanionSession(target.notebookId, target.sessionId);
    const etag = `"${Buffer.from(snapshot.revision, "utf8").toString("base64url")}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, {
        "cache-control": "private, no-cache",
        etag
      });
      response.end();
      return;
    }
    response.writeHead(200, {
      "cache-control": "private, no-cache",
      "content-type": "application/json; charset=utf-8",
      etag
    });
    response.end(`${JSON.stringify(snapshot)}\n`);
  }

  private async handleCompanionManifest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const target = await this.authorizeCompanionTarget(response, url);
    if (!target) return;
    const snapshot = await this.requireCompanionSnapshot(target.notebookId, target.sessionId);
    const etag = companionEtag(snapshot.revision);
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, {
        "cache-control": "private, no-cache",
        "x-mathnotes-companion-protocol": "2",
        etag
      });
      response.end();
      return;
    }
    writeJson(response, 200, {
      version: 2,
      notebookId: snapshot.notebookId,
      sessionId: snapshot.sessionId,
      title: snapshot.title,
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt,
      blockCount: snapshot.blockCount,
      markdownBytes: Buffer.byteLength(snapshot.markdown, "utf8"),
      htmlBytes: Buffer.byteLength(snapshot.html, "utf8"),
      assets: snapshot.assets
    }, {
      "cache-control": "private, no-cache",
      "x-mathnotes-companion-protocol": "2",
      etag
    });
  }

  private async handleCompanionDocument(response: ServerResponse, url: URL): Promise<void> {
    const target = await this.authorizeCompanionTarget(response, url);
    if (!target) return;
    const format = url.searchParams.get("format");
    if (format !== "markdown" && format !== "html") {
      writeJson(response, 400, { error: "invalid_document_format" });
      return;
    }
    const snapshot = await this.requireCompanionSnapshot(target.notebookId, target.sessionId);
    const body = format === "markdown" ? snapshot.markdown : snapshot.html;
    const bytes = Buffer.from(body, "utf8");
    response.writeHead(200, {
      "cache-control": "private, no-cache",
      "content-length": String(bytes.length),
      "content-type": format === "markdown"
        ? "text/markdown; charset=utf-8"
        : "text/html; charset=utf-8",
      "x-mathnotes-companion-protocol": "2",
      "x-mathnotes-revision": snapshot.revision
    });
    response.end(bytes);
  }

  private async requireCompanionSnapshot(notebookId: string, sessionId: string): Promise<CompanionSessionSnapshot> {
    if (!this.options.getCompanionSession) {
      throw new CompanionProtocolError("companion_unavailable", 503);
    }
    const key = `${notebookId}\u0000${sessionId}`;
    const cached = this.companionSnapshotCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.snapshot;
    if (cached) this.companionSnapshotCache.delete(key);
    const active = this.companionSnapshotFlights.get(key);
    if (active) return active;

    const flight = this.options.getCompanionSession(notebookId, sessionId)
      .then((snapshot) => {
        this.companionSnapshotCache.set(key, {
          expiresAt: Date.now() + NetworkApiServer.COMPANION_SNAPSHOT_REUSE_MS,
          snapshot
        });
        return snapshot;
      })
      .catch((error) => {
        throw new CompanionProtocolError(
          "companion_snapshot_failed",
          500,
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => {
        if (this.companionSnapshotFlights.get(key) === flight) {
          this.companionSnapshotFlights.delete(key);
        }
      });
    this.companionSnapshotFlights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (this.companionSnapshotFlights.get(key) === flight) {
        this.companionSnapshotFlights.delete(key);
      }
    }
  }

  private async handleCompanionAsset(response: ServerResponse, url: URL): Promise<void> {
    const target = await this.authorizeCompanionTarget(response, url);
    if (!target) return;
    if (!this.options.getCompanionAsset) {
      writeJson(response, 503, { error: "companion_unavailable" });
      return;
    }
    const assetPath = url.searchParams.get("path")?.trim();
    if (!assetPath) {
      writeJson(response, 400, { error: "invalid_asset_path" });
      return;
    }
    const asset = await this.options.getCompanionAsset(target.notebookId, target.sessionId, assetPath);
    response.writeHead(200, {
      "cache-control": "private, max-age=300",
      "content-length": String(asset.bytes.length),
      "content-type": asset.mimeType
    });
    response.end(asset.bytes);
  }

  private async handleCompanionEvents(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const target = await this.authorizeCompanionTarget(response, url);
    if (!target) return;
    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no"
    });
    const lastEventId = readLastEventId(request, url);
    const replay = await this.revisionEvents.replay(lastEventId, {
      scope: "session",
      notebookId: target.notebookId,
      sessionId: target.sessionId
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ version: 1, latestEventId: replay.latestId })}\n\n`);
    writeReplay(response, replay, "session");
    const stream = { ...target, response };
    this.companionStreams.add(stream);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      this.companionStreams.delete(stream);
    });
  }

  private async handleCompanionCatalogEvents(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    response.writeHead(200, {
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no"
    });
    const replay = await this.revisionEvents.replay(readLastEventId(request, url), { scope: "catalog" });
    response.write(`event: ready\ndata: ${JSON.stringify({ version: 1, latestEventId: replay.latestId })}\n\n`);
    writeReplay(response, replay, "catalog");
    this.companionCatalogStreams.add(response);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      this.companionCatalogStreams.delete(response);
    });
  }

  private async authorizeCompanionTarget(
    response: ServerResponse,
    url: URL
  ): Promise<{ notebookId: string; sessionId: string } | undefined> {
    const notebookId = safeId(url.searchParams.get("notebookId"));
    const sessionId = safeId(url.searchParams.get("sessionId"));
    if (!notebookId || !sessionId) {
      writeJson(response, 400, { error: "invalid_target" });
      return undefined;
    }
    if (this.options.getPairingTargets) {
      const targets = await this.options.getPairingTargets();
      if (!targets.some((target) => target.notebookId === notebookId && target.sessionId === sessionId)) {
        writeJson(response, 404, { error: "target_not_found" });
        return undefined;
      }
    }
    return { notebookId, sessionId };
  }

  publishCompanionChange(notebookId: string, sessionId: string, revisionHint = new Date().toISOString()): void {
    this.companionSnapshotCache.delete(`${notebookId}\u0000${sessionId}`);
    this.queueRevisionEvent({
      scope: "session",
      kind: "changed",
      notebookId,
      sessionId,
      revision: revisionHint,
      at: new Date().toISOString()
    });
  }

  async createDevicePairingChallenge(): Promise<Awaited<ReturnType<DeviceIdentityService["createChallenge"]>>> {
    if (!this.options.deviceIdentityService) throw new Error("Device identity service is unavailable");
    return this.options.deviceIdentityService.createChallenge();
  }

  private async handleDevicePairingChallenge(response: ServerResponse): Promise<void> {
    if (!this.options.deviceIdentityService) {
      writeJson(response, 503, { error: "device_pairing_unavailable" });
      return;
    }
    const challenge = await this.options.deviceIdentityService.createExclusiveChallenge();
    response.setHeader("cache-control", "no-store");
    writeJson(response, 201, challenge);
  }

  private async handleDevicePairingExchange(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.deviceIdentityService) {
      writeJson(response, 503, { error: "device_pairing_unavailable" });
      return;
    }
    const body = await readJsonBody(request, 16 * 1024);
    const challengeId = stringField(body, "challengeId");
    const userCode = stringField(body, "userCode");
    const deviceLabel = stringField(body, "deviceLabel");
    if (!userCode || !deviceLabel) {
      writeJson(response, 400, { error: "invalid_pairing_exchange" });
      return;
    }
    const issued = challengeId
      ? await this.options.deviceIdentityService.exchangeChallenge({ challengeId, userCode, deviceLabel })
      : await this.options.deviceIdentityService.exchangeActiveChallenge({ userCode, deviceLabel });
    response.setHeader("cache-control", "no-store");
    writeJson(response, 201, issued);
  }

  private async verifyDeviceToken(header: string | undefined, routeId: NetworkApiRouteId): Promise<boolean> {
    const token = bearerToken(header);
    if (!token || !this.options.deviceIdentityService) return false;
    return Boolean(await this.options.deviceIdentityService.verifyToken(token, requiredDeviceScope(routeId)));
  }

  publishCompanionCatalogChange(
    kind: "created" | "renamed" | "deleted" | "changed",
    notebookId?: string,
    sessionId?: string
  ): void {
    this.queueRevisionEvent({ scope: "catalog", kind, notebookId, sessionId, at: new Date().toISOString() });
  }

  publishCompanionDeleted(notebookId: string, sessionId: string): void {
    this.companionSnapshotCache.delete(`${notebookId}\u0000${sessionId}`);
    this.queueRevisionEvent({
      scope: "session",
      kind: "deleted",
      notebookId,
      sessionId,
      at: new Date().toISOString()
    });
    this.publishCompanionCatalogChange("deleted", notebookId, sessionId);
  }

  private queueRevisionEvent(input: Parameters<RevisionEventLog["append"]>[0]): void {
    this.trackBackgroundTask(this.revisionEvents.append(input));
  }

  private broadcastRevisionEvent(event: RevisionEvent): void {
    if (event.scope === "catalog") {
      for (const response of this.companionCatalogStreams) writeRevisionEvent(response, event);
      return;
    }
    for (const stream of this.companionStreams) {
      if (stream.notebookId === event.notebookId && stream.sessionId === event.sessionId) {
        writeRevisionEvent(stream.response, event);
      }
    }
  }

  private trackBackgroundTask(task: Promise<unknown>): void {
    this.backgroundTasks.add(task);
    void task.then(
      () => this.backgroundTasks.delete(task),
      () => this.backgroundTasks.delete(task)
    );
  }

  private async rollbackFailedStart(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.unsubscribeRevisionEvents?.();
    this.unsubscribeRevisionEvents = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.revisionEvents.close();
  }
}

function applyPrivateApiCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (!origin) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "Authorization, Content-Type, Last-Event-ID, X-MathNotes-Device-Id"
  );
  response.setHeader("access-control-max-age", "600");
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("access-control-allow-private-network", "true");
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled network API route: ${String(value)}`);
}

function readLastEventId(request: IncomingMessage, url: URL): string | undefined {
  const header = request.headers["last-event-id"];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() || url.searchParams.get("lastEventId")?.trim() || undefined;
}

function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

function verifyBearerToken(header: string | undefined, expectedToken: string): boolean {
  const token = bearerToken(header);
  if (!token) return false;
  const actual = Buffer.from(token, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createNetworkApiCoreService(server: NetworkApiServer) {
  return {
    name: "network-api",
    async start() {
      await server.start();
    },
    async stop() {
      await server.stop();
    }
  };
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new UploadError("Request body is too large", 413);
    chunks.push(bytes);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new UploadError("Invalid JSON request", 400);
  }
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" ? value.trim() : undefined;
}

function pairingErrorStatus(error: DeviceIdentityError): number {
  return error.code === "pairing_attempts_exhausted" ? 429 : 400;
}

function requiredDeviceScope(routeId: NetworkApiRouteId): DeviceScope | undefined {
  if (routeId === "health" || routeId === "pairing.challenge" || routeId === "pairing.exchange") return undefined;
  if (
    routeId === "material.upload" ||
    routeId === "material.upload.status" ||
    routeId === "material.recognition.retry"
  ) return "material.upload";
  return "companion.read";
}

function writeReplay(
  response: ServerResponse,
  replay: Awaited<ReturnType<RevisionEventLog["replay"]>>,
  scope: "catalog" | "session"
): void {
  if (replay.status === "resync-required") {
    response.write(`event: resync-required\ndata: ${JSON.stringify({ version: 1, scope, latestEventId: replay.latestId })}\n\n`);
    return;
  }
  for (const event of replay.events) writeRevisionEvent(response, event);
}

function writeRevisionEvent(response: ServerResponse, event: RevisionEvent): void {
  const eventName = event.scope === "catalog"
    ? "catalog-changed"
    : event.kind === "deleted" ? "session-deleted" : "session-changed";
  const payload = event.scope === "catalog"
    ? { version: 1, kind: event.kind, notebookId: event.notebookId, sessionId: event.sessionId, at: event.at }
    : {
        version: 1,
        notebookId: event.notebookId,
        sessionId: event.sessionId,
        revisionHint: event.revision ?? event.at,
        at: event.at
      };
  response.write(`id: ${event.id}\nevent: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function parseMultipartUpload(
  request: IncomingMessage,
  maxUploadBytes: number,
  onActivity?: (activity: CompanionUploadActivity) => void
): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    const parser = Busboy({
      headers: request.headers,
      limits: {
        fields: 32,
        fieldSize: 256 * 1024,
        files: 1,
        fileSize: maxUploadBytes
      }
    });
    const fields: Record<string, string> = {};
    let material: ParsedUpload["material"] | undefined;
    let settled = false;

    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    parser.on("field", (name, value) => {
      fields[name] = value;
    });

    parser.on("file", (fieldName, file, info) => {
      if (fieldName !== "photo" && fieldName !== "material") {
        file.resume();
        return;
      }

      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      file.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        receivedBytes += chunk.length;
        const activity = receivingUploadActivity(fields, info.filename, receivedBytes);
        if (activity) onActivity?.(activity);
      });
      file.on("limit", () => {
        fail(new UploadError("material exceeds maximum upload size", 413));
      });
      file.on("end", () => {
        if (!settled) {
          material = {
            originalName: info.filename,
            mimeType: info.mimeType,
            bytes: Buffer.concat(chunks)
          };
        }
      });
    });

    parser.on("error", fail);
    parser.on("finish", () => {
      if (settled) {
        return;
      }

      if (!material) {
        fail(new UploadError("missing material field", 400));
        return;
      }

      settled = true;
      resolve({ fields, material });
    });

    request.pipe(parser);
  });
}

function requiredField(fields: Record<string, string>, name: string): string {
  const value = fields[name];
  if (!value) {
    throw new UploadError(`missing field: ${name}`, 400);
  }

  return value;
}

function uploadResponse(result: IngestPhotoResult): Record<string, unknown> {
  return {
    uploadId: result.uploadId,
    duplicate: result.duplicate,
    assetPath: result.assetPath,
    imageBlockId: result.imageBlockId,
    transcriptBlockId: result.transcriptBlockId,
    recognitionJobId: result.recognitionJobId,
    recognitionStatus: result.recognitionStatus,
    warnings: result.warnings ?? []
  };
}

class CompanionProtocolError extends Error {
  constructor(message: string, readonly statusCode: number, readonly detail?: string) {
    super(message);
    this.name = "CompanionProtocolError";
  }
}

function companionEtag(revision: string): string {
  return `"${Buffer.from(revision, "utf8").toString("base64url")}"`;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function pdfUploadResponse(result: IngestPdfResult): Record<string, unknown> {
  return {
    uploadId: result.uploadId,
    duplicate: result.duplicate,
    materialType: result.materialType,
    notebookId: result.notebookId,
    sessionId: result.sessionId,
    inboxPath: result.inboxPath,
    assetPath: result.assetPath,
    pdfBlockId: result.pdfBlockId,
    fileName: result.fileName,
    byteLength: result.byteLength,
    pageCount: result.pageCount
  };
}

function safeId(value: string | null): string | undefined {
  return isSafeWorkspaceIdentifier(value) ? value : undefined;
}

function receivingUploadActivity(
  fields: Record<string, string>,
  fileName: string,
  receivedBytes: number
): CompanionUploadActivity | undefined {
  const notebookId = fields.notebookId?.trim();
  const sessionId = fields.sessionId?.trim();
  if (!notebookId || !sessionId) return undefined;
  const totalBytes = Number(fields.byteLength);
  return {
    version: 1,
    notebookId,
    sessionId,
    captureId: fields.captureId?.trim() || undefined,
    fileName: fields.sourceName?.trim() || fileName || undefined,
    receivedBytes,
    totalBytes: Number.isSafeInteger(totalBytes) && totalBytes >= 0 ? totalBytes : undefined,
    status: "receiving",
    updatedAt: new Date().toISOString()
  };
}

function acceptedUploadActivity(
  fields: Record<string, string>,
  receivedBytes: number
): CompanionUploadActivity {
  return {
    version: 1,
    notebookId: requiredField(fields, "notebookId"),
    sessionId: requiredField(fields, "sessionId"),
    captureId: fields.captureId?.trim() || undefined,
    fileName: fields.sourceName?.trim() || undefined,
    receivedBytes,
    totalBytes: receivedBytes,
    status: "accepted",
    updatedAt: new Date().toISOString()
  };
}

function parseImageTransform(raw: string | undefined): ImageTransformSidecar | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as ImageTransformSidecar;
    assertValidImageTransformSidecar(parsed);
    return parsed;
  } catch {
    throw new UploadError("invalid image transform metadata", 400);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
