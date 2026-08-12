import { describe, expect, it } from "vitest";
import { credentialMatchesPageOrigin, migrateCredentialOrigin } from "./pairing";
import type { DeviceCredential } from "./domain";

function credential(origin: string): DeviceCredential {
  return {
    id: "active",
    version: 1,
    origin,
    token: "secret-token",
    deviceId: "device-1",
    deviceLabel: "iPhone",
    verifiedAt: "2026-07-26T00:00:00.000Z"
  };
}

describe("migrateCredentialOrigin", () => {
  it("removes a legacy trailing slash without changing the device credential", () => {
    expect(migrateCredentialOrigin(
      credential("https://mac.tailnet.ts.net/"),
      "https://fallback.test"
    )).toEqual(
      credential("https://mac.tailnet.ts.net")
    );
  });

  it("keeps an explicit LAN port", () => {
    expect(migrateCredentialOrigin(
      credential("http://192.168.1.8:1051"),
      "https://fallback.test"
    ).origin).toBe(
      "http://192.168.1.8:1051"
    );
  });
});

describe("credentialMatchesPageOrigin", () => {
  it("accepts only credentials issued for the PWA page origin", () => {
    expect(credentialMatchesPageOrigin(
      credential("https://windows.tailnet.ts.net/"),
      "https://windows.tailnet.ts.net"
    )).toBe(true);
    expect(credentialMatchesPageOrigin(
      credential("https://mac.tailnet.ts.net"),
      "https://windows.tailnet.ts.net"
    )).toBe(false);
  });
});
