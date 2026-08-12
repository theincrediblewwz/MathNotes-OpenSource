import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authorizeCoreApiCapability, resolveLocalShellApiRoute } from "./capabilityPolicy";
import type {
  NotebookSessionSummary,
  NotebookSummary,
  NotesCatalog
} from "../catalog/sessionCatalog";
import { WorkspaceCommandError } from "../catalog/workspaceCommandService";
import type {
  ReadonlyMarkdownPreview,
  ReadonlySessionAsset,
  ReadonlySessionBlock,
  ReadonlySessionManifest
} from "../session/sessionReadService";
import { SessionReadError } from "../session/sessionReadService";
import type {
  ResolveMarkdownConflictInput,
  ResolveMarkdownConflictResult,
  SaveMarkdownBlockResult,
  SetMarkdownBlockLockResult,
  SessionMarkdownConflict,
  SessionMarkdownConflictSummary
} from "../session/sessionEditService";
import { SessionEditError } from "../session/sessionEditService";
import type { ImportSessionImageResult } from "../session/sessionImageImportService";
import { MAX_LOCAL_IMAGE_BYTES, SessionImageImportError } from "../session/sessionImageImportService";
import type { ImportSessionPdfResult } from "../session/sessionPdfImportService";
import { MAX_LOCAL_PDF_BYTES, SessionPdfImportError } from "../session/sessionPdfImportService";
import { SessionRecognitionError, type SessionRecognitionService } from "../session/sessionRecognitionService";
import {
  SessionAssistantError,
  type SessionAssistantInput,
  type SessionAssistantService
} from "../session/sessionAssistantService";
import { SessionExportError, type SessionExportDownload, type ExportSessionMarkdownResult } from "../session/sessionExportService";
import {
  SessionBlockOrganizeError,
  type DeleteSessionBlocksInput,
  type ReorderSessionBlocksInput,
  type TransferSessionBlocksInput,
  type TransferSessionBlocksResult
} from "../session/sessionBlockOrganizeService";
import {
  RuntimeProviderConfigurationError,
  normalizeRuntimeProviderPurpose,
  type RuntimeProviderConfiguration,
  type RuntimeProviderRegistry
} from "../provider/runtimeProviderRegistry";
import type { PairingChallenge } from "../device/deviceIdentityService";
import type { CompanionUploadActivity } from "./networkApiContracts";
import type {
  NotationPreviewInput,
  NotationProfileConfig,
  NotationPromptPreview,
  PromptTemplateConfig
} from "../provider/aiGuidanceSettingsService";

const MAX_MARKDOWN_SAVE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_BLOCK_LOCK_BODY_BYTES = 1024;
const MAX_CONFLICT_RESOLUTION_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RECOGNITION_BODY_BYTES = 16 * 1024;
const MAX_PROVIDER_BODY_BYTES = 16 * 1024;
const MAX_WORKSPACE_CREATE_BODY_BYTES = 8 * 1024;
const MAX_BLOCK_ORGANIZE_BODY_BYTES = 64 * 1024;
const MAX_ASSISTANT_BODY_BYTES = 64 * 1024;
const MAX_AI_GUIDANCE_BODY_BYTES = 512 * 1024;

