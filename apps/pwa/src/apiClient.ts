import type {
  CompanionCatalog,
  CompanionHostCapabilities,
  DeviceCredential,
  PairingTarget,
  SessionManifest,
  UploadTask
} from "./domain";
import type { PairingRequest } from "./pairing";
import { parseSseStream, type SseMessage } from "./sse";

type FetchLike = typeof fetch;

export class CompanionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "CompanionApiError";
  }
}

export class NotModifiedError extends Error {
  constructor() {
    super("Session has not changed");
    this.name = "NotModifiedError";
  }
}

export class CompanionApiClient {
  constructor(
    private readonly origin: string,
    private readonly request: FetchLike = (...arguments_) => globalThis.fetch(...arguments_),
    private readonly requestTimeoutMs = 20_000
  ) {}

  async exchangePairing(input: PairingRequest, deviceLabel: string): Promise<DeviceCredential> {
    const response = await this.request(this.url("/api/v2/pairing/exchange"), {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify({
        ...(input.challengeId ? { challengeId: input.challengeId } : {}),
        userCode: input.userCode,
        deviceLabel
      })
    });
    const body = await readJson(response);
    if (!response.ok) throw apiError(response, body);
    const token = stringValue(body.token);
    const device = objectValue(body.device);
    const deviceId = stringValue(device.deviceId);
    const label = stringValue(device.label) || deviceLabel;
    if (!token || !deviceId) throw new CompanionApiError("电脑返回的配对凭据不完整。", 502, "invalid_pairing_response");
    return {
      id: "active",
      version: 1,
      origin: new URL(this.origin).origin,
      token,
      deviceId,
      deviceLabel: label,
      verifiedAt: new Date().toISOString()
    };
  }

  async verify(token: string): Promise<CompanionCatalog> {
    const response = await this.authorized("/api/v1/pairing/verify", token, undefined, "目录检查");
    const body = await readJson(response);
    if (!response.ok) throw apiError(response, body);
    if (body.ok !== true || Number(body.version) !== 1) {
      throw new CompanionApiError("电脑返回的笔记目录版本不兼容。", 502, "invalid_catalog");
    }
    const targets = Array.isArray(body.targets)
      ? body.targets.map(parseTarget).filter((target): target is PairingTarget => Boolean(target))
      : [];
    return {
      activeTarget: parseTarget(body.activeTarget),
      targets,
      capabilities: parseHostCapabilities(body.capabilities)
    };
  }

  async fetchManifest(
    token: string,
    target: PairingTarget,
    knownRevision?: string
  ): Promise<SessionManifest> {
    const response = await this.authorized(
      `/api/v2/companion/session/manifest?${targetQuery(target)}`,
      token,
      knownRevision ? { "if-none-match": revisionEtag(knownRevision) } : undefined,
      "修订检查"
    );
    if (response.status === 304) throw new NotModifiedError();
    const body = await readJson(response);
    if (!response.ok) throw apiError(response, body);
    return parseManifest(body);
  }

  async fetchDocument(
    token: string,
    target: PairingTarget,
    format: "markdown" | "html"
  ): Promise<{ text: string; revision: string }> {
    const response = await this.authorized(
      `/api/v2/companion/session/document?${targetQuery(target)}&format=${format}`,
      token,
      { "accept": format === "markdown" ? "text/markdown" : "text/html" },
      format === "markdown" ? "Markdown 正文读取" : "阅读预览生成"
    );
    if (!response.ok) throw apiError(response);
    const revision = response.headers.get("x-mathnotes-revision") ?? "";
    return { text: await response.text(), revision };
  }

  async fetchAsset(token: string, target: PairingTarget, path: string): Promise<Blob> {
    const params = `${targetQuery(target)}&path=${encodeURIComponent(path)}`;
    const response = await this.authorized(`/api/v1/companion/asset?${params}`, token, undefined, "图片素材读取");
    if (!response.ok) throw apiError(response);
    return response.blob();
  }

