import { describe, expect, it } from "vitest";
import { normalizeCompanionOrigin, PairingInputError, parsePairingInput } from "./pairing";

describe("normalizeCompanionOrigin", () => {
  it.each([
    ["", "https://notes.example.test", "https://notes.example.test"],
    ["https://mac.tailnet.ts.net", "https://fallback.test", "https://mac.tailnet.ts.net"],
    ["http://192.168.1.8:1051", "https://fallback.test", "http://192.168.1.8:1051"],
    ["100.92.105.105:1051", "https://fallback.test", "http://100.92.105.105:1051"]
  ])("normalizes %s", (input, fallback, expected) => {
    expect(normalizeCompanionOrigin(input, fallback)).toBe(expected);
  });

  it.each([
    "ftp://host.test",
    "https://user:secret@host.test",
    "https://host.test/api",
    "https://host.test?token=secret"
  ])("rejects unsafe endpoint %s", (input) => {
    expect(() => normalizeCompanionOrigin(input, "https://fallback.test")).toThrow(PairingInputError);
  });
});

describe("parsePairingInput", () => {
  it.each([
    ["ABCD-2345", "ABCD-2345"],
    ["abcd 2345", "ABCD-2345"]
  ])("accepts a one-time short code %s", (input, userCode) => {
    expect(parsePairingInput(input, "https://notes.example.test")).toEqual({ userCode });
  });

  it("accepts MathNotes custom links without retaining unrelated endpoint fields", () => {
    expect(parsePairingInput(
      "mathnotes://pair?v=2&host=100.64.0.1&challenge=challenge-1&code=ABCD-2345&expires=2026-07-25T13%3A00%3A00.000Z",
      "https://notes.example.test",
      new Date("2026-07-25T12:00:00.000Z")
    )).toEqual({
      challengeId: "challenge-1",
      userCode: "ABCD-2345",
      expiresAt: "2026-07-25T13:00:00.000Z"
    });
  });

  it("accepts a same-origin browser link", () => {
    expect(parsePairingInput(
      "https://notes.example.test/pair?challengeId=one&userCode=TWO",
      "https://notes.example.test"
    )).toMatchObject({ challengeId: "one", userCode: "TWO" });
  });

  it.each([
    ["https://other.example.test/pair?challenge=one&code=two", "wrong-origin"],
    ["mathnotes://wrong?challenge=one&code=two", "invalid"],
    ["mathnotes://pair?challenge=one", "invalid"],
    ["mathnotes://pair?challenge=one&code=two&expires=2020-01-01T00:00:00.000Z", "expired"]
  ])("rejects unsafe input %s", (input, code) => {
    expect(() => parsePairingInput(input, "https://notes.example.test", new Date("2026-01-01T00:00:00Z")))
      .toThrowError(PairingInputError);
    try {
      parsePairingInput(input, "https://notes.example.test", new Date("2026-01-01T00:00:00Z"));
    } catch (error) {
      expect((error as PairingInputError).code).toBe(code);
    }
  });
});
