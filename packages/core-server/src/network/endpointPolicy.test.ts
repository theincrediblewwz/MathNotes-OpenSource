import { describe, expect, it } from "vitest";
import {
  assessEndpointAddress,
  chooseEndpointHost,
  isSafePrivateEndpointHost,
  isTailnetIpv4,
  rankEndpointCandidates
} from "./endpointPolicy";

const candidates = [
  { label: "Local Area Connection* 12", address: "192.168.137.1", internal: false },
  { label: "WLAN", address: "172.24.118.183", internal: false },
  { label: "Tailscale", address: "100.92.105.105", internal: false }
];

describe("endpointPolicy", () => {
  it("places a real tailnet address before hotspot and LAN candidates", () => {
    expect(rankEndpointCandidates(candidates).map((candidate) => candidate.address)).toEqual([
      "100.92.105.105",
      "192.168.137.1",
      "172.24.118.183"
    ]);
    expect(chooseEndpointHost(candidates)).toEqual({
      host: "100.92.105.105",
      kind: "tailnet",
      preferredHostApplied: false
    });
  });

  it("keeps an available explicit preference ahead of the automatic policy", () => {
    expect(chooseEndpointHost(candidates, "172.24.118.183")).toEqual({
      host: "172.24.118.183",
      kind: "private_lan",
      preferredHostApplied: true
    });
  });

  it("falls back automatically without deleting a temporarily missing preference", () => {
    expect(chooseEndpointHost(candidates, "192.168.42.129")).toEqual({
      host: "100.92.105.105",
      kind: "tailnet",
      preferredHostApplied: false
    });
  });

  it("does not classify a link-local address as tailnet based on its adapter name", () => {
    const candidate = { label: "Tailscale", address: "169.254.83.107", internal: false };
    expect(assessEndpointAddress(candidate)).toMatchObject({ kind: "link_local", usable: true });
    expect(isTailnetIpv4(candidate.address)).toBe(false);
  });

  it("rejects loopback, benchmark and public hosts from fixed private endpoints", () => {
    expect(isSafePrivateEndpointHost("100.64.0.1")).toBe(true);
    expect(isSafePrivateEndpointHost("192.168.1.20")).toBe(true);
    expect(isSafePrivateEndpointHost("127.0.0.1")).toBe(false);
    expect(isSafePrivateEndpointHost("198.18.0.1")).toBe(false);
    expect(isSafePrivateEndpointHost("8.8.8.8")).toBe(false);
  });
});
