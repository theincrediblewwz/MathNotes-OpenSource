// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { normalizeGatewayUrl, recognizeViaGateway } from "./standaloneGatewayClient";

describe("standalone recognition gateway client", () => {
  it("keeps the token in the authorization header and sends an idempotency key", async () => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: () => "request-1" });
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer temporary-secret");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("request-1");
      expect(String(init?.body)).not.toContain("temporary-secret");
      return new Response(JSON.stringify({ taskId: "task-1", status: "succeeded", markdown: "# 草稿" }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    });
    const result = await recognizeViaGateway({
      gatewayUrl: "https://gateway.example/", token: "temporary-secret", sessionId: "session",
      asset: new Blob(["image"], { type: "image/jpeg" }), fileName: "page.jpg", fetchImpl: fetchImpl as typeof fetch
    });
    expect(result.markdown).toBe("# 草稿");
  });

  it("rejects cleartext non-loopback gateways", () => {
    expect(() => normalizeGatewayUrl("http://gateway.example")).toThrow(/HTTPS/);
    expect(normalizeGatewayUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });
});
