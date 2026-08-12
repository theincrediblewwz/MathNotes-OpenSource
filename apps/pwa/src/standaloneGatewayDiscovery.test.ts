import { describe, expect, it, vi } from "vitest";
import {
  discoverSameOriginGateway,
  isValidSameOriginGatewayCapabilities
} from "./standaloneGatewayDiscovery";

const VALID_PAYLOAD = {
  schemaVersion: 1,
  gateway: "mathnotes-standalone-v1",
  recognitions: {
    endpoint: "/v1/recognitions",
    protocolVersion: 1,
    auth: "bearer"
  }
};

function gatewayResponse(payload: unknown, options: { ok?: boolean; url?: string; badJson?: boolean } = {}) {
  const response = new Response(JSON.stringify(payload), {
    status: (options.ok ?? true) ? 200 : 404,
    headers: { "Content-Type": "application/json" }
  });
  Object.defineProperty(response, "url", {
    value: options.url ?? "https://notes.example/v1/capabilities"
  });
  if (options.badJson) {
    Object.defineProperty(response, "json", {
      value: async () => { throw new SyntaxError("Unexpected token"); }
    });
  }
  return response;
}

describe("same-origin standalone gateway discovery", () => {
  it("auto-fills the origin only for a valid capability response", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => gatewayResponse(VALID_PAYLOAD));
    const discovered = await discoverSameOriginGateway({
      origin: "https://notes.example/",
      fetchImpl: fetchImpl as typeof fetch
    });
    expect(discovered).toBe("https://notes.example");
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://notes.example/v1/capabilities");
  });

  it("keeps local-fake behavior when the host returns 404", async () => {
    const fetchImpl = vi.fn(async () => gatewayResponse(undefined, { ok: false }));
    expect(await discoverSameOriginGateway({ origin: "https://notes.example", fetchImpl: fetchImpl as typeof fetch }))
      .toBeUndefined();
  });

  it("rejects capability responses redirected to another origin", async () => {
    const fetchImpl = vi.fn(async () => gatewayResponse(VALID_PAYLOAD, { url: "https://attacker.example/v1/capabilities" }));
    expect(await discoverSameOriginGateway({ origin: "https://notes.example", fetchImpl: fetchImpl as typeof fetch }))
      .toBeUndefined();
  });

  it("rejects malformed or non-JSON payloads", async () => {
    const malformed = [
      { ...VALID_PAYLOAD, schemaVersion: 2 },
      { ...VALID_PAYLOAD, gateway: "other-gateway" },
      { ...VALID_PAYLOAD, recognitions: { ...VALID_PAYLOAD.recognitions, endpoint: "/v2/recognitions" } },
      { ...VALID_PAYLOAD, recognitions: { ...VALID_PAYLOAD.recognitions, protocolVersion: 2 } },
      { ...VALID_PAYLOAD, recognitions: { ...VALID_PAYLOAD.recognitions, auth: "none" } },
      null,
      []
    ];
    for (const payload of malformed) {
      const fetchImpl = vi.fn(async () => gatewayResponse(payload));
      expect(await discoverSameOriginGateway({ origin: "https://notes.example", fetchImpl: fetchImpl as typeof fetch }))
        .toBeUndefined();
    }
    const htmlFetch = vi.fn(async () => gatewayResponse("<html></html>", { badJson: true }));
    expect(await discoverSameOriginGateway({ origin: "https://notes.example", fetchImpl: htmlFetch as typeof fetch }))
      .toBeUndefined();
  });

  it("never throws on network failure", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("network down"); });
    expect(await discoverSameOriginGateway({ origin: "https://notes.example", fetchImpl: fetchImpl as typeof fetch }))
      .toBeUndefined();
  });

  it("validates the capability payload shape directly", () => {
    expect(isValidSameOriginGatewayCapabilities(VALID_PAYLOAD)).toBe(true);
    expect(isValidSameOriginGatewayCapabilities({})).toBe(false);
    expect(isValidSameOriginGatewayCapabilities(undefined)).toBe(false);
  });
});
