import type { NetworkNodeConfig } from "./networkNodeConfig";

export type NetworkNodePreflightReport = Readonly<{
  version: 1;
  kind: "mathnotes-network-preflight";
  ok: true;
  configVersion: 1 | 2;
  exposureMode: NetworkNodeConfig["exposureMode"];
  listenHost: string;
  requestedPort: number;
  advertisedUrl?: string;
}>;

export type ResolvedNetworkNodeRuntime = Readonly<{
  token: string;
  advertisedUrl?: string;
  report: NetworkNodePreflightReport;
}>;

export function resolveNetworkNodeRuntime(
  config: NetworkNodeConfig,
  environment: NodeJS.ProcessEnv = process.env
): ResolvedNetworkNodeRuntime {
  const token = environment[config.legacyTokenEnv]?.trim();
  if (!token) throw new Error(`Missing pairing token environment variable: ${config.legacyTokenEnv}`);
  const advertisedUrl = config.exposureMode === "tailscale_serve"
    ? advertisedUrlFromEnvironment(config, environment)
    : undefined;
  return {
    token,
    advertisedUrl,
    report: {
      version: 1,
      kind: "mathnotes-network-preflight",
      ok: true,
      configVersion: config.version,
      exposureMode: config.exposureMode,
      listenHost: config.host,
      requestedPort: config.port,
      ...(advertisedUrl ? { advertisedUrl } : {})
    }
  };
}

function advertisedUrlFromEnvironment(
  config: NetworkNodeConfig,
  environment: NodeJS.ProcessEnv
): string {
  const variableName = config.advertisedUrlEnv;
  if (!variableName) throw new Error("tailscale_serve requires advertisedUrlEnv");
  const value = environment[variableName]?.trim();
  if (!value) throw new Error(`Missing advertised URL environment variable: ${variableName}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must contain an HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(`${variableName} must contain an HTTPS origin`);
  }
  return url.origin;
}