  async uploadMaterial(
    token: string,
    deviceId: string,
    task: UploadTask,
    signal?: AbortSignal
  ): Promise<UploadMaterialResult> {
    if (!task.bytes) {
      throw new CompanionApiError("本地素材内容已经不存在，无法上传。", 0, "missing_upload_bytes");
    }
    const body = new FormData();
    body.set("notebookId", task.notebookId);
    body.set("sessionId", task.sessionId);
    body.set("materialType", task.kind);
    body.set("sourceName", task.fileName);
    body.set("captureId", task.id);
    body.set("deviceId", deviceId);
    body.set("createdAt", task.createdAt);
    body.set("byteLength", String(task.byteLength));
    body.set("material", task.bytes, task.fileName);
    const response = await this.request(this.url("/api/v1/uploads"), {
      method: "POST",
      cache: "no-store",
      headers: {
        "authorization": `Bearer ${token}`,
        "accept": "application/json"
      },
      body,
      signal
    });
    const payload = await readJson(response);
    if (!response.ok) throw apiError(response, payload);
    const uploadId = stringValue(payload.uploadId);
    if (!uploadId) {
      throw new CompanionApiError("电脑没有返回上传编号，请稍后重试。", 502, "invalid_upload_response");
    }
    return parseUploadMaterialResult(payload, uploadId);
  }

  async fetchUploadStatus(token: string, uploadId: string): Promise<UploadMaterialResult> {
    const response = await this.authorized(
      `/api/v1/uploads/status?uploadId=${encodeURIComponent(uploadId)}`,
      token,
      undefined,
      "识别状态检查"
    );
    const payload = await readJson(response);
    if (!response.ok) throw apiError(response, payload);
    const returnedId = stringValue(payload.uploadId);
    if (!returnedId) {
      throw new CompanionApiError("电脑没有返回上传状态。", 502, "invalid_upload_status");
    }
    return parseUploadMaterialResult(payload, returnedId);
  }

  async retryRecognition(token: string, uploadId: string): Promise<UploadMaterialResult> {
    const response = await this.request(this.url("/api/v1/uploads/retry-recognition"), {
      method: "POST",
      cache: "no-store",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify({ uploadId })
    });
    const payload = await readJson(response);
    if (!response.ok) throw apiError(response, payload);
    const returnedId = stringValue(payload.uploadId);
    if (!returnedId) {
      throw new CompanionApiError("电脑没有返回重试状态。", 502, "invalid_upload_retry");
    }
    return parseUploadMaterialResult(payload, returnedId);
  }

  async stream(
    path: string,
    token: string,
    options: {
      signal: AbortSignal;
      lastEventId?: string;
      onOpen?: () => void;
      onMessage: (message: SseMessage) => void;
    }
  ): Promise<void> {
    const headers: Record<string, string> = {
      "authorization": `Bearer ${token}`,
      "accept": "text/event-stream"
    };
    if (options.lastEventId) headers["last-event-id"] = options.lastEventId;
    const response = await this.request(this.url(path), {
      method: "GET",
      cache: "no-store",
      headers,
      signal: options.signal
    });
    if (!response.ok) throw apiError(response);
    if (!response.body) throw new CompanionApiError("实时同步通道没有返回内容。", 502, "missing_stream");
    options.onOpen?.();
    await parseSseStream(response.body, options.onMessage, options.signal);
  }

