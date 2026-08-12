/**
 * MathNotes standalone recognition gateway — Cloudflare Worker.
 *
 * Serves the PWA static build through the ASSETS binding and exposes the
 * standalone recognition contract on the same HTTPS origin:
 *
 *   GET     /v1/capabilities
 *   OPTIONS /v1/recognitions
 *   POST    /v1/recognitions
 *
 * Every other request is delegated to env.ASSETS.fetch(request).
 *
 * Fail-closed rules implemented here:
 * - HTTPS only in production; HTTP is accepted only on loopback hosts.
 * - Recognition requests require an exact same-origin check, bearer auth,
 *   JSON content type, bounded body/image sizes and a valid idempotency key.
 * - Every API response is no-store.
 * - The optional Cloudflare rate-limit binding is consumed when present.
 * - Provider calls have a bounded timeout; upstream failures are generic.
 * - No request body, image, token or API key is ever logged.
 */

const GATEWAY_ID = "mathnotes-standalone-v1";
const CAPABILITIES_PATH = "/v1/capabilities";
const RECOGNITIONS_PATH = "/v1/recognitions";

export const LIMITS = Object.freeze({
  maxBodyBytes: 20 * 1024 * 1024,
  maxImageBytes: 12 * 1024 * 1024,
  maxSessionIdLength: 256,
  maxFileNameLength: 512,
  maxMimeTypeLength: 128,
  maxMarkdownChars: 1_000_000,
  idempotencyKeyPattern: "^[A-Za-z0-9._:-]{8,128}$",
  providerTimeoutMs: 60_000
});

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MEDIA_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const DATA_IMAGE_URL_RE = /^data:image\/[A-Za-z0-9.+-]+(?:;[A-Za-z0-9.+=]+)*;base64$/i;
const RECOGNITION_FIELDS = ["version", "sessionId", "fileName", "mimeType", "imageDataUrl"];

// Same faithful transcription contract used by the standalone Android slice.
const FAITHFUL_PROMPT = [
  "你将看到数学板书、手写笔记或书页照片。请忠实转写为 Markdown。",
  "不要总结、润色、改写或补充证明；保持原始顺序、编号、换行和推导布局。",
  "行内公式使用 $...$，独立公式使用 $$...$$。",
  "看不清处写 [看不清]，不确定符号写 [不确定：...]。",
  "只输出 Markdown 草稿，不要输出解释或包住整篇的代码围栏。"
].join("\n");

const JSON_RESPONSE_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff"
});

export function createStandaloneGatewayHandler(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const providerTimeoutMs = options.providerTimeoutMs ?? LIMITS.providerTimeoutMs;
  const maxBodyBytes = options.maxBodyBytes ?? LIMITS.maxBodyBytes;
  const maxImageBytes = options.maxImageBytes ?? LIMITS.maxImageBytes;
  const maxMarkdownChars = options.maxMarkdownChars ?? LIMITS.maxMarkdownChars;

  return async function standaloneGatewayFetch(request, env) {
    const url = new URL(request.url);
    if (!isProductionSchemeAllowed(url)) {
      return jsonResponse(400, { error: "https_required" });
    }

    if (url.pathname === CAPABILITIES_PATH) {
      if (request.method === "GET") return capabilitiesResponse();
      return assetFallback(request, env);
    }

    if (url.pathname === RECOGNITIONS_PATH) {
      if (request.method === "OPTIONS") return preflightResponse(request, url.origin);
      if (request.method === "POST") {
        return handleRecognition(request, env, {
          fetchImpl,
          randomUUID,
          providerTimeoutMs,
          maxBodyBytes,
          maxImageBytes,
          maxMarkdownChars
        });
      }
    }

    return assetFallback(request, env);
  };
}

export default { fetch: createStandaloneGatewayHandler() };

function capabilitiesResponse() {
  return jsonResponse(200, {
    schemaVersion: 1,
    gateway: GATEWAY_ID,
    recognitions: {
      endpoint: RECOGNITIONS_PATH,
      methods: ["POST", "OPTIONS"],
      protocolVersion: 1,
      auth: "bearer",
      limits: {
        maxBodyBytes: LIMITS.maxBodyBytes,
        maxImageBytes: LIMITS.maxImageBytes,
        maxSessionIdLength: LIMITS.maxSessionIdLength,
        maxFileNameLength: LIMITS.maxFileNameLength
      }
    }
  });
}

function preflightResponse(request, expectedOrigin) {
  const originError = checkOrigin(request, expectedOrigin);
  if (originError) return originError;
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": expectedOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "no-store",
      Vary: "Origin"
    }
  });
}

async function handleRecognition(request, env, deps) {
  const originError = checkOrigin(request, new URL(request.url).origin);
  if (originError) return originError;

  const gatewayToken = env.MATHNOTES_GATEWAY_TOKEN;
  if (!gatewayToken) return jsonResponse(503, { error: "gateway_not_configured" });
  if (!constantTimeEqual(authorizationValue(request), `Bearer ${gatewayToken}`)) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
  if (!idempotencyKey) return jsonResponse(400, { error: "idempotency_key_required" });
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) return jsonResponse(400, { error: "invalid_idempotency_key" });

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return jsonResponse(400, { error: "unsupported_content_type" });
  }

  let body;
  try {
    body = await readJsonBody(request, deps.maxBodyBytes);
  } catch (error) {
    if (error?.code === "BODY_TOO_LARGE") return jsonResponse(413, { error: "body_too_large" });
    return jsonResponse(400, { error: "invalid_json" });
  }

  const validation = validateRecognitionPayload(body, deps.maxImageBytes);
  if (validation.error) {
    return jsonResponse(validation.status ?? 400, { error: validation.error });
  }

  if (env.MATHNOTES_RATE_LIMITER) {
    const key = `recognitions:${await sha256Hex(gatewayToken)}`;
    try {
      const outcome = await env.MATHNOTES_RATE_LIMITER.limit({ key });
      if (!outcome?.success) return jsonResponse(429, { error: "rate_limited" });
    } catch {
      return jsonResponse(503, { error: "rate_limiter_unavailable" });
    }
  }

  try {
    const markdown = await transcribeImage(validation.payload, env, deps);
    return jsonResponse(200, {
      taskId: deps.randomUUID(),
      status: "succeeded",
      markdown
    });
  } catch (error) {
    return upstreamFailure(error);
  }
}