export type LocalShellServerOptions = {
  host?: "127.0.0.1" | "::1";
  port: number;
  token: string;
  apiVersion?: number;
  readCatalog?: () => Promise<NotesCatalog>;
  createNotebook?: (input: { title: string }) => Promise<NotebookSummary>;
  createSession?: (input: { notebookId: string; title: string }) => Promise<NotebookSessionSummary>;
  createCompanionPairingChallenge?: () => Promise<PairingChallenge>;
  readSessionManifest?: (input: { notebookId: string; sessionId: string }) => Promise<ReadonlySessionManifest>;
  readSessionBlock?: (input: { notebookId: string; sessionId: string; blockId: string }) => Promise<ReadonlySessionBlock>;
  previewSessionMarkdown?: (input: {
    notebookId: string;
    sessionId: string;
    blockId: string;
    markdown: string;
  }) => Promise<ReadonlyMarkdownPreview>;
  previewStandaloneMarkdown?: (input: { markdown: string }) => Promise<ReadonlyMarkdownPreview>;
  appendSessionMarkdown?: (input: {
    notebookId: string;
    sessionId: string;
    markdown: string;
    sourceName?: string;
  }) => Promise<ReadonlySessionBlock>;
  saveSessionBlock?: (input: {
    notebookId: string;
    sessionId: string;
    blockId: string;
    markdown: string;
    baseRevision: string;
  }) => Promise<SaveMarkdownBlockResult>;
  setSessionBlockLock?: (input: {
    notebookId: string;
    sessionId: string;
    blockId: string;
    locked: boolean;
  }) => Promise<SetMarkdownBlockLockResult>;
  reorderSessionBlocks?: (input: ReorderSessionBlocksInput) => Promise<ReadonlySessionManifest>;
  deleteSessionBlocks?: (input: DeleteSessionBlocksInput) => Promise<ReadonlySessionManifest>;
  transferSessionBlocks?: (input: TransferSessionBlocksInput) => Promise<TransferSessionBlocksResult>;
  listSessionConflicts?: (input: {
    notebookId: string;
    sessionId: string;
    blockId?: string;
  }) => Promise<SessionMarkdownConflictSummary[]>;
  readSessionConflict?: (input: {
    notebookId: string;
    sessionId: string;
    conflictId: string;
  }) => Promise<SessionMarkdownConflict>;
  resolveSessionConflict?: (input: ResolveMarkdownConflictInput) => Promise<ResolveMarkdownConflictResult>;
  importSessionImage?: (input: {
    notebookId: string;
    sessionId: string;
    fileName: string;
    bytes: Buffer;
    baseRevision: string;
  }) => Promise<ImportSessionImageResult>;
  importSessionPdf?: (input: {
    notebookId: string;
    sessionId: string;
    fileName: string;
    bytes: Buffer;
    baseRevision: string;
  }) => Promise<ImportSessionPdfResult>;
  readSessionAsset?: (input: { notebookId: string; sessionId: string; assetPath: string }) => Promise<ReadonlySessionAsset>;
  sessionRecognition?: SessionRecognitionService;
  readSessionCompanionActivity?: (input: {
    notebookId: string;
    sessionId: string;
  }) => CompanionUploadActivity | undefined | Promise<CompanionUploadActivity | undefined>;
  sessionAssistant?: SessionAssistantService;
  exportSessionMarkdown?: (input: {
    notebookId: string;
    sessionId: string;
    baseRevision?: string;
  }) => Promise<ExportSessionMarkdownResult>;
  readSessionMarkdownExport?: (input: { notebookId: string; sessionId: string }) => Promise<SessionExportDownload>;
  providerRegistry?: RuntimeProviderRegistry;
  readPromptTemplates?: () => PromptTemplateConfig | Promise<PromptTemplateConfig>;
  savePromptTemplates?: (input: PromptTemplateConfig) => Promise<PromptTemplateConfig>;
  readNotationProfiles?: () => NotationProfileConfig | Promise<NotationProfileConfig>;
  saveNotationProfiles?: (input: NotationProfileConfig) => Promise<NotationProfileConfig>;
  previewNotation?: (input: NotationPreviewInput) => NotationPromptPreview | Promise<NotationPromptPreview>;
};

export type StartedLocalShellServer = {
  host: string;
  port: number;
  url: string;
  apiVersion: number;
};

export class LocalShellServer {
  private server?: Server;
  private readonly host: "127.0.0.1" | "::1";
  private readonly apiVersion: number;

  constructor(private readonly options: LocalShellServerOptions) {
    if (options.host && options.host !== "127.0.0.1" && options.host !== "::1") {
      throw new Error("Local shell server may only listen on loopback");
    }
    this.host = options.host ?? "127.0.0.1";
    this.apiVersion = options.apiVersion ?? 1;
    if (Buffer.byteLength(options.token, "utf8") < 32) {
      throw new Error("Local shell token must contain at least 32 bytes");
    }
  }

