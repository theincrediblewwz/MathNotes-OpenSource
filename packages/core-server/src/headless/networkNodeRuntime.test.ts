import { describe, expect, it } from "vitest";
import type { NetworkNodeConfig } from "./networkNodeConfig";
import { resolveNetworkNodeRuntime } from "./networkNodeRuntime";

const config: NetworkNodeConfig = {
  version: 2,
  host: "127.0.0.1",
  port: 1051,
  userDataDir: "C:\\MathNotes\\runtime",
  notesRootDir: "C:\\MathNotes\\notes",
  legacyTokenEnv: "MATHNOTES_HEADLESS_TOKEN",
  exposureMode: "tailscale_serve",
  advertisedUrlEnv: "MATHNOTES_HEADLESS_URL"
};

describe("network node runtime preflight", () => {
  it("returns a redacted Tailscale Serve report", () => {
    const runtime = resolveNetworkNodeRuntime(config, {
      MATHNOTES_HEADLESS_TOKEN: "secret-token",
      MATHNOTES_HEADLESS_URL: "https://mathnotes.example.ts.net/"
    });
    expect(runtime.advertisedUrl).toBe("https://mathnotes.example.ts.net");
    expect(JSON.stringify(runtime.report)).not.toContain("secret-token");
    expect(runtime.report).toMatchObject({
      ok: true,
      exposureMode: "tailscale_serve",
      listenHost: "127.0.0.1",
      advertisedUrl: "https://mathnotes.example.ts.net"
    });
  });

  it("rejects missing secrets and non-origin advertised URLs without echoing values", () => {
    expect(() => resolveNetworkNodeRuntime(config, {})).toThrow("MATHNOTES_HEADLESS_TOKEN");
    expect(() => resolveNetworkNodeRuntime(config, {
      MATHNOTES_HEADLESS_TOKEN: "secret-token",
      MATHNOTES_HEADLESS_URL: "http://mathnotes.example.ts.net"
    })).toThrow("must contain an HTTPS origin");
    expect(() => resolveNetworkNodeRuntime(config, {
      MATHNOTES_HEADLESS_TOKEN: "secret-token",
      MATHNOTES_HEADLESS_URL: "https://mathnotes.example.ts.net/?token=do-not-echo"
    })).toThrowError(expect.not.stringContaining("do-not-echo"));
  });
});