async function transcribeImage(payload, env, deps) {
  const baseUrl = env.MATHNOTES_PROVIDER_BASE_URL;
  const model = env.MATHNOTES_PROVIDER_MODEL;
  const apiKey = env.MATHNOTES_PROVIDER_API_KEY;
  if (!baseUrl || !model || !apiKey) throw configError();

  let endpoint;
  try {
    endpoint = chatCompletionsUrl(baseUrl);
    const endpointUrl = new URL(endpoint);
    if (endpointUrl.protocol !== "https:" && !(endpointUrl.protocol === "http:" && isLoopbackHost(endpointUrl.hostname))) {
      throw configError();
    }
  } catch (error) {
    if (error?.code === "upstream_config") throw error;
    throw configError();
  }

  const response = await deps.fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: FAITHFUL_PROMPT },
            { type: "image_url", image_url: { url: payload.imageDataUrl } }
          ]
        }
      ]
    }),
    signal: AbortSignal.timeout(deps.providerTimeoutMs)
  });

  if (!response.ok) throw upstreamError();
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw upstreamError();
  }

  const markdown = extractChoiceText(parsed);
  if (!markdown) throw upstreamEmptyError();
  if (markdown.length > deps.maxMarkdownChars) throw upstreamTooLargeError();
  return markdown;
}

function validateRecognitionPayload(value, maxImageBytes) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "invalid_request" };
  }
  const keys = Object.keys(value).sort();
  const expected = [...RECOGNITION_FIELDS].sort();
  if (keys.length !== expected.length || expected.some((field, index) => field !== keys[index])) {
    return { error: "invalid_request" };
  }
  if (value.version !== 1) return { error: "invalid_request" };
  if (!isBoundedString(value.sessionId, 1, LIMITS.maxSessionIdLength)) return { error: "invalid_request" };
  if (!isBoundedString(value.fileName, 1, LIMITS.maxFileNameLength)) return { error: "invalid_request" };
  if (!isBoundedString(value.mimeType, 1, LIMITS.maxMimeTypeLength) || !MEDIA_TYPE_RE.test(value.mimeType)) {
    return { error: "invalid_request" };
  }

  const image = decodeImageDataUrl(value.imageDataUrl);
  if (!image) return { error: "invalid_image" };
  if (image.mimeType !== value.mimeType.toLowerCase()) return { error: "invalid_image" };
  if (image.bytes > maxImageBytes) return { error: "image_too_large", status: 413 };
  return { payload: value };
}

function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return undefined;
  const comma = dataUrl.indexOf(",");
  if (comma <= 0) return undefined;
  const meta = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  if (!DATA_IMAGE_URL_RE.test(meta) || base64.length === 0) return undefined;
  try {
    return {
      bytes: atob(base64).length,
      mimeType: meta.slice(5, meta.indexOf(";")).toLowerCase()
    };
  } catch {
    return undefined;
  }
}

function extractChoiceText(parsed) {
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item?.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  return "";
}

async function readJsonBody(request, maxBytes) {
  if (!request.body) throw new Error("missing_body");
  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Body already rejected; response is decided by the byte limit.
      }
      throw Object.assign(new Error("body_too_large"), { code: "BODY_TOO_LARGE" });
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl).trim().replace(/\/+$/, "");
  if (!trimmed) throw configError();
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

async function assetFallback(request, env) {
  if (!env.ASSETS?.fetch) return jsonResponse(500, { error: "assets_unavailable" });
  return env.ASSETS.fetch(request);
}

function checkOrigin(request, expectedOrigin) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== expectedOrigin) {
    return jsonResponse(403, { error: "origin_not_allowed" });
  }
  return undefined;
}

function upstreamFailure(error) {
  if (error?.code === "upstream_config") return jsonResponse(503, { error: "gateway_not_configured" });
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return jsonResponse(504, { error: "upstream_timeout" });
  }
  const code = error?.code === "upstream_empty"
    ? "upstream_empty"
    : error?.code === "upstream_too_large"
      ? "upstream_too_large"
      : "upstream_error";
  return jsonResponse(502, { error: code });
}

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_RESPONSE_HEADERS, ...extraHeaders }
  });
}

function isProductionSchemeAllowed(url) {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function authorizationValue(request) {
  return request.headers.get("Authorization") ?? "";
}

function isBoundedString(value, min, max) {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function configError() {
  return Object.assign(new Error("gateway_not_configured"), { code: "upstream_config" });
}

function upstreamError() {
  return Object.assign(new Error("upstream_error"), { code: "upstream_error" });
}

function upstreamEmptyError() {
  return Object.assign(new Error("upstream_empty"), { code: "upstream_empty" });
}

function upstreamTooLargeError() {
  return Object.assign(new Error("upstream_too_large"), { code: "upstream_too_large" });
}