  async start(): Promise<StartedLocalShellServer> {
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address === "object") return this.serverInfo(address.port);
    }
    this.server = createServer((request, response) => void this.handleRequest(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.options.port, this.host, resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Unable to determine local shell address");
    return this.serverInfo(address.port);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? this.host}`);
    const route = resolveLocalShellApiRoute(request.method ?? "", url.pathname);
    if (!route) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    if (!hasBearerToken(request.headers.authorization, this.options.token)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (!authorizeCoreApiCapability("trusted-local-host", route.capability)) {
      writeJson(response, 403, { error: "forbidden" });
      return;
    }
    try {
      if (route.id === "local.health") {
        writeJson(response, 200, { ok: true, apiVersion: this.apiVersion });
        return;
      }
      if (route.id === "local.catalog") {
        if (!this.options.readCatalog) return writeJson(response, 503, { error: "catalog_unavailable" });
        writeJson(response, 200, await this.options.readCatalog());
        return;
      }
      if (route.id === "local.companion.pairing.challenge") {
        if (!this.options.createCompanionPairingChallenge) {
          return writeJson(response, 503, { error: "device_pairing_unavailable" });
        }
        writeJson(response, 201, {
          version: 1,
          challenge: await this.options.createCompanionPairingChallenge()
        });
        return;
      }
      if (route.id === "local.notebook.create") {
        if (!this.options.createNotebook) return writeJson(response, 503, { error: "workspace_write_unavailable" });
        const body = await readJsonBody(request, MAX_WORKSPACE_CREATE_BODY_BYTES);
        if (!isNotebookCreateBody(body)) throw new BodyError("invalid_notebook_body", 400);
        writeJson(response, 201, {
          version: 1,
          notebook: await this.options.createNotebook({ title: body.title })
        });
        return;
      }
      if (route.id === "local.session.create") {
        if (!this.options.createSession) return writeJson(response, 503, { error: "workspace_write_unavailable" });
        const body = await readJsonBody(request, MAX_WORKSPACE_CREATE_BODY_BYTES);
        if (!isSessionCreateBody(body)) throw new BodyError("invalid_session_body", 400);
        writeJson(response, 201, {
          version: 1,
          session: await this.options.createSession({
            notebookId: body.notebookId,
            title: body.title
          })
        });
        return;
      }
      if (route.id === "local.provider.status") {
        if (!this.options.providerRegistry) return writeJson(response, 503, { error: "provider_settings_unavailable" });
        writeJson(response, 200, this.options.providerRegistry.status(normalizeRuntimeProviderPurpose(url.searchParams.get("purpose"))));
        return;
      }
      if (route.id === "local.provider.configure") {
        if (!this.options.providerRegistry) return writeJson(response, 503, { error: "provider_settings_unavailable" });
        const body = await readJsonBody(request, MAX_PROVIDER_BODY_BYTES);
        if (!isProviderConfiguration(body)) throw new BodyError("invalid_provider_body", 400);
        writeJson(response, 200, this.options.providerRegistry.configure(
          body,
          normalizeRuntimeProviderPurpose(url.searchParams.get("purpose"))
        ));
        return;
      }
      if (route.id === "local.provider.clear") {
        if (!this.options.providerRegistry) return writeJson(response, 503, { error: "provider_settings_unavailable" });
        writeJson(response, 200, this.options.providerRegistry.clear(normalizeRuntimeProviderPurpose(url.searchParams.get("purpose"))));
        return;
      }
      if (route.id === "local.markdown.preview") {
        if (!this.options.previewStandaloneMarkdown) {
          return writeJson(response, 503, { error: "markdown_preview_unavailable" });
        }
        const body = await readJsonBody(request, MAX_MARKDOWN_SAVE_BODY_BYTES);
        if (!isStandaloneMarkdownBody(body)) throw new BodyError("invalid_markdown_preview_body", 400);
        writeJson(response, 200, await this.options.previewStandaloneMarkdown({ markdown: body.markdown }));
        return;
      }
      if (route.id === "local.provider.test") {
        if (!this.options.providerRegistry) return writeJson(response, 503, { error: "provider_settings_unavailable" });
        const purpose = normalizeRuntimeProviderPurpose(url.searchParams.get("purpose"));
        if (!this.options.providerRegistry.status(purpose).configured) {
          return writeJson(response, 503, { error: "provider_unavailable" });
        }
        writeJson(response, 200, await this.options.providerRegistry.testConnection(purpose));
        return;
      }
      if (route.id === "local.ai.prompt.list") {
        if (!this.options.readPromptTemplates) return writeJson(response, 503, { error: "ai_guidance_unavailable" });
        writeJson(response, 200, await this.options.readPromptTemplates());
        return;
      }
      if (route.id === "local.ai.prompt.save") {
        if (!this.options.savePromptTemplates) return writeJson(response, 503, { error: "ai_guidance_unavailable" });
        const body = await readJsonBody(request, MAX_AI_GUIDANCE_BODY_BYTES);
        if (!isPromptTemplateConfig(body)) throw new BodyError("invalid_prompt_template_body", 400);
        writeJson(response, 200, await this.options.savePromptTemplates(body));
        return;
      }
      if (route.id === "local.ai.notation.list") {
        if (!this.options.readNotationProfiles) return writeJson(response, 503, { error: "ai_guidance_unavailable" });
        writeJson(response, 200, await this.options.readNotationProfiles());
        return;
      }
      if (route.id === "local.ai.notation.save") {
        if (!this.options.saveNotationProfiles) return writeJson(response, 503, { error: "ai_guidance_unavailable" });
        const body = await readJsonBody(request, MAX_AI_GUIDANCE_BODY_BYTES);
        if (!isNotationProfileConfig(body)) throw new BodyError("invalid_notation_profile_body", 400);
        writeJson(response, 200, await this.options.saveNotationProfiles(body));
        return;
      }
      if (route.id === "local.ai.notation.preview") {
        if (!this.options.previewNotation) return writeJson(response, 503, { error: "ai_guidance_unavailable" });
        const body = await readJsonBody(request, MAX_AI_GUIDANCE_BODY_BYTES);
        if (!isNotationPreviewInput(body)) throw new BodyError("invalid_notation_preview_body", 400);
        writeJson(response, 200, await this.options.previewNotation(body));
        return;
      }
      const notebookId = requiredQuery(url, "notebookId");
      const sessionId = requiredQuery(url, "sessionId");
      if (route.id === "local.session.manifest") {
        if (!this.options.readSessionManifest) return writeJson(response, 503, { error: "session_unavailable" });
        writeJson(response, 200, await this.options.readSessionManifest({ notebookId, sessionId }));
        return;
      }
      if (route.id === "local.session.block") {
        if (!this.options.readSessionBlock) return writeJson(response, 503, { error: "session_unavailable" });
        writeJson(response, 200, await this.options.readSessionBlock({
          notebookId,
          sessionId,
          blockId: requiredQuery(url, "blockId")
        }));
        return;
      }
      if (route.id === "local.session.block.save") {
        if (!this.options.saveSessionBlock) return writeJson(response, 503, { error: "session_write_unavailable" });
        const body = await readJsonBody(request, MAX_MARKDOWN_SAVE_BODY_BYTES);
        if (!isSaveBody(body)) throw new BodyError("invalid_save_body", 400);
        writeJson(response, 200, await this.options.saveSessionBlock({
          notebookId,
          sessionId,
          blockId: requiredQuery(url, "blockId"),
          markdown: body.markdown,
          baseRevision: body.baseRevision
        }));
        return;
      }
      if (route.id === "local.session.conflicts") {
        if (!this.options.listSessionConflicts) return writeJson(response, 503, { error: "session_write_unavailable" });
        writeJson(response, 200, {
          version: 1,
          conflicts: await this.options.listSessionConflicts({
            notebookId,
            sessionId,
            blockId: url.searchParams.get("blockId")?.trim() || undefined
          })
        });
        return;
      }
      if (route.id === "local.session.conflict") {
        if (!this.options.readSessionConflict) return writeJson(response, 503, { error: "session_write_unavailable" });
        writeJson(response, 200, await this.options.readSessionConflict({
          notebookId,
          sessionId,
          conflictId: requiredConflictId(url)
        }));
        return;
      }
      if (route.id === "local.session.conflict.resolve") {
        if (!this.options.resolveSessionConflict) return writeJson(response, 503, { error: "session_write_unavailable" });
        const body = await readJsonBody(request, MAX_CONFLICT_RESOLUTION_BODY_BYTES);
        if (!isConflictResolutionBody(body)) throw new BodyError("invalid_conflict_resolution", 400);
        writeJson(response, 200, await this.options.resolveSessionConflict({
          notebookId,
          sessionId,
          conflictId: requiredConflictId(url),
          resolution: body.resolution,
          baseRevision: body.baseRevision,
          markdown: body.markdown
        }));
        return;
      }
      if (route.id === "local.session.image.import") {
        if (!this.options.importSessionImage) return writeJson(response, 503, { error: "session_write_unavailable" });
        const baseRevision = requiredRevision(url, "baseRevision");
        const bytes = await readBody(request, MAX_LOCAL_IMAGE_BYTES);
        writeJson(response, 200, await this.options.importSessionImage({
          notebookId,
          sessionId,
          fileName: requiredQuery(url, "fileName"),
          bytes,
          baseRevision
        }));
        return;
      }
      if (route.id === "local.session.markdown.append") {
        if (!this.options.appendSessionMarkdown) return writeJson(response, 503, { error: "session_write_unavailable" });
        const body = await readJsonBody(request, MAX_MARKDOWN_SAVE_BODY_BYTES);
        if (!isAppendMarkdownBody(body)) throw new BodyError("invalid_markdown_append_body", 400);
        writeJson(response, 201, await this.options.appendSessionMarkdown({
          notebookId,
          sessionId,
          markdown: body.markdown,
          sourceName: body.sourceName
        }));
        return;
      }
      if (route.id === "local.session.block.lock") {
        if (!this.options.setSessionBlockLock) {
          return writeJson(response, 503, { error: "session_write_unavailable" });
        }
        const body = await readJsonBody(request, MAX_BLOCK_LOCK_BODY_BYTES);
        if (!isBlockLockBody(body)) throw new BodyError("invalid_block_lock_body", 400);
        writeJson(response, 200, await this.options.setSessionBlockLock({
          notebookId,
          sessionId,
          blockId: requiredQuery(url, "blockId"),
          locked: body.locked
        }));
        return;
      }
      if (route.id === "local.session.blocks.reorder") {
        if (!this.options.reorderSessionBlocks) {
          return writeJson(response, 503, { error: "session_organize_unavailable" });
        }
        const body = await readJsonBody(request, MAX_BLOCK_ORGANIZE_BODY_BYTES);
        if (!isReorderBlocksBody(body)) throw new BodyError("invalid_reorder_body", 400);
        const manifest = await this.options.reorderSessionBlocks({
          notebookId,
          sessionId,
          blockIds: body.blockIds,
          direction: body.direction
        });
        writeJson(response, 200, { version: 1, reordered: true, manifest });
        return;
      }
      if (route.id === "local.session.blocks.delete") {
        if (!this.options.deleteSessionBlocks) {
          return writeJson(response, 503, { error: "session_organize_unavailable" });
        }
        const body = await readJsonBody(request, MAX_BLOCK_ORGANIZE_BODY_BYTES);
        if (!isDeleteBlocksBody(body)) throw new BodyError("invalid_delete_body", 400);
        const manifest = await this.options.deleteSessionBlocks({
          notebookId,
          sessionId,
          blockIds: body.blockIds
        });
        writeJson(response, 200, { version: 1, deleted: true, manifest });
        return;
      }
      if (route.id === "local.session.markdown.preview") {
        if (!this.options.previewSessionMarkdown) {
          return writeJson(response, 503, { error: "markdown_preview_unavailable" });
        }
        const body = await readJsonBody(request, MAX_MARKDOWN_SAVE_BODY_BYTES);
        if (!isMarkdownPreviewBody(body)) throw new BodyError("invalid_markdown_preview_body", 400);
        writeJson(response, 200, await this.options.previewSessionMarkdown({
          notebookId,
          sessionId,
          blockId: body.blockId,
          markdown: body.markdown
        }));
        return;
      }
      if (route.id === "local.session.blocks.transfer") {
        if (!this.options.transferSessionBlocks) {
          return writeJson(response, 503, { error: "session_organize_unavailable" });
        }
        const body = await readJsonBody(request, MAX_BLOCK_ORGANIZE_BODY_BYTES);
        if (!isTransferBlocksBody(body)) throw new BodyError("invalid_transfer_body", 400);
        writeJson(response, 200, await this.options.transferSessionBlocks({
          sourceNotebookId: notebookId,
          sourceSessionId: sessionId,
          targetNotebookId: body.targetNotebookId,
          targetSessionId: body.targetSessionId,
          blockIds: body.blockIds,
          mode: body.mode
        }));
        return;
      }
      if (route.id === "local.session.pdf.import") {
        if (!this.options.importSessionPdf) return writeJson(response, 503, { error: "session_write_unavailable" });
        const baseRevision = requiredRevision(url, "baseRevision");
        const bytes = await readBody(request, MAX_LOCAL_PDF_BYTES);
        writeJson(response, 200, await this.options.importSessionPdf({
          notebookId,
          sessionId,
          fileName: requiredQuery(url, "fileName"),
          bytes,
          baseRevision
        }));
        return;
      }
      if (route.id === "local.session.recognition.start") {
        if (!this.options.sessionRecognition) return writeJson(response, 503, { error: "recognition_unavailable" });
        const body = await readJsonBody(request, MAX_RECOGNITION_BODY_BYTES);
        if (!isRecognitionStartBody(body)) throw new BodyError("invalid_recognition_body", 400);
        writeJson(response, 202, {
          version: 1,
          task: await this.options.sessionRecognition.start({ notebookId, sessionId, imageBlockId: body.imageBlockId })
        });
        return;
      }
      if (route.id === "local.session.recognition.status") {
        if (!this.options.sessionRecognition) return writeJson(response, 503, { error: "recognition_unavailable" });
        const taskId = url.searchParams.get("taskId")?.trim();
        const imageBlockId = url.searchParams.get("imageBlockId")?.trim();
        if (!taskId && !imageBlockId) {
          const afterActivitySequence = optionalNonNegativeInteger(url, "afterActivitySequence");
          const waitMs = Math.min(optionalNonNegativeInteger(url, "waitMs"), 30_000);
          if (url.searchParams.has("afterActivitySequence") && waitMs > 0) {
            await this.options.sessionRecognition.waitForActivity({
              notebookId,
              sessionId,
              afterSequence: afterActivitySequence,
              timeoutMs: waitMs
            });
          }
          writeJson(response, 200, {
            version: 1,
            tasks: await this.options.sessionRecognition.list({ notebookId, sessionId }),
            activitySequence: this.options.sessionRecognition.activitySequence({ notebookId, sessionId })
          });
          return;
        }
        const task = taskId
          ? await this.options.sessionRecognition.get({ notebookId, sessionId, taskId })
          : await this.options.sessionRecognition.latest({ notebookId, sessionId, imageBlockId: imageBlockId! });
        writeJson(response, 200, { version: 1, task: task ?? null });
        return;
      }
      if (route.id === "local.session.recognition.events") {
        if (!this.options.sessionRecognition) return writeJson(response, 503, { error: "recognition_unavailable" });
        const taskId = requiredQuery(url, "taskId");
        await this.options.sessionRecognition.get({ notebookId, sessionId, taskId });
        const afterSequence = optionalNonNegativeInteger(url, "afterSequence");
        writeJson(response, 200, {
          version: 1,
          events: this.options.sessionRecognition.eventsAfter(taskId, afterSequence)
        });
        return;
      }
      if (route.id === "local.session.recognition.cancel" || route.id === "local.session.recognition.retry") {
        if (!this.options.sessionRecognition) return writeJson(response, 503, { error: "recognition_unavailable" });
        const input = { notebookId, sessionId, taskId: requiredQuery(url, "taskId") };
        const task = route.id === "local.session.recognition.cancel"
          ? await this.options.sessionRecognition.cancel(input)
          : await this.options.sessionRecognition.retry(input);
        writeJson(response, 200, { version: 1, task });
        return;
      }
      if (route.id === "local.session.recognition.rerun") {
        if (!this.options.sessionRecognition) return writeJson(response, 503, { error: "recognition_unavailable" });
        const body = await readJsonBody(request, MAX_RECOGNITION_BODY_BYTES);
        if (!isRecognitionRerunBody(body)) throw new BodyError("invalid_recognition_body", 400);
        writeJson(response, 202, {
          version: 1,
          task: await this.options.sessionRecognition.rerun({
            notebookId,
            sessionId,
            transcriptBlockId: body.transcriptBlockId
          })
        });
        return;
      }
      if (route.id === "local.session.companion.activity") {
        writeJson(response, 200, {
          version: 1,
          activity: await this.options.readSessionCompanionActivity?.({ notebookId, sessionId }) ?? null
        });
        return;
      }
      if (route.id === "local.session.assistant.list") {
        if (!this.options.sessionAssistant) return writeJson(response, 503, { error: "assistant_unavailable" });
        writeJson(response, 200, {
          version: 1,
          remarks: await this.options.sessionAssistant.list({ notebookId, sessionId })
        });
        return;
      }
      if (route.id === "local.session.assistant.start") {
        if (!this.options.sessionAssistant) return writeJson(response, 503, { error: "assistant_unavailable" });
        const body = await readJsonBody(request, MAX_ASSISTANT_BODY_BYTES);
        if (!isAssistantStartBody(body)) throw new BodyError("invalid_assistant_body", 400);
        writeJson(response, 202, {
          version: 1,
          task: await this.options.sessionAssistant.start({
            notebookId,
            sessionId,
            scope: body.scope,
            activeBlockId: body.activeBlockId,
            selectedText: body.selectedText,
            focusLabel: body.focusLabel,
            question: body.question,
            mode: body.mode,
            firstByteTimeoutMs: body.firstByteTimeoutMs,
            streamIdleTimeoutMs: body.streamIdleTimeoutMs
          })
        });
        return;
      }
      if (route.id === "local.session.assistant.status") {
        if (!this.options.sessionAssistant) return writeJson(response, 503, { error: "assistant_unavailable" });
        writeJson(response, 200, {
          version: 1,
          task: await this.options.sessionAssistant.get({
            notebookId,
            sessionId,
            taskId: requiredQuery(url, "taskId")
          })
        });
        return;
      }
      if (route.id === "local.session.assistant.events") {
        if (!this.options.sessionAssistant) return writeJson(response, 503, { error: "assistant_unavailable" });
        const taskId = requiredQuery(url, "taskId");
        await this.options.sessionAssistant.get({ notebookId, sessionId, taskId });
        const afterSequence = optionalNonNegativeInteger(url, "afterSequence");
        writeJson(response, 200, {
          version: 1,
          events: this.options.sessionAssistant.eventsAfter(taskId, afterSequence)
        });
        return;
      }
      if (route.id === "local.session.assistant.cancel") {
        if (!this.options.sessionAssistant) return writeJson(response, 503, { error: "assistant_unavailable" });
        writeJson(response, 200, {
          version: 1,
          task: await this.options.sessionAssistant.cancel({
            notebookId,
            sessionId,
            taskId: requiredQuery(url, "taskId")
          })
        });
        return;
      }
      if (route.id === "local.session.assistant.preview" || route.id === "local.session.assistant.run") {
        if (!this.options.sessionAssistant) return writeJson(response, 503, { error: "assistant_unavailable" });
        const body = await readJsonBody(request, MAX_ASSISTANT_BODY_BYTES);
        if (!isAssistantBody(body, route.id === "local.session.assistant.run")) {
          throw new BodyError("invalid_assistant_body", 400);
        }
        const input: SessionAssistantInput = {
          notebookId,
          sessionId,
          scope: body.scope,
          activeBlockId: body.activeBlockId,
          selectedText: body.selectedText,
          focusLabel: body.focusLabel,
          question: body.question
        };
        if (route.id === "local.session.assistant.preview") {
          writeJson(response, 200, await this.options.sessionAssistant.preview(input));
          return;
        }
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("Assistant request cancelled"));
        request.once("aborted", abort);
        response.once("close", () => {
          if (!response.writableEnded) abort();
        });
        writeJson(response, 200, {
          version: 1,
          remark: await this.options.sessionAssistant.run({
            ...input,
            mode: body.mode!,
            abortSignal: controller.signal
          })
        });
        return;
      }
      if (route.id === "local.session.assistant.delete" || route.id === "local.session.assistant.promote") {
        if (!this.options.sessionAssistant) return writeJson(response, 503, { error: "assistant_unavailable" });
        const body = await readJsonBody(request, MAX_ASSISTANT_BODY_BYTES);
        if (!isRemarkCommandBody(body)) throw new BodyError("invalid_assistant_body", 400);
        if (route.id === "local.session.assistant.delete") {
          writeJson(response, 200, {
            version: 1,
            deleted: await this.options.sessionAssistant.remove({
              notebookId, sessionId, remarkId: body.remarkId
            })
          });
        } else {
          writeJson(response, 200, await this.options.sessionAssistant.promote({
            notebookId, sessionId, remarkId: body.remarkId
          }));
        }
        return;
      }
      if (route.id === "local.session.export.create") {
        if (!this.options.exportSessionMarkdown) return writeJson(response, 503, { error: "export_unavailable" });
        const baseRevision = url.searchParams.get("baseRevision")?.trim() || undefined;
        if (baseRevision && !/^[a-f0-9]{64}$/.test(baseRevision)) throw new QueryError("invalid_baseRevision");
        const result = await this.options.exportSessionMarkdown({ notebookId, sessionId, baseRevision });
        writeJson(response, 200, {
          version: 1,
          exported: true,
          fileName: result.fileName,
          relativeExportPath: result.relativeExportPath,
          exportedBlocks: result.exportedBlocks,
          byteLength: result.byteLength,
          sha256: result.sha256
        });
        return;
      }
      if (route.id === "local.session.export.download") {
        if (!this.options.readSessionMarkdownExport) return writeJson(response, 503, { error: "export_unavailable" });
        const exported = await this.options.readSessionMarkdownExport({ notebookId, sessionId });
        writeBytes(response, 200, exported.bytes, exported.mimeType, {
          "content-disposition": `attachment; filename="${safeDownloadName(exported.fileName)}"`,
          "x-mathnotes-sha256": exported.sha256
        });
        return;
      }
      if (!this.options.readSessionAsset) return writeJson(response, 503, { error: "session_unavailable" });
      const asset = await this.options.readSessionAsset({
        notebookId,
        sessionId,
        assetPath: requiredQuery(url, "path")
      });
      writeBytes(response, 200, asset.bytes, asset.mimeType);
    } catch (error) {
      const statusCode = error instanceof WorkspaceCommandError
        ? workspaceCommandStatus(error)
        : error instanceof RuntimeProviderConfigurationError || error instanceof QueryError
        ? 400
        : error instanceof SessionReadError || error instanceof SessionEditError || error instanceof SessionImageImportError ||
          error instanceof SessionPdfImportError ||
          error instanceof SessionRecognitionError || error instanceof SessionAssistantError ||
          error instanceof SessionExportError ||
          error instanceof SessionBlockOrganizeError || error instanceof BodyError
          ? error.statusCode
          : 500;
      writeJson(response, statusCode, {
        error: statusCode === 500 ? "local_request_failed" :
          error instanceof SessionEditError || error instanceof SessionImageImportError || error instanceof SessionPdfImportError ||
          error instanceof SessionExportError || error instanceof RuntimeProviderConfigurationError ||
          error instanceof SessionAssistantError || error instanceof SessionBlockOrganizeError ||
          error instanceof WorkspaceCommandError ? error.code :
          error instanceof Error ? error.message : "invalid_request",
        ...(error instanceof SessionEditError && error.details?.conflictId
          ? { conflictId: error.details.conflictId }
          : {})
      });
    }
  }

  private serverInfo(port: number): StartedLocalShellServer {
    const bracketedHost = this.host === "::1" ? `[${this.host}]` : this.host;
    return { host: this.host, port, url: `http://${bracketedHost}:${port}`, apiVersion: this.apiVersion };
  }
}

