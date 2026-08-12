import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeviceIdentityError, DeviceIdentityService } from "./deviceIdentityService";

describe("DeviceIdentityService", () => {
  let rootDir: string;
  let nowMs: number;
  let sequence: number;
  let filePath: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-devices-"));
    filePath = join(rootDir, "device-identities.json");
    nowMs = Date.parse("2026-07-24T04:00:00.000Z");
    sequence = 0;
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("exchanges a one-time short code for a hashed revocable device token", async () => {
    const service = createService();
    await service.start();
    const challenge = await service.createChallenge(["companion.read"]);
    const issued = await service.exchangeChallenge({
      challengeId: challenge.challengeId,
      userCode: challenge.userCode.toLowerCase(),
      deviceLabel: "Lecture phone"
    });

    expect(issued.token.length).toBeGreaterThan(32);
    expect(await service.verifyToken(issued.token, "companion.read")).toMatchObject({
      deviceId: issued.device.deviceId,
      label: "Lecture phone"
    });
    expect(await service.verifyToken(issued.token, "material.upload")).toBeNull();
    await expect(service.exchangeChallenge({
      challengeId: challenge.challengeId,
      userCode: challenge.userCode,
      deviceLabel: "Duplicate"
    })).rejects.toMatchObject({ code: "challenge_consumed" });

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain(issued.token);
    expect(raw).not.toContain(challenge.userCode);
    expect(await service.revokeDevice(issued.device.deviceId)).toBe(true);
    expect(await service.verifyToken(issued.token)).toBeNull();
  });

  it("persists device verification and revocation across restart", async () => {
    const first = createService();
    await first.start();
    const challenge = await first.createChallenge();
    const issued = await first.exchangeChallenge({
      challengeId: challenge.challengeId,
      userCode: challenge.userCode,
      deviceLabel: "Android"
    });

    const restarted = createService();
    await restarted.start();
    expect(await restarted.verifyToken(issued.token, "material.upload")).toMatchObject({ label: "Android" });
    await restarted.revokeDevice(issued.device.deviceId);

    const afterRevoke = createService();
    await afterRevoke.start();
    expect(await afterRevoke.verifyToken(issued.token)).toBeNull();
  });

  it("keeps one active short code and exchanges it without exposing the challenge id", async () => {
    const service = createService();
    await service.start();
    const replaced = await service.createExclusiveChallenge(["companion.read"]);
    const active = await service.createExclusiveChallenge(["companion.read", "material.upload"]);

    await expect(service.exchangeActiveChallenge({
      userCode: replaced.userCode,
      deviceLabel: "Old code"
    })).rejects.toMatchObject({ code: "pairing_code_invalid" });

    const issued = await service.exchangeActiveChallenge({
      userCode: active.userCode.toLowerCase(),
      deviceLabel: "PWA on iPhone"
    });
    expect(await service.verifyToken(issued.token, "companion.read")).toMatchObject({
      deviceId: issued.device.deviceId,
      label: "PWA on iPhone"
    });
    expect(await service.verifyToken(issued.token, "material.upload")).toMatchObject({
      deviceId: issued.device.deviceId
    });
    await expect(service.exchangeActiveChallenge({
      userCode: active.userCode,
      deviceLabel: "Second use"
    })).rejects.toMatchObject({ code: "challenge_not_found" });
  });

  it("expires challenges and bounds invalid attempts", async () => {
    const service = createService({ challengeTtlMs: 1_000, maxAttempts: 2 });
    await service.start();
    const challenge = await service.createChallenge();
    await expect(service.exchangeChallenge({
      challengeId: challenge.challengeId,
      userCode: "WRONG-001",
      deviceLabel: "Phone"
    })).rejects.toMatchObject({ code: "pairing_code_invalid" });
    await expect(service.exchangeChallenge({
      challengeId: challenge.challengeId,
      userCode: "WRONG-002",
      deviceLabel: "Phone"
    })).rejects.toMatchObject({ code: "pairing_attempts_exhausted" });
    await expect(service.exchangeChallenge({
      challengeId: challenge.challengeId,
      userCode: challenge.userCode,
      deviceLabel: "Phone"
    })).rejects.toMatchObject({ code: "pairing_attempts_exhausted" });

    const expiring = await service.createChallenge();
    nowMs += 1_001;
    await expect(service.exchangeChallenge({
      challengeId: expiring.challengeId,
      userCode: expiring.userCode,
      deviceLabel: "Phone"
    })).rejects.toBeInstanceOf(DeviceIdentityError);
    await expect(service.exchangeChallenge({
      challengeId: expiring.challengeId,
      userCode: expiring.userCode,
      deviceLabel: "Phone"
    })).rejects.toMatchObject({ code: "challenge_expired" });
  });

  function createService(overrides: { challengeTtlMs?: number; maxAttempts?: number } = {}) {
    return new DeviceIdentityService({
      filePath,
      now: () => new Date(nowMs),
      randomBytes: (size) => Buffer.alloc(size, sequence++),
      randomId: () => `id-${++sequence}`,
      ...overrides
    });
  }
});
