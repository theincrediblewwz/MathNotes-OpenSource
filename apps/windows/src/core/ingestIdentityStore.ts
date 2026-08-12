import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSafePrivateEndpointHost } from "@mathnotes/core-server";
import { normalizePairingToken } from "./pairingManager";

export type IngestIdentity = {
  version: 1;
  token: string;
  port: number;
  preferredHost?: string;
};

export async function readIngestIdentity(rootDir: string): Promise<IngestIdentity | null> {
  try {
    const parsed = JSON.parse(await readFile(identityPath(rootDir), "utf8")) as Partial<IngestIdentity>;
    if (parsed.version !== 1 || !isValidToken(parsed.token) || !isValidPort(parsed.port)) return null;
    return {
      version: 1,
      token: parsed.token,
      port: parsed.port,
      ...(typeof parsed.preferredHost === "string" && isSafePrivateEndpointHost(parsed.preferredHost)
        ? { preferredHost: parsed.preferredHost }
        : {})
    };
  } catch (error) {
    if (isMissingFile(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeIngestIdentity(rootDir: string, identity: IngestIdentity): Promise<void> {
  if (
    !isValidToken(identity.token) ||
    !isValidPort(identity.port) ||
    (identity.preferredHost !== undefined && !isSafePrivateEndpointHost(identity.preferredHost))
  ) {
    throw new Error("Invalid ingest identity");
  }
  const target = identityPath(rootDir);
  const tmp = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

function identityPath(rootDir: string): string {
  return join(rootDir, "ingest-identity.json");
}

function isValidToken(token: unknown): token is string {
  if (typeof token !== "string") return false;
  try {
    return normalizePairingToken(token) === token;
  } catch {
    return false;
  }
}

function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