function workspaceCommandStatus(error: WorkspaceCommandError): number {
  if (error.code === "notebook_not_found") return 404;
  if (error.code === "workspace_conflict") return 409;
  return 400;
}

function hasBearerToken(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const actualBytes = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function writeBytes(
  response: ServerResponse,
  statusCode: number,
  bytes: Buffer,
  mimeType: string,
  extraHeaders: Readonly<Record<string, string>> = {}
): void {
  response.writeHead(statusCode, {
    "content-type": mimeType,
    "content-length": String(bytes.byteLength),
    "cache-control": "private, max-age=60",
    ...extraHeaders
  });
  response.end(bytes);
}

function safeDownloadName(fileName: string): string {
  return fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "session.md";
}

class QueryError extends Error {}

class BodyError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const bytes = await readBody(request, limit);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new BodyError("invalid_json", 400);
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > limit) throw new BodyError("request_body_too_large", 413);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function isSaveBody(value: unknown): value is { markdown: string; baseRevision: string } {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.markdown === "string" && typeof body.baseRevision === "string" &&
    /^[a-f0-9]{64}$/.test(body.baseRevision);
}

function isBlockLockBody(value: unknown): value is { locked: boolean } {
  return typeof value === "object" && value !== null &&
    typeof (value as { locked?: unknown }).locked === "boolean";
}

