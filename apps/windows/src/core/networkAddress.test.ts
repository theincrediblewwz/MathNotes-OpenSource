import { describe, expect, it } from "vitest";
import { choosePreferredIngestHost, chooseRefreshedIngestHost, listIPv4AddressCandidates } from "./networkAddress";

describe("networkAddress", () => {
  it("lists non-internal IPv4 candidates before loopback addresses", () => {
    const candidates = listIPv4AddressCandidates({
      "Wi-Fi": [
        {
          address: "192.168.137.1",
          netmask: "255.255.255.0",
          family: "IPv4",
          mac: "00:00:00:00:00:01",
          internal: false,
          cidr: "192.168.137.1/24"
        }
      ],
      Loopback: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8"
        }
      ],
      IPv6Only: [
        {
          address: "::1",
          netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "::1/128",
          scopeid: 0
        }
      ]
    });

    expect(candidates).toEqual([
      {
        label: "Wi-Fi",
        address: "192.168.137.1",
        internal: false,
        usable: true,
        recommended: true,
        guidance: "Windows 热点备用入口",
        transportKind: "private_lan"
      },
      {
        label: "Loopback",
        address: "127.0.0.1",
        internal: true,
        usable: false,
        recommended: false,
        guidance: "仅本机可用",
        transportKind: "unusable"
      }
    ]);
  });

  it("chooses a non-internal IPv4 address and falls back to localhost", () => {
    expect(
      choosePreferredIngestHost([
        { label: "Loopback", address: "127.0.0.1", internal: true },
        { label: "USB", address: "192.168.42.129", internal: false }
      ])
    ).toBe("192.168.42.129");

    expect(choosePreferredIngestHost([])).toBe("127.0.0.1");
  });

  it("keeps a still-valid address but switches when a phone hotspot appears after startup", () => {
    const initial = [
      { label: "WLAN", address: "192.168.1.20", internal: false }
    ];
    expect(chooseRefreshedIngestHost(initial, "192.168.1.20")).toBe("192.168.1.20");

    const afterNetworkChange = [
      { label: "WLAN", address: "192.168.43.77", internal: false },
      { label: "vEthernet (WSL)", address: "172.24.112.1", internal: false }
    ];
    expect(chooseRefreshedIngestHost(afterNetworkChange, "192.168.1.20")).toBe("192.168.43.77");
  });

  it("prefers a physical private interface over VPN and virtual adapters", () => {
    expect(choosePreferredIngestHost([
      { label: "Meta", address: "198.18.0.1", internal: false },
      { label: "Tailscale", address: "169.254.83.107", internal: false },
      { label: "vEthernet (Default Switch)", address: "192.168.64.1", internal: false },
      { label: "WLAN", address: "172.24.118.183", internal: false }
    ])).toBe("172.24.118.183");
  });

  it("prefers the standard Windows hotspot address", () => {
    expect(choosePreferredIngestHost([
      { label: "Ethernet", address: "192.168.1.20", internal: false },
      { label: "Local Area Connection* 12", address: "192.168.137.1", internal: false }
    ])).toBe("192.168.137.1");
  });

  it("prefers a real Tailscale address and switches to it when it appears", () => {
    const initial = [
      { label: "WLAN", address: "192.168.1.20", internal: false }
    ];
    expect(chooseRefreshedIngestHost(initial, "192.168.1.20")).toBe("192.168.1.20");

    const withTailnet = [
      ...initial,
      { label: "Tailscale", address: "100.92.105.105", internal: false }
    ];
    expect(chooseRefreshedIngestHost(withTailnet, "192.168.1.20")).toBe("100.92.105.105");
    expect(choosePreferredIngestHost(withTailnet, "192.168.1.20")).toBe("192.168.1.20");
  });
});
