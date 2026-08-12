import { randomBytes, timingSafeEqual } from "node:crypto";

export const MIN_PAIRING_TOKEN_LENGTH = 16;
export const MAX_PAIRING_TOKEN_LENGTH = 128;
const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;

export type PairingSession = {
  version: 1;
  host: string;
  port: number;
  transport: "private_http";
  token: string;
  alternateHosts: string[];
  payload: string;
  createdAt: string;
};

export type DevicePairingSession = {
  version: 2;
  host: string;
  port: number;
  transport: "private_http";
  challengeId: string;
  userCode: string;
  expiresAt: string;
  alternateHosts: string[];
  payload: string;
  createdAt: string;
};

export class PairingManager {
  createPairingSession(args: {
    host: string;
    hosts?: string[];
    port: number;
    token?: string;
    now: string;
  }): PairingSession {
    const token = args.token ?? randomBytes(16).toString("hex");
    const alternateHosts = normalizeAlternateHosts(args.host, args.hosts);
    const params = new URLSearchParams({
      v: "1",
      host: args.host,
      port: String(args.port),
      token,
      transport: "private_http"
    });
    if (alternateHosts.length > 0) {
      params.set("hosts", alternateHosts.join(","));
    }

    return {
      version: 1,
      host: args.host,
      port: args.port,
      transport: "private_http",
      token,
      alternateHosts,
      payload: `mathnotes://pair?${params.toString()}`,
      createdAt: args.now
    };
  }

  createDevicePairingSession(args: {
    host: string;
    hosts?: string[];
    port: number;
    challengeId: string;
    userCode: string;
    expiresAt: string;
    now: string;
  }): DevicePairingSession {
    const alternateHosts = normalizeAlternateHosts(args.host, args.hosts);
    const params = new URLSearchParams({
      v: "2",
      host: args.host,
      port: String(args.port),
      challenge: args.challengeId,
      code: args.userCode,
      expires: args.expiresAt,
      transport: "private_http"
    });
    if (alternateHosts.length > 0) params.set("hosts", alternateHosts.join(","));

    return {
      version: 2,
      host: args.host,
      port: args.port,
      transport: "private_http",
      challengeId: args.challengeId,
      userCode: args.userCode,
      expiresAt: args.expiresAt,
      alternateHosts,
      payload: `mathnotes://pair?${params.toString()}`,
      createdAt: args.now
    };
  }

  verifyBearerToken(header: string | undefined, expectedToken: string): boolean {
    if (!header) {
      return false;
    }
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) return false;
    const actualToken = header.slice(prefix.length);
    const actual = Buffer.from(actualToken, "utf8");
    const expected = Buffer.from(expectedToken, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

function normalizeAlternateHosts(host: string, hosts: string[] = []): string[] {
  return hosts
    .filter((candidate, index, candidates) => candidate !== host && candidates.indexOf(candidate) === index)
    .slice(0, 5);
}

export function normalizePairingToken(value: string): string {
  const token = value.trim();
  if (token.length < MIN_PAIRING_TOKEN_LENGTH || token.length > MAX_PAIRING_TOKEN_LENGTH) {
    throw new Error(`配对令牌需要 ${MIN_PAIRING_TOKEN_LENGTH}-${MAX_PAIRING_TOKEN_LENGTH} 个字符。`);
  }
  if (!PAIRING_TOKEN_PATTERN.test(token)) {
    throw new Error("配对令牌只能包含英文字母、数字以及 . _ ~ -。");
  }
  return token;
}

export function validatePairingTokenUpdate(input: { token: string; confirmation: string }): string {
  const token = normalizePairingToken(input.token);
  const confirmation = normalizePairingToken(input.confirmation);
  if (token !== confirmation) {
    throw new Error("两次输入的配对令牌不一致。");
  }
  return token;
}