function isMarkdownPreviewBody(value: unknown): value is { blockId: string; markdown: string } {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.blockId === "string" && isSafeLocalIdentifier(body.blockId) &&
    typeof body.markdown === "string";
}

function isStandaloneMarkdownBody(value: unknown): value is { markdown: string } {
  return typeof value === "object" && value !== null &&
    typeof (value as { markdown?: unknown }).markdown === "string";
}

function isAppendMarkdownBody(value: unknown): value is { markdown: string; sourceName?: string } {
  if (!isStandaloneMarkdownBody(value)) return false;
  const sourceName = (value as { sourceName?: unknown }).sourceName;
  return sourceName === undefined || (typeof sourceName === "string" && sourceName.trim().length > 0 && sourceName.length <= 240);
}

function isReorderBlocksBody(value: unknown): value is {
  blockIds: string[];
  direction: "up" | "down";
} {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return isBlockIdList(body.blockIds) && (body.direction === "up" || body.direction === "down");
}

function isDeleteBlocksBody(value: unknown): value is { blockIds: string[] } {
  if (!value || typeof value !== "object") return false;
  return isBlockIdList((value as Record<string, unknown>).blockIds);
}

function isTransferBlocksBody(value: unknown): value is {
  targetNotebookId: string;
  targetSessionId: string;
  blockIds: string[];
  mode: "copy" | "move";
} {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.targetNotebookId === "string" && isSafeLocalIdentifier(body.targetNotebookId) &&
    typeof body.targetSessionId === "string" && isSafeLocalIdentifier(body.targetSessionId) &&
    isBlockIdList(body.blockIds) && (body.mode === "copy" || body.mode === "move");
}

function isBlockIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 500 &&
    value.every((item) => typeof item === "string" && isSafeLocalIdentifier(item));
}

function isSafeLocalIdentifier(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 && trimmed !== "." && trimmed !== ".." && !/[\\/]/.test(trimmed);
}

function isConflictResolutionBody(value: unknown): value is {
  resolution: "current" | "incoming" | "merged";
  baseRevision: string;
  markdown?: string;
} {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (body.resolution === "current" || body.resolution === "incoming" || body.resolution === "merged") &&
    typeof body.baseRevision === "string" && /^[a-f0-9]{64}$/.test(body.baseRevision) &&
    (body.resolution !== "merged" || typeof body.markdown === "string") &&
    (body.markdown === undefined || typeof body.markdown === "string");
}

function isRecognitionStartBody(value: unknown): value is { imageBlockId: string } {
  if (!value || typeof value !== "object") return false;
  const imageBlockId = (value as Record<string, unknown>).imageBlockId;
  return typeof imageBlockId === "string" && imageBlockId.trim().length > 0 && imageBlockId.length <= 200;
}

function isRecognitionRerunBody(value: unknown): value is { transcriptBlockId: string } {
  if (!value || typeof value !== "object") return false;
  const transcriptBlockId = (value as Record<string, unknown>).transcriptBlockId;
  return typeof transcriptBlockId === "string" && isSafeLocalIdentifier(transcriptBlockId);
}

