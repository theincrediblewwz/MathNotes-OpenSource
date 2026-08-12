import type { DeviceCredential } from "./domain";

export type PairingRequest = Readonly<{
  challengeId?: string;
  userCode: string;
  expiresAt?: string;
}>;

export class PairingInputError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "wrong-origin" | "expired"
  ) {
    super(message);
    this.name = "PairingInputError";
  }
}

export function normalizeCompanionOrigin(rawInput: string, fallbackOrigin: string): string {
  const input = rawInput.trim();
  const candidate = input || fallbackOrigin;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
    ? candidate
    : `http://${candidate}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new PairingInputError("电脑地址格式不正确，请填写 https://主机名 或 IP:端口。", "invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PairingInputError("电脑地址只支持 HTTP 或 HTTPS。", "invalid");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new PairingInputError("电脑地址只填写服务根地址，不要包含账号、路径或参数。", "invalid");
  }
  return url.origin;
}

export function migrateCredentialOrigin(
  credential: DeviceCredential,
  fallbackOrigin: string
): DeviceCredential {
  const origin = normalizeCompanionOrigin(credential.origin, fallbackOrigin);
  return origin === credential.origin ? credential : { ...credential, origin };
}

export function credentialMatchesPageOrigin(
  credential: DeviceCredential,
  pageOrigin: string
): boolean {
  return normalizeCompanionOrigin(credential.origin, pageOrigin) ===
    normalizeCompanionOrigin(pageOrigin, pageOrigin);
}

export function parsePairingInput(
  rawInput: string,
  expectedOrigin: string,
  now: Date = new Date()
): PairingRequest {
  const input = rawInput.trim();
  if (!input) throw new PairingInputError("请输入电脑端显示的配对内容。", "invalid");

  const compactCode = input.toUpperCase().replace(/[-\s]/g, "");
  if (/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(compactCode)) {
    return { userCode: `${compactCode.slice(0, 4)}-${compactCode.slice(4)}` };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PairingInputError("配对内容格式不正确。", "invalid");
  }

  if (url.protocol === "mathnotes:") {
    if (url.hostname !== "pair") {
      throw new PairingInputError("这不是 MathNotes 配对内容。", "invalid");
    }
  } else {
    const expected = new URL(expectedOrigin);
    if (url.origin !== expected.origin) {
      throw new PairingInputError("配对链接不属于当前 MathNotes 服务。", "wrong-origin");
    }
  }

  const challengeId = firstQuery(url, "challenge", "challengeId");
  const userCode = firstQuery(url, "code", "userCode");
  const expiresAt = firstQuery(url, "expires", "expiresAt");
  if (!challengeId || !userCode) {
    throw new PairingInputError("配对内容缺少一次性验证码。", "invalid");
  }
  if (expiresAt) {
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(expires)) {
      throw new PairingInputError("配对有效期格式不正确。", "invalid");
    }
    if (expires <= now.getTime()) {
      throw new PairingInputError("这组配对码已经过期，请在电脑端刷新。", "expired");
    }
  }
  return { challengeId, userCode, expiresAt: expiresAt || undefined };
}

function firstQuery(url: URL, ...names: string[]): string {
  for (const name of names) {
    const value = url.searchParams.get(name)?.trim();
    if (value) return value;
  }
  return "";
}
