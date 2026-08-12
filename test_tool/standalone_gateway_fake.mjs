import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";

export function createStandaloneGatewayFake(options = {}) {
  const token = options.token ?? "mathnotes-local-fake-token";
  const allowedOrigin = options.allowedOrigin ?? "http://127.0.0.1:4174";
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  return http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && origin !== allowedOrigin) return json(response, 403, { error: "origin_not_allowed" });
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/recognitions") return json(response, 404, { error: "not_found" });
    if (!constantTimeEqual(request.headers.authorization ?? "", `Bearer ${token}`)) return json(response, 401, { error: "unauthorized" });
    if (!request.headers["idempotency-key"]) return json(response, 400, { error: "idempotency_key_required" });
    try {
      const body = await readJson(request, maxBytes);
      if (body.version !== 1 || typeof body.sessionId !== "string" || !String(body.imageDataUrl).startsWith("data:image/")) {
        return json(response, 400, { error: "invalid_request" });
      }
      const fingerprint = createHash("sha256").update(body.imageDataUrl).digest("hex").slice(0, 12);
      return json(response, 200, {
        taskId: randomUUID(), status: "succeeded",
        markdown: `## Gateway 假识别草稿\n\n已接收图片 ${body.fileName || fingerprint}（${fingerprint}）。未调用任何真实 Provider。`
      });
    } catch (error) {
      return json(response, error?.code === "BODY_TOO_LARGE" ? 413 : 400, { error: error?.message ?? "invalid_json" });
    }
  });
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request, maxBytes) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error("body_too_large"), { code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MATHNOTES_GATEWAY_PORT ?? 8787);
  const server = createStandaloneGatewayFake({
    token: process.env.MATHNOTES_GATEWAY_TOKEN,
    allowedOrigin: process.env.MATHNOTES_PWA_ORIGIN
  });
  server.listen(port, "127.0.0.1", () => console.log(`MATHNOTES_GATEWAY_FAKE=http://127.0.0.1:${port}`));
}
