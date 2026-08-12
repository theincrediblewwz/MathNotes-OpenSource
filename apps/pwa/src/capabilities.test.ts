import { describe, expect, it } from "vitest";
import { readPwaCapabilities, type CapabilitySource } from "./capabilities";

const base: CapabilitySource = {
  now: () => new Date("2026-07-25T10:00:00.000Z"),
  online: true,
  standalone: false,
  serviceWorker: true,
  indexedDb: true,
  storagePersist: true,
  camera: true,
  cameraZoomConstraint: false,
  share: true,
  push: true,
  badge: false
};

describe("readPwaCapabilities", () => {
  it("reports stable feature-detected capabilities without a user-agent branch", () => {
    expect(readPwaCapabilities(base)).toEqual({
      schemaVersion: 1,
      capturedAt: "2026-07-25T10:00:00.000Z",
      online: true,
      standalone: false,
      serviceWorker: "available",
      indexedDb: "available",
      persistentStorage: "available",
      camera: "requires-permission",
      cameraZoom: "unavailable",
      share: "available",
      push: "requires-permission",
      badge: "unavailable"
    });
  });

  it("fails closed when optional browser capabilities are absent", () => {
    const unavailable = readPwaCapabilities({
      ...base,
      online: false,
      serviceWorker: false,
      indexedDb: false,
      storagePersist: false,
      camera: false,
      share: false,
      push: false
    });
    expect(unavailable.online).toBe(false);
    expect(unavailable.serviceWorker).toBe("unavailable");
    expect(unavailable.camera).toBe("unavailable");
    expect(unavailable.push).toBe("unavailable");
  });
});
