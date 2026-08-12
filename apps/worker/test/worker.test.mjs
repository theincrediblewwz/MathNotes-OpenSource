import assert from "node:assert/strict";
import test from "node:test";
import { createStandaloneGatewayHandler, LIMITS } from "../src/index.js";

const GATEWAY_ORIGIN = "http://127.0.0.1:8787";
const GATEWAY_TOKEN = "fixture-gateway-token";
const PROVIDER_KEY = "fixture-provider-key";
const IMAGE_DATA_URL = "data:image/jpeg;base64," + Buffer.from("fake-jpeg-bytes").toString("base64");
const VALID_BODY = JSON.stringify({
  version: 1,
  sessionId: "session-1",
  fileName: "page.jpg",
  mimeType: "image/jpeg",
  imageDataUrl: IMAGE_DATA_URL
});

function request(pathname, init = {}) {
  return new Request(`${GATEWAY_ORIGIN}${pathname}`, init);
}

function recognitionRequest(overrides = {}) {
  const headers = new Headers({
    Origin: GATEWAY_ORIGIN,
    Authorization: `Bearer ${GATEWAY_TOKEN}`,
    "Content-Type": "application/json",
    "Idempotency-Key": "request-0001",
    ...(overrides.headers ?? {})
  });
  for (const name of overrides.removeHeaders ?? []) headers.delete(name);
  return request("/v1/recognitions", {
    method: "POST",
    headers,
    body: overrides.body ?? VALID_BODY
  });
}

function providerResponse(content = "## 草稿\n\n$$x=1$$", extra = {}) {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }]
  }), { status: 200, headers: { "Content-Type": "application/json" }, ...extra });
}

function providerMock(options = {}) {
  const calls = [];
  const impl = options.fetchImpl ?? (async (_url, _init) => providerResponse());
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return impl(url, init);
    }
  };
}

function makeHandler(options = {}) {
  return createStandaloneGatewayHandler({
    randomUUID: () => "task-0000",
    ...options
  });
}

function baseEnv(overrides = {}) {
  return {
    ASSETS: {
      fetch: async (assetRequest) => new Response(`asset:${new URL(assetRequest.url).pathname}`, { status: 200 })
    },
    MATHNOTES_GATEWAY_TOKEN: GATEWAY_TOKEN,
    MATHNOTES_PROVIDER_BASE_URL: "https://provider.test/v1",
    MATHNOTES_PROVIDER_MODEL: "fixture-vision",
    MATHNOTES_PROVIDER_API_KEY: PROVIDER_KEY,
    ...overrides
  };
}

test("capabilities require no auth, advertise the same-origin contract and are no-store", async () => {
  const handler = makeHandler();
  const response = await handler(request("/v1/capabilities"), baseEnv());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const payload = await response.json();
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.gateway, "mathnotes-standalone-v1");
  assert.equal(payload.recognitions.endpoint, "/v1/recognitions");
  assert.equal(payload.recognitions.protocolVersion, 1);
  assert.equal(payload.recognitions.auth, "bearer");
  assert.equal(payload.recognitions.limits.maxBodyBytes, LIMITS.maxBodyBytes);
  assert.equal(payload.recognitions.limits.maxImageBytes, LIMITS.maxImageBytes);
});

test("HTTPS production expectation fails closed on non-loopback HTTP", async () => {
  const handler = makeHandler();
  const response = await handler(new Request("http://gateway.example/v1/capabilities"), baseEnv());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "https_required" });
  const loopback = await handler(request("/v1/capabilities"), baseEnv());
  assert.equal(loopback.status, 200);
});

test("recognition requires bearer auth and fails closed when the secret binding is missing", async () => {
  const provider = providerMock();
  const handler = makeHandler({ fetchImpl: provider.fetchImpl });

  const missing = await handler(recognitionRequest({ removeHeaders: ["Authorization"] }), baseEnv());
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: "unauthorized" });

  const wrong = await handler(recognitionRequest({ headers: { Authorization: "Bearer wrong-token" } }), baseEnv());
  assert.equal(wrong.status, 401);

  const unconfigured = await handler(recognitionRequest(), baseEnv({ MATHNOTES_GATEWAY_TOKEN: undefined }));
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(await unconfigured.json(), { error: "gateway_not_configured" });

  const ok = await handler(recognitionRequest(), baseEnv());
  assert.equal(ok.status, 200);
  assert.equal(provider.calls.length, 1);
});

test("recognition enforces exact same-origin CORS and no-store preflight", async () => {
  const handler = makeHandler();
  const denied = await handler(
    recognitionRequest({ headers: { Origin: "https://attacker.example" } }),
    baseEnv()
  );
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "origin_not_allowed" });
  assert.equal(denied.headers.get("Cache-Control"), "no-store");

  const preflight = await handler(request("/v1/recognitions", {
    method: "OPTIONS",
    headers: { Origin: GATEWAY_ORIGIN, "Access-Control-Request-Method": "POST" }
  }), baseEnv());
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), GATEWAY_ORIGIN);
  assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.equal(preflight.headers.get("Access-Control-Allow-Headers"), "Authorization, Content-Type, Idempotency-Key");
  assert.equal(preflight.headers.get("Cache-Control"), "no-store");

  const badPreflight = await handler(request("/v1/recognitions", {
    method: "OPTIONS",
    headers: { Origin: "https://attacker.example" }
  }), baseEnv());
  assert.equal(badPreflight.status, 403);

  const noOrigin = await handler(request("/v1/recognitions", { method: "OPTIONS" }), baseEnv());
  assert.equal(noOrigin.status, 204);
});