  private async authorized(
    path: string,
    token: string,
    extraHeaders?: Record<string, string>,
    stage = "电脑请求"
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.request(this.url(path), {
        method: "GET",
        cache: "no-store",
        headers: {
          "authorization": `Bearer ${token}`,
          ...extraHeaders
        },
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CompanionApiError(
          `${stage}超过 ${Math.ceil(this.requestTimeoutMs / 1_000)} 秒仍未完成，请确认电脑端 MathNotes 正在运行后重试。`,
          0,
          "request_timeout"
        );
      }
      throw error;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  private url(path: string): string {
    return new URL(path, this.origin).toString();
  }
}

export type UploadMaterialResult = Readonly<{
  uploadId: string;
  duplicate: boolean;
  assetPath?: string;
  imageBlockId?: string;
  transcriptBlockId?: string;
  recognitionJobId?: string;
  recognitionStatus?: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  recognitionWarnings?: readonly string[];
}>;

const DEFAULT_HOST_CAPABILITIES: CompanionHostCapabilities = {
  imageUpload: true,
  pdfUpload: false,
  recognitionStatus: false,
  recognitionRetry: false
};

function parseHostCapabilities(input: unknown): CompanionHostCapabilities {
  const value = objectValue(input);
  const upload = objectValue(value.upload);
  const recognition = objectValue(value.recognition);
  if (Object.keys(value).length === 0) return DEFAULT_HOST_CAPABILITIES;
  return {
    imageUpload: upload.image === true,
    pdfUpload: upload.pdf === true,
    recognitionStatus: recognition.status === true,
    recognitionRetry: recognition.retry === true
  };
}

function parseUploadMaterialResult(
  payload: Record<string, unknown>,
  uploadId: string
): UploadMaterialResult {
  const recognitionStatus = stringValue(payload.recognitionStatus);
  const acceptedRecognitionStatus = [
    "pending",
    "running",
    "succeeded",
    "failed",
    "cancelled"
  ].includes(recognitionStatus)
    ? recognitionStatus as UploadMaterialResult["recognitionStatus"]
    : undefined;
  return {
    uploadId,
    duplicate: payload.duplicate === true,
    assetPath: stringValue(payload.assetPath) || undefined,
    imageBlockId: stringValue(payload.imageBlockId) || undefined,
    transcriptBlockId: stringValue(payload.transcriptBlockId) || undefined,
    recognitionJobId: stringValue(payload.recognitionJobId) || undefined,
    recognitionStatus: acceptedRecognitionStatus,
    recognitionWarnings: Array.isArray(payload.warnings)
      ? payload.warnings.filter((warning): warning is string => typeof warning === "string")
      : undefined
  };
}

function parseTarget(input: unknown): PairingTarget | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  const notebookId = stringValue(value.notebookId);
  const sessionId = stringValue(value.sessionId);
  if (!notebookId || !sessionId) return null;
  return {
    notebookId,
    notebookTitle: stringValue(value.notebookTitle) || notebookId,
    sessionId,
    title: stringValue(value.title) || sessionId
  };
}

function parseManifest(body: Record<string, unknown>): SessionManifest {
  const assets = Array.isArray(body.assets)
    ? body.assets.map((asset) => {
        const value = objectValue(asset);
        return {
          id: stringValue(value.id),
          path: stringValue(value.path),
          mimeType: stringValue(value.mimeType)
        };
      }).filter((asset) => asset.id && asset.path && asset.mimeType)
    : [];
  const manifest: SessionManifest = {
    version: Number(body.version) as 2,
    notebookId: stringValue(body.notebookId),
    sessionId: stringValue(body.sessionId),
    title: stringValue(body.title),
    revision: stringValue(body.revision),
    updatedAt: stringValue(body.updatedAt),
    blockCount: numberValue(body.blockCount),
    markdownBytes: numberValue(body.markdownBytes),
    htmlBytes: numberValue(body.htmlBytes),
    assets
  };
  if (
    manifest.version !== 2 ||
    !manifest.notebookId ||
    !manifest.sessionId ||
    !manifest.revision ||
    !manifest.updatedAt ||
    !Number.isSafeInteger(manifest.markdownBytes) ||
    !Number.isSafeInteger(manifest.htmlBytes)
  ) {
    throw new CompanionApiError("电脑返回的同步清单不完整。", 502, "invalid_manifest");
  }
  return manifest;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return objectValue(await response.json());
  } catch {
    return {};
  }
}

function apiError(response: Response, body: Record<string, unknown> = {}): CompanionApiError {
  const code = stringValue(body.error) || `http_${response.status}`;
  const pairingMessages: Readonly<Record<string, string>> = {
    challenge_not_found: "电脑端没有可用的配对码，请重新生成。",
    challenge_expired: "这组配对码已经过期，请在电脑端刷新。",
    challenge_consumed: "这组配对码已经使用过，请在电脑端刷新。",
    pairing_code_invalid: "配对码不正确，请检查后重试。",
    pairing_attempts_exhausted: "配对尝试次数已用完，请在电脑端重新生成。",
    device_pairing_unavailable: "电脑端的设备连接服务尚未准备好，请稍后重试。",
    revision_changed: "笔记刚刚发生变化，正在重新读取。",
    target_not_found: "这篇笔记已移动或删除，请返回目录重新选择。",
    companion_snapshot_failed: "电脑端读取这篇笔记时出错，请在电脑端确认笔记仍可打开。",
    invalid_target: "这篇笔记的地址无效，请返回目录重新选择。",
    document_truncated: "笔记正文传输不完整，请重试。"
  };
  const message = pairingMessages[code] ?? (response.status === 401
    ? "配对凭据已失效，请重新配对。"
    : response.status === 403
      ? "当前设备没有读取笔记的权限。"
      : response.status >= 500
        ? "电脑端暂时无法提供笔记，请稍后重试。"
        : "请求没有完成，请重试。");
  return new CompanionApiError(message, response.status, code);
}

function objectValue(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function stringValue(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function numberValue(input: unknown): number {
  return typeof input === "number" ? input : Number.NaN;
}

function targetQuery(target: PairingTarget): string {
  return `notebookId=${encodeURIComponent(target.notebookId)}&sessionId=${encodeURIComponent(target.sessionId)}`;
}

function revisionEtag(revision: string): string {
  const bytes = new TextEncoder().encode(revision);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `"${base64url}"`;
}