function isAssistantBody(value: unknown, requireMode: boolean): value is {
  scope: SessionAssistantInput["scope"];
  activeBlockId?: string;
  selectedText?: string;
  focusLabel?: string;
  question?: string;
  mode?: "explain" | "teach" | "summarize";
} {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  if (body.scope !== "selection" && body.scope !== "block" && body.scope !== "session") return false;
  if (requireMode && body.mode !== "explain" && body.mode !== "teach" && body.mode !== "summarize") return false;
  if (body.scope !== "session" && (typeof body.activeBlockId !== "string" || !isSafeLocalIdentifier(body.activeBlockId))) {
    return false;
  }
  return optionalBoundedText(body.selectedText, 12_000) &&
    optionalBoundedText(body.focusLabel, 500) &&
    optionalBoundedText(body.question, 8_000);
}

function isAssistantStartBody(value: unknown): value is {
  scope: SessionAssistantInput["scope"];
  activeBlockId?: string;
  selectedText?: string;
  focusLabel?: string;
  question?: string;
  mode: "explain" | "teach" | "summarize";
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
} {
  if (!isAssistantBody(value, true)) return false;
  const body = value as Record<string, unknown>;
  return optionalTimeout(body.firstByteTimeoutMs) && optionalTimeout(body.streamIdleTimeoutMs);
}

