import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NetworkNodeConfig, NetworkNodeExposureMode } from "./networkNodeConfig";
import { isSafePrivateEndpointHost } from "../network/endpointPolicy";

export type PersistedNetworkNodeState = "starting" | "ready" | "stopping" | "stopped" | "failed";

export type NetworkNodeStatusRecord = Readonly<{
  version: 1;
  kind: "mathnotes-network-status";
  runtimeId: string;
  state: PersistedNetworkNodeState;
  pid: number;
  exposureMode: NetworkNodeExposureMode;
  updatedAt: string;
  startedAt?: string;
  localUrl?: string;
  advertisedUrl?: string;
  reasonCode?: string;
}>;

export type NetworkNodeStatusReport = Readonly<{
  version: 1;
  kind: "mathnotes-network-status";
  state: PersistedNetworkNodeState | "stale" | "unavailable";
  reasonCode: string;
  runtimeId?: string;
  pid?: number;
  exposureMode?: NetworkNodeExposureMode;
  updatedAt?: string;
  startedAt?: string;
  localUrl?: string;
  advertisedUrl?: string;
  health: "ok" | "unreachable" | "not_applicable";
}>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function networkNodeStatusPath(userDataDir: string): string {
  return join(userDataDir, "network-node-status.json");
}

export async function writeNetworkNodeStatus(
  userDataDir: string,
  record: NetworkNodeStatusRecord
): Promise<void> {
  validateStatusRecord(record);
  await mkdir(userDataDir, { recursive: true });
  const target = networkNodeStatusPath(userDataDir);
  const temporary = join(userDataDir, `.network-node-status.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

export async function readNetworkNodeStatus(
  userDataDir: string
): Promise<{ record?: NetworkNodeStatusRecord; errorCode?: "status_missing" | "status_invalid" }> {
  try {
    const parsed = JSON.parse(await readFile(networkNodeStatusPath(userDataDir), "utf8")) as unknown;
    validateStatusRecord(parsed);
    return { record: parsed };
  } catch (error) {
    if (isMissingFile(error)) return { errorCode: "status_missing" };
    return { errorCode: "status_invalid" };
  }
}

export async function probeNetworkNodeStatus(
  config: NetworkNodeConfig,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<NetworkNodeStatusReport> {
  const stored = await readNetworkNodeStatus(config.userDataDir);
  if (!stored.record) {
    return unavailable(stored.errorCode ?? "status_invalid");
  }
  const record = stored.record;
  if ((record.state === "starting" || record.state === "stopping") && !isProcessAlive(record.pid)) {
    return {
      ...reportFromRecord(record, "unreachable", "process_not_running"),
      state: "stale"
    };
  }
  if (record.state !== "ready" || !record.localUrl) {
    return reportFromRecord(record, "not_applicable", record.reasonCode ?? `service_${record.state}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${record.localUrl}/api/v1/health`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 1_000)
    });
    const body = response.ok ? await response.json() as { ok?: boolean } : undefined;
    if (!response.ok || body?.ok !== true) throw new Error("health check failed");
    return reportFromRecord(record, "ok", "service_ready");
  } catch {
    return {
      ...reportFromRecord(record, "unreachable", "local_health_unreachable"),
      state: "stale"
    };
  }
}

function reportFromRecord(
  record: NetworkNodeStatusRecord,
  health: NetworkNodeStatusReport["health"],
  reasonCode: string
): NetworkNodeStatusReport {
  return {
    version: 1,
    kind: "mathnotes-network-status",
    state: record.state,
    reasonCode,
    runtimeId: record.runtimeId,
    pid: record.pid,
    exposureMode: record.exposureMode,
    updatedAt: record.updatedAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.localUrl ? { localUrl: record.localUrl } : {}),
    ...(record.advertisedUrl ? { advertisedUrl: record.advertisedUrl } : {}),
    health
  };
}

function unavailable(reasonCode: string): NetworkNodeStatusReport {
  return {
    version: 1,
    kind: "mathnotes-network-status",
    state: "unavailable",
    reasonCode,
    health: "not_applicable"
  };
}

function validateStatusRecord(value: unknown): asserts value is NetworkNodeStatusRecord {
  if (!value || typeof value !== "object") throw new Error("Invalid network node status");
  const record = value as Partial<NetworkNodeStatusRecord>;
  if (
    record.version !== 1 ||
    record.kind !== "mathnotes-network-status" ||
    typeof record.runtimeId !== "string" ||
    !record.runtimeId ||
    !isPersistedState(record.state) ||
    !Number.isInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    !isExposureMode(record.exposureMode) ||
    !isIsoDate(record.updatedAt) ||
    (record.startedAt !== undefined && !isIsoDate(record.startedAt)) ||
    (record.localUrl !== undefined && !isSafeLocalUrl(record.localUrl)) ||
    (record.advertisedUrl !== undefined && !isSafeAdvertisedUrl(record.advertisedUrl)) ||
    (record.reasonCode !== undefined && !/^[a-z0-9_]{1,80}$/.test(record.reasonCode))
  ) {
    throw new Error("Invalid network node status");
  }
}

function isPersistedState(value: unknown): value is PersistedNetworkNodeState {
  return value === "starting" || value === "ready" || value === "stopping" || value === "stopped" || value === "failed";
}

function isExposureMode(value: unknown): value is NetworkNodeExposureMode {
  return value === "loopback" || value === "tailscale_serve" || value === "fixed_private";
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSafeLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      !url.username && !url.password && !url.search && !url.hash &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || isSafePrivateEndpointHost(url.hostname));
  } catch {
    return false;
  }
}

function isSafeAdvertisedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
