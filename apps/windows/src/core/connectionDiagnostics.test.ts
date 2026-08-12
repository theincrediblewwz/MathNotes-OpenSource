import { describe, expect, it } from "vitest";
import { buildConnectionDiagnostics } from "./connectionDiagnostics";

describe("buildConnectionDiagnostics", () => {
  it("reports attention for browser preview with a stopped ingest server", () => {
    const report = buildConnectionDiagnostics({
      hasNativeApi: false,
      ingestServer: { running: false }
    });

    expect(report.summary).toBe("attention");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "electron",
        status: "attention"
      })
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "ingest-server",
        status: "attention"
      })
    );
  });

  it("reports ready when Electron, token, pairing, and a non-loopback address are available", () => {
    const report = buildConnectionDiagnostics({
      hasNativeApi: true,
      ingestServer: {
        running: true,
        url: "http://192.168.137.1:51341",
        listenHost: "0.0.0.0",
        port: 51341,
        token: "pair_token",
        pairingPayload: '{"url":"http://192.168.137.1:51341"}',
        addressCandidates: [
          {
            label: "Wi-Fi",
            address: "192.168.137.1",
            internal: false
          },
          {
            label: "Loopback",
            address: "127.0.0.1",
            internal: true
          }
        ]
      }
    });

    expect(report.summary).toBe("ready");
    expect(report.recommendedMode).toBe("tailscale_first");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "address",
        status: "ok"
      })
    );
  });

  it("keeps public Wi-Fi as a warning instead of treating LAN discovery as primary", () => {
    const report = buildConnectionDiagnostics({
      hasNativeApi: true,
      ingestServer: {
        running: true,
        url: "http://127.0.0.1:51341",
        listenHost: "0.0.0.0",
        port: 51341,
        token: "pair_token",
        pairingPayload: "payload",
        addressCandidates: [
          {
            label: "Loopback",
            address: "127.0.0.1",
            internal: true
          }
        ]
      }
    });

    expect(report.summary).toBe("attention");
    expect(report.guidance.join("\n")).toMatch(/Tailscale/);
    expect(report.guidance.join("\n")).toMatch(/Windows/);
    expect(report.guidance.join("\n")).toMatch(/USB/);
    expect(report.guidance.join("\n")).toMatch(/公共 Wi-Fi/i);
    expect(report.guidance.join("\n")).toMatch(/client isolation/i);
  });

  it("does not count a rejected VPN address as phone reachable", () => {
    const report = buildConnectionDiagnostics({
      hasNativeApi: true,
      ingestServer: {
        running: true,
        token: "pair_token",
        pairingPayload: "payload",
        addressCandidates: [
          { label: "Meta", address: "198.18.0.1", internal: false, usable: false }
        ]
      }
    });

    expect(report.checks).toContainEqual(expect.objectContaining({ id: "address", status: "attention" }));
  });
});