function optionalTimeout(value: unknown): boolean {
  return value === undefined ||
    (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 600_000);
}

function isRemarkCommandBody(value: unknown): value is { remarkId: string } {
  if (!value || typeof value !== "object") return false;
  const remarkId = (value as Record<string, unknown>).remarkId;
  return typeof remarkId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(remarkId);
}

function optionalBoundedText(value: unknown, maximum: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maximum);
}

function isProviderConfiguration(value: unknown): value is RuntimeProviderConfiguration {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.providerId === "string" && typeof body.model === "string" &&
    typeof body.baseUrl === "string" && typeof body.apiKey === "string";
}

function isPromptTemplateConfig(value: unknown): value is PromptTemplateConfig {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.activeTemplateId === "string" && Array.isArray(body.templates);
}

function isNotationProfileConfig(value: unknown): value is NotationProfileConfig {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return body.schemaVersion === "nh1-v1" && typeof body.revision === "number" && Array.isArray(body.profiles);
}

function isNotationPreviewInput(value: unknown): value is NotationPreviewInput {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.query === "string" && body.query.length <= 20_000 &&
    (body.profileIds === undefined || (Array.isArray(body.profileIds) && body.profileIds.every((item) => typeof item === "string"))) &&
    (body.maxRules === undefined || typeof body.maxRules === "number") &&
    (body.maxCharacters === undefined || typeof body.maxCharacters === "number");
}

function isNotebookCreateBody(value: unknown): value is { title: string } {
  if (!value || typeof value !== "object") return false;
  return typeof (value as Record<string, unknown>).title === "string";
}

function isSessionCreateBody(value: unknown): value is { notebookId: string; title: string } {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return typeof body.notebookId === "string"
    && body.notebookId.trim().length > 0
    && typeof body.title === "string";
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim();
  if (!value) throw new QueryError(`missing_${name}`);
  return value;
}

function requiredRevision(url: URL, name: string): string {
  const value = requiredQuery(url, name);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new QueryError(`invalid_${name}`);
  return value;
}

function requiredConflictId(url: URL): string {
  const value = requiredQuery(url, "conflictId");
  if (!/^[a-f0-9]{64}$/.test(value)) throw new QueryError("invalid_conflictId");
  return value;
}

function optionalNonNegativeInteger(url: URL, name: string): number {
  const raw = url.searchParams.get(name)?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new QueryError(`invalid_${name}`);
  return value;
}
