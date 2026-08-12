import { describe, expect, it } from "vitest";
import { normalizePairingToken, PairingManager, validatePairingTokenUpdate } from "./pairingManager";

describe("PairingManager", () => {
  it("creates deterministic pairing payloads when a token is supplied", () => {
    const manager = new PairingManager();

    const pairing = manager.createPairingSession({
      host: "192.168.137.1",
      port: 37621,
      token: "0123456789abcdef0123456789abcdef",
      now: "2026-06-26T10:00:00.000Z"
    });

    expect(pairing.token).toBe("0123456789abcdef0123456789abcdef");
    expect(pairing.payload).toBe(
      "mathnotes://pair?v=1&host=192.168.137.1&port=37621&token=0123456789abcdef0123456789abcdef&transport=private_http"
    );
    expect(pairing.createdAt).toBe("2026-06-26T10:00:00.000Z");
    expect(pairing.alternateHosts).toEqual([]);
  });

  it("adds bounded alternate private hosts without duplicating the primary address", () => {
    const pairing = new PairingManager().createPairingSession({
      host: "192.168.137.1",
      hosts: ["192.168.137.1", "10.20.30.40", "100.85.42.7", "10.20.30.40"],
      port: 37621,
      token: "0123456789abcdef0123456789abcdef",
      now: "2026-06-26T10:00:00.000Z"
    });

    expect(pairing.alternateHosts).toEqual(["10.20.30.40", "100.85.42.7"]);
    expect(pairing.payload).toContain("hosts=10.20.30.40%2C100.85.42.7");
  });

  it("creates a v2 one-time challenge payload without the legacy bearer token", () => {
    const pairing = new PairingManager().createDevicePairingSession({
      host: "192.168.137.1",
      hosts: ["192.168.137.1", "100.92.105.105"],
      port: 37621,
      challengeId: "challenge-001",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-07-25T08:05:00.000Z",
      now: "2026-07-25T08:00:00.000Z"
    });

    expect(pairing.payload).toContain("mathnotes://pair?v=2");
    expect(pairing.payload).toContain("challenge=challenge-001");
    expect(pairing.payload).toContain("code=ABCD-EFGH");
    expect(pairing.payload).toContain("hosts=100.92.105.105");
    expect(pairing.payload).not.toContain("token=");
  });

  it("generates a token when none is supplied", () => {
    const manager = new PairingManager();

    const pairing = manager.createPairingSession({
      host: "127.0.0.1",
      port: 37621,
      now: "2026-06-26T10:00:00.000Z"
    });

    expect(pairing.token).toMatch(/^[a-f0-9]{32}$/);
    expect(pairing.payload).toContain(`token=${pairing.token}`);
  });

  it("verifies bearer tokens strictly", () => {
    const manager = new PairingManager();

    expect(manager.verifyBearerToken("Bearer test-token", "test-token")).toBe(true);
    expect(manager.verifyBearerToken("bearer test-token", "test-token")).toBe(false);
    expect(manager.verifyBearerToken("Token test-token", "test-token")).toBe(false);
    expect(manager.verifyBearerToken(undefined, "test-token")).toBe(false);
    expect(manager.verifyBearerToken("Bearer wrong", "test-token")).toBe(false);
  });

  it("normalizes memorable tokens without accepting weak or ambiguous input", () => {
    expect(normalizePairingToken("  MathNotes-Remote_2026  ")).toBe("MathNotes-Remote_2026");
    expect(() => normalizePairingToken("too-short")).toThrow("16-128");
    expect(() => normalizePairingToken("MathNotes remote password")).toThrow("只能包含");
  });

  it("requires matching confirmation before changing the persisted token", () => {
    expect(validatePairingTokenUpdate({
      token: "MathNotes-Remote_2026",
      confirmation: "MathNotes-Remote_2026"
    })).toBe("MathNotes-Remote_2026");
    expect(() => validatePairingTokenUpdate({
      token: "MathNotes-Remote_2026",
      confirmation: "MathNotes-Remote_2027"
    })).toThrow("不一致");
  });
});
