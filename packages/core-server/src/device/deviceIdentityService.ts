import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const DEFAULT_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ATTEMPTS = 5;

export type DeviceScope = "companion.read" | "material.upload";

export type DeviceIdentity = Readonly<{
  version: 1;
  deviceId: string;
  label: string;
  scopes: readonly DeviceScope[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}>;

export type PairingChallenge = Readonly<{
  challengeId: string;
  userCode: string;
  expiresAt: string;
  remainingAttempts: number;
}>;

type StoredDevice = {
  version: 1;
  deviceId: string;
  label: string;
  scopes: readonly DeviceScope[];
  tokenDigest: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
};
type StoredChallenge = {
  challengeId: string;
  userCodeDigest: string;
  scopes: readonly DeviceScope[];
  expiresAt: string;
  remainingAttempts: number;
  consumedAt?: string;
};
type DeviceIdentityState = {
  version: 1;
  devices: StoredDevice[];
  challenges: StoredChallenge[];
};

export type DeviceIdentityServiceOptions = {
  filePath?: string;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  randomId?: () => string;
  challengeTtlMs?: number;
  maxAttempts?: number;
};

export class DeviceIdentityError extends Error {
  constructor(
    public readonly code:
      | "challenge_not_found"
      | "challenge_expired"
      | "challenge_consumed"
      | "pairing_code_invalid"
      | "pairing_attempts_exhausted",
    message: string
  ) {
    super(message);
  }
}

export class DeviceIdentityService {
  private state: DeviceIdentityState = emptyState();
  private loaded = false;
  private operation: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly bytes: (size: number) => Buffer;
  private readonly id: () => string;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly options: DeviceIdentityServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.bytes = options.randomBytes ?? randomBytes;
    this.id = options.randomId ?? randomUUID;
    this.ttlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new Error("challengeTtlMs must be positive");
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts <= 0) throw new Error("maxAttempts must be positive");
  }

  async start(): Promise<void> {
    await this.serial(async () => {
      if (this.loaded) return;
      this.state = await readState(this.options.filePath);
      this.loaded = true;
    });
  }

  async createChallenge(scopes: readonly DeviceScope[] = ["companion.read", "material.upload"]): Promise<PairingChallenge> {
    return this.serial(async () => {
      this.assertLoaded();
      const now = this.now();
      this.pruneChallenges(now);
      return this.createStoredChallenge(now, scopes);
    });
  }

  async createExclusiveChallenge(
    scopes: readonly DeviceScope[] = ["companion.read", "material.upload"]
  ): Promise<PairingChallenge> {
    return this.serial(async () => {
      this.assertLoaded();
      const now = this.now();
      this.pruneChallenges(now);
      this.state.challenges = [];
      return this.createStoredChallenge(now, scopes);
    });
  }

  async exchangeChallenge(input: {
    challengeId: string;
    userCode: string;
    deviceLabel: string;
  }): Promise<{ device: DeviceIdentity; token: string }> {
    return this.serial(async () => {
      this.assertLoaded();
      const challenge = this.state.challenges.find((candidate) => candidate.challengeId === input.challengeId);
      if (!challenge) throw new DeviceIdentityError("challenge_not_found", "Pairing challenge was not found");
      return this.exchangeStoredChallenge(challenge, input.userCode, input.deviceLabel);
    });
  }

  async exchangeActiveChallenge(input: {
    userCode: string;
    deviceLabel: string;
  }): Promise<{ device: DeviceIdentity; token: string }> {
    return this.serial(async () => {
      this.assertLoaded();
      const now = this.now();
      this.pruneChallenges(now);
      const active = this.state.challenges.filter((candidate) => !candidate.consumedAt);
      if (active.length !== 1) {
        throw new DeviceIdentityError("challenge_not_found", "Exactly one active pairing challenge is required");
      }
      return this.exchangeStoredChallenge(active[0]!, input.userCode, input.deviceLabel);
    });
  }

  async verifyToken(token: string, requiredScope?: DeviceScope): Promise<DeviceIdentity | null> {
    return this.serial(async () => {
      this.assertLoaded();
      const tokenDigest = digest(token);
      const device = this.state.devices.find((candidate) => safeDigestEqual(candidate.tokenDigest, tokenDigest));
      if (!device || device.revokedAt || (requiredScope && !device.scopes.includes(requiredScope))) return null;
      return publicDevice(device);
    });
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    return this.serial(async () => {
      this.assertLoaded();
      const device = this.state.devices.find((candidate) => candidate.deviceId === deviceId);
      if (!device || device.revokedAt) return false;
      device.revokedAt = this.now().toISOString();
      await this.persist();
      return true;
    });
  }

  async listDevices(): Promise<DeviceIdentity[]> {
    return this.serial(async () => {
      this.assertLoaded();
      return this.state.devices.map(publicDevice);
    });
  }

  private pruneChallenges(now: Date): void {
    this.state.challenges = this.state.challenges.filter((candidate) => {
      if (candidate.consumedAt) return false;
      return Date.parse(candidate.expiresAt) > now.getTime();
    });
  }

  private async createStoredChallenge(
    now: Date,
    scopes: readonly DeviceScope[]
  ): Promise<PairingChallenge> {
    const rawCode = createUserCode(this.bytes);
    const challenge: StoredChallenge = {
      challengeId: this.id(),
      userCodeDigest: digest(normalizeUserCode(rawCode)),
      scopes: normalizeScopes(scopes),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      remainingAttempts: this.maxAttempts
    };
    this.state.challenges.push(challenge);
    await this.persist();
    return {
      challengeId: challenge.challengeId,
      userCode: formatUserCode(rawCode),
      expiresAt: challenge.expiresAt,
      remainingAttempts: challenge.remainingAttempts
    };
  }

  private async exchangeStoredChallenge(
    challenge: StoredChallenge,
    userCode: string,
    deviceLabel: string
  ): Promise<{ device: DeviceIdentity; token: string }> {
    const now = this.now();
    if (challenge.consumedAt) throw new DeviceIdentityError("challenge_consumed", "Pairing challenge was already used");
    if (Date.parse(challenge.expiresAt) <= now.getTime()) {
      throw new DeviceIdentityError("challenge_expired", "Pairing challenge has expired");
    }
    if (challenge.remainingAttempts <= 0) {
      throw new DeviceIdentityError("pairing_attempts_exhausted", "Pairing challenge has no attempts remaining");
    }

    const suppliedDigest = digest(normalizeUserCode(userCode));
    if (!safeDigestEqual(suppliedDigest, challenge.userCodeDigest)) {
      challenge.remainingAttempts -= 1;
      await this.persist();
      if (challenge.remainingAttempts <= 0) {
        throw new DeviceIdentityError("pairing_attempts_exhausted", "Pairing challenge has no attempts remaining");
      }
      throw new DeviceIdentityError("pairing_code_invalid", "Pairing code is invalid");
    }

    const label = deviceLabel.trim();
    if (!label || label.length > 80) throw new Error("deviceLabel must contain 1-80 characters");
    const token = this.bytes(32).toString("base64url");
    const device: StoredDevice = {
      version: 1,
      deviceId: this.id(),
      label,
      scopes: challenge.scopes,
      tokenDigest: digest(token),
      createdAt: now.toISOString()
    };
    challenge.consumedAt = now.toISOString();
    this.state.devices.push(device);
    await this.persist();
    return { device: publicDevice(device), token };
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("DeviceIdentityService.start() must be called first");
  }

  private async persist(): Promise<void> {
    if (!this.options.filePath) return;
    const target = this.options.filePath;
    const temporary = `${target}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function readState(filePath?: string): Promise<DeviceIdentityState> {
  if (!filePath) return emptyState();
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isStoredState(parsed)) throw new Error("Invalid device identity store");
    return parsed;
  } catch (error) {
    if (isMissingFile(error)) return emptyState();
    throw error;
  }
}

function isStoredState(value: unknown): value is DeviceIdentityState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DeviceIdentityState>;
  return candidate.version === 1
    && Array.isArray(candidate.devices)
    && candidate.devices.every(isStoredDevice)
    && Array.isArray(candidate.challenges)
    && candidate.challenges.every(isStoredChallenge);
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (!value || typeof value !== "object") return false;
  const device = value as Partial<StoredDevice>;
  return device.version === 1
    && isNonEmptyString(device.deviceId)
    && isNonEmptyString(device.label)
    && isScopes(device.scopes)
    && typeof device.tokenDigest === "string"
    && /^[a-f0-9]{64}$/.test(device.tokenDigest)
    && isTimestamp(device.createdAt)
    && (device.lastSeenAt === undefined || isTimestamp(device.lastSeenAt))
    && (device.revokedAt === undefined || isTimestamp(device.revokedAt));
}

function isStoredChallenge(value: unknown): value is StoredChallenge {
  if (!value || typeof value !== "object") return false;
  const challenge = value as Partial<StoredChallenge>;
  return isNonEmptyString(challenge.challengeId)
    && typeof challenge.userCodeDigest === "string"
    && /^[a-f0-9]{64}$/.test(challenge.userCodeDigest)
    && isScopes(challenge.scopes)
    && isTimestamp(challenge.expiresAt)
    && Number.isInteger(challenge.remainingAttempts)
    && (challenge.remainingAttempts ?? -1) >= 0
    && (challenge.consumedAt === undefined || isTimestamp(challenge.consumedAt));
}

function emptyState(): DeviceIdentityState {
  return { version: 1, devices: [], challenges: [] };
}

function createUserCode(bytes: (size: number) => Buffer): string {
  const entropy = bytes(8);
  let code = "";
  for (let index = 0; index < 8; index += 1) code += USER_CODE_ALPHABET[entropy[index] % USER_CODE_ALPHABET.length];
  return code;
}

function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[-\s]/g, "");
}

function formatUserCode(value: string): string {
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function normalizeScopes(scopes: readonly DeviceScope[]): DeviceScope[] {
  const normalized = [...new Set(scopes)];
  if (normalized.length === 0) throw new Error("At least one device scope is required");
  if (!isScopes(normalized)) throw new Error("Invalid device scope");
  return normalized.sort();
}

function isScopes(value: unknown): value is readonly DeviceScope[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((scope) => scope === "companion.read" || scope === "material.upload");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function publicDevice(device: StoredDevice): DeviceIdentity {
  return {
    version: 1,
    deviceId: device.deviceId,
    label: device.label,
    scopes: [...device.scopes],
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