test("recognition requires JSON content type", async () => {
  const handler = makeHandler();
  const response = await handler(recognitionRequest({ headers: { "Content-Type": "text/plain" } }), baseEnv());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "unsupported_content_type" });
});

test("recognition validates the idempotency key", async () => {
  const handler = makeHandler();
  const missing = await handler(recognitionRequest({ removeHeaders: ["Idempotency-Key"] }), baseEnv());
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "idempotency_key_required" });

  for (const badKey of ["short", "has space", "x".repeat(129), "bad/key"]) {
    const invalid = await handler(recognitionRequest({ headers: { "Idempotency-Key": badKey } }), baseEnv());
    assert.equal(invalid.status, 400, badKey);
    assert.deepEqual(await invalid.json(), { error: "invalid_idempotency_key" }, badKey);
  }
});

test("recognition rejects invalid JSON and non-conforming payloads", async () => {
  const handler = makeHandler();
  const invalidJson = await handler(recognitionRequest({ body: "{not json" }), baseEnv());
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), { error: "invalid_json" });

  const cases = [
    { ...JSON.parse(VALID_BODY), version: 2 },
    { ...JSON.parse(VALID_BODY), extra: "field" },
    { ...JSON.parse(VALID_BODY), sessionId: "" },
    { ...JSON.parse(VALID_BODY), fileName: "" },
    { ...JSON.parse(VALID_BODY), mimeType: "not-a-media-type" },
    { ...JSON.parse(VALID_BODY), mimeType: "image/png" },
    { ...JSON.parse(VALID_BODY), imageDataUrl: "data:image/jpeg;base64,%%%" }
  ];
  for (const body of cases) {
    const response = await handler(recognitionRequest({ body: JSON.stringify(body) }), baseEnv());
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test("recognition enforces bounded body and image sizes", async () => {
  const handler = makeHandler({ maxBodyBytes: 1024, maxImageBytes: 64 });
  const bodyTooLarge = await handler(recognitionRequest({ body: "x".repeat(2048) }), baseEnv());
  assert.equal(bodyTooLarge.status, 413);
  assert.deepEqual(await bodyTooLarge.json(), { error: "body_too_large" });

  const hugeImage = "data:image/jpeg;base64," + Buffer.alloc(128, 1).toString("base64");
  const imageTooLarge = await handler(
    recognitionRequest({ body: JSON.stringify({ ...JSON.parse(VALID_BODY), imageDataUrl: hugeImage }) }),
    baseEnv()
  );
  assert.equal(imageTooLarge.status, 413);
  assert.deepEqual(await imageTooLarge.json(), { error: "image_too_large" });
});

test("provider projection sends only the allowlisted OpenAI-compatible payload", async () => {
  const provider = providerMock();
  const handler = makeHandler({ fetchImpl: provider.fetchImpl });
  const response = await handler(recognitionRequest(), baseEnv());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    taskId: "task-0000",
    status: "succeeded",
    markdown: "## 草稿\n\n$$x=1$$"
  });

  assert.equal(provider.calls.length, 1);
  const { url, init } = provider.calls[0];
  assert.equal(url, "https://provider.test/v1/chat/completions");
  assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${PROVIDER_KEY}`);
  assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
  assert.ok(init.signal instanceof AbortSignal);

  const sent = JSON.parse(init.body);
  assert.equal(sent.model, "fixture-vision");
  assert.equal(sent.stream, false);
  assert.equal(sent.messages.length, 1);
  assert.equal(sent.messages[0].role, "user");
  assert.equal(sent.messages[0].content[0].type, "text");
  assert.match(sent.messages[0].content[0].text, /忠实转写为 Markdown/);
  assert.equal(sent.messages[0].content[1].type, "image_url");
  assert.equal(sent.messages[0].content[1].image_url.url, IMAGE_DATA_URL);
  assert.equal(Object.keys(sent).sort().join(","), "messages,model,stream");
  const serialized = JSON.stringify(sent);
  assert.ok(!serialized.includes(GATEWAY_TOKEN));
  assert.ok(!serialized.includes("session-1"));
  assert.ok(!serialized.includes("page.jpg"));
  assert.ok(!serialized.includes("request-0001"));
});

test("provider content arrays are joined like the desktop transport", async () => {
  const provider = providerMock({
    fetchImpl: async () => providerResponse([
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" }
    ])
  });
  const handler = makeHandler({ fetchImpl: provider.fetchImpl });
  const response = await handler(recognitionRequest(), baseEnv());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).markdown, "第一段\n\n第二段");
});

test("provider failures map to generic errors without leaking details", async () => {
  const cases = [
    { name: "http status", fetchImpl: async () => new Response("denied", { status: 429 }), expected: "upstream_error" },
    { name: "invalid json", fetchImpl: async () => new Response("<html>", { status: 200 }), expected: "upstream_error" },
    { name: "empty content", fetchImpl: async () => providerResponse("   "), expected: "upstream_empty" },
    { name: "network error", fetchImpl: async () => { throw new Error("socket hang up"); }, expected: "upstream_error" }
  ];
  for (const fixture of cases) {
    const handler = makeHandler({ fetchImpl: fixture.fetchImpl });
    const response = await handler(recognitionRequest(), baseEnv());
    assert.equal(response.status, 502, fixture.name);
    assert.deepEqual(await response.json(), { error: fixture.expected }, fixture.name);
  }
});

test("provider timeouts are bounded and return 504", async () => {
  const hangingFetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      reject(new DOMException("timed out", "TimeoutError"));
    }, { once: true });
  });
  const handler = makeHandler({ fetchImpl: hangingFetch, providerTimeoutMs: 15 });
  const response = await handler(recognitionRequest(), baseEnv());
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "upstream_timeout" });
});

test("oversized provider markdown is rejected", async () => {
  const provider = providerMock({ fetchImpl: async () => providerResponse("x".repeat(2000)) });
  const handler = makeHandler({ fetchImpl: provider.fetchImpl, maxMarkdownChars: 100 });
  const response = await handler(recognitionRequest(), baseEnv());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "upstream_too_large" });
});

test("missing provider bindings fail closed with 503 before any request", async () => {
  let called = false;
  const handler = makeHandler({
    fetchImpl: async () => { called = true; return providerResponse(); }
  });
  const response = await handler(
    recognitionRequest(),
    baseEnv({ MATHNOTES_PROVIDER_BASE_URL: undefined, MATHNOTES_PROVIDER_MODEL: undefined, MATHNOTES_PROVIDER_API_KEY: undefined })
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "gateway_not_configured" });
  assert.equal(called, false);
});

test("optional rate-limit binding is consumed with a token-derived key", async () => {
  const calls = [];
  const provider = providerMock();
  const rateLimiter = { limit: async (input) => { calls.push(input); return { success: false }; } };
  const handler = makeHandler({ fetchImpl: provider.fetchImpl });
  const denied = await handler(recognitionRequest(), baseEnv({ MATHNOTES_RATE_LIMITER: rateLimiter }));
  assert.equal(denied.status, 429);
  assert.deepEqual(await denied.json(), { error: "rate_limited" });
  assert.match(calls[0].key, /^recognitions:[0-9a-f]{64}$/);
  assert.ok(!calls[0].key.includes(GATEWAY_TOKEN));

  rateLimiter.limit = async () => ({ success: true });
  const allowed = await handler(recognitionRequest(), baseEnv({ MATHNOTES_RATE_LIMITER: rateLimiter }));
  assert.equal(allowed.status, 200);
});

test("rate limiter failures fail closed with 503", async () => {
  const handler = makeHandler({ fetchImpl: providerMock().fetchImpl });
  const broken = { limit: async () => { throw new Error("binding failure"); } };
  const response = await handler(recognitionRequest(), baseEnv({ MATHNOTES_RATE_LIMITER: broken }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "rate_limiter_unavailable" });
});

test("all non-gateway requests are delegated to the ASSETS binding", async () => {
  const assetCalls = [];
  const assets = {
    fetch: async (assetRequest) => {
      assetCalls.push(assetRequest);
      return new Response(`asset:${new URL(assetRequest.url).pathname}`, {
        status: 201,
        headers: { "X-Asset": "yes" }
      });
    }
  };
  const handler = makeHandler();

  const cases = [
    { path: "/", method: "POST" },
    { path: "/index.html", method: "POST" },
    { path: "/v1/recognitions", method: "GET" },
    { path: "/v1/capabilities", method: "POST" },
    { path: "/v1/unknown", method: "POST" }
  ];
  for (const fixture of cases) {
    const response = await handler(request(fixture.path, { method: fixture.method }), baseEnv({ ASSETS: assets }));
    assert.equal(response.status, 201, fixture.path);
    assert.equal(response.headers.get("X-Asset"), "yes", fixture.path);
    assert.equal(await response.text(), `asset:${fixture.path}`, fixture.path);
  }
  assert.equal(assetCalls.length, 5);

  const missingAssets = await handler(request("/"), baseEnv({ ASSETS: undefined }));
  assert.equal(missingAssets.status, 500);
  assert.deepEqual(await missingAssets.json(), { error: "assets_unavailable" });
});

test("error responses are no-store and never expose request details", async () => {
  const handler = makeHandler();
  const response = await handler(recognitionRequest({ headers: { Authorization: "Bearer wrong" } }), baseEnv());
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const text = await response.text();
  assert.ok(!text.includes(GATEWAY_TOKEN));
  assert.ok(!text.includes("session-1"));
  assert.ok(!text.includes("page.jpg"));
});
