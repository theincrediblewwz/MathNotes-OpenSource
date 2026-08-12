import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { assessEndpointAddress } from "../network/endpointPolicy";

export type NetworkNodeExposureMode = "loopback" | "tailscale_serve" | "fixed_private";

export type NetworkNodeConfig = Readonly<{
  version: 1 | 2;
  host: string;
  port: number;
  userDataDir: string;
  notesRootDir: string;
  legacyTokenEnv: string;
  exposureMode: NetworkNodeExposureMode;
  advertisedUrlEnv?: string;
  pwaStaticRootDir?: string;
}>;

const V1_FIELDS = new Set(["version", "host", "port", "userDataDir", "notesRootDir", "legacyTokenEnv"]);
const V2_FIELDS = new Set([...V1_FIELDS, "exposureMode", "advertisedUrlEnv", "pwaStaticRootDir"]);

export async function readNetworkNodeConfig(path: string): Promise<NetworkNodeConfig> {
  if (!isAbsolute(path)) throw new Error("Network node config path must be absolute");
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (raw.version !== 1 && raw.version !== 2) throw new Error("Unsupported network node config version");
  const allowedFields = raw.version === 1 ? V1_FIELDS : V2_FIELDS;
  for (const key of Object.keys(raw)) {
    if (!allowedFields.has(key)) throw new Error(`Unknown network node config field: ${key}`);
  }
  const port = raw.port === undefined ? 0 : integer(raw.port, "port", 0, 65_535);
  const userDataDir = absoluteDirectory(raw.userDataDir, "userDataDir");
  const notesRootDir = absoluteDirectory(raw.notesRootDir, "notesRootDir");
  const legacyTokenEnv = environmentVariableName(raw.legacyTokenEnv, "legacyTokenEnv");

  if (raw.version === 1) {
    const host = optionalString(raw.host) ?? "127.0.0.1";
    return {
      version: 1,
      host,
      port,
      userDataDir,
      notesRootDir,
      legacyTokenEnv,
      exposureMode: host === "127.0.0.1" ? "loopback" : "fixed_private"
    };
  }

  const exposureMode = exposureModeValue(raw.exposureMode);
  if (exposureMode === "tailscale_serve" && port === 0) {
    throw new Error("tailscale_serve requires a fixed non-zero port");
  }
  const configuredHost = optionalString(raw.host);
  if (exposureMode === "tailscale_serve" || exposureMode === "loopback") {
    if (configuredHost !== undefined && configuredHost !== "127.0.0.1") {
      throw new Error(`${exposureMode} must listen on 127.0.0.1`);
    }
  }
  const host = exposureMode === "fixed_private"
    ? fixedPrivateHost(configuredHost)
    : "127.0.0.1";
  const advertisedUrlEnv = exposureMode === "tailscale_serve"
    ? environmentVariableName(raw.advertisedUrlEnv, "advertisedUrlEnv")
    : undefined;
  if (exposureMode !== "tailscale_serve" && raw.advertisedUrlEnv !== undefined) {
    throw new Error("advertisedUrlEnv is only supported for tailscale_serve");
  }
  const pwaStaticRootDir = raw.pwaStaticRootDir === undefined
    ? undefined
    : absoluteDirectory(raw.pwaStaticRootDir, "pwaStaticRootDir");
  return {
    version: 2,
    host,
    port,
    userDataDir,
    notesRootDir,
    legacyTokenEnv,
    exposureMode,
    ...(advertisedUrlEnv ? { advertisedUrlEnv } : {}),
    ...(pwaStaticRootDir ? { pwaStaticRootDir } : {})
  };
}

function absoluteDirectory(value: unknown, name: string): string {
  const directory = requiredString(value, name);
  if (!isAbsolute(directory)) throw new Error(`${name} must be an absolute path`);
  return resolve(directory);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, "host");
}

function environmentVariableName(value: unknown, name: string): string {
  const variableName = requiredString(value, name);
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(variableName)) {
    throw new Error(`${name} must be an environment variable name`);
  }
  return variableName;
}

function exposureModeValue(value: unknown): NetworkNodeExposureMode {
  const mode = value === undefined ? "tailscale_serve" : requiredString(value, "exposureMode");
  if (mode !== "loopback" && mode !== "tailscale_serve" && mode !== "fixed_private") {
    throw new Error("exposureMode must be loopback, tailscale_serve, or fixed_private");
  }
  return mode;
}

function fixedPrivateHost(value: string | undefined): string {
  if (!value) throw new Error("host is required for fixed_private");
  if (value === "127.0.0.1") return value;
  const assessment = assessEndpointAddress({ label: "fixed", address: value, internal: false });
  if (assessment.kind !== "tailnet" && assessment.kind !== "private_lan") {
    throw new Error("fixed_private host must be a Tailscale or RFC1918 address");
  }
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}
