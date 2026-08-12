export type SameOriginGatewayCapabilities = Readonly<{
  schemaVersion: 1;
  gateway: "mathnotes-standalone-v1";
  recognitions: Readonly<{
    endpoint: "/v1/recognitions";
    protocolVersion: 1;
    auth: "bearer";
  }>;
}>;

const CAPABILITIES_PATH = "/v1/capabilities";
const GATEWAY_ID = "mathnotes-standalone-v1";
const RECOGNITIONS_ENDPOINT = "/v1/recognitions";

/**
 * Probes the same-origin standalone gateway. Returns the normalized origin
 * only when the capability response is valid and was not redirected away.
 * Any network failure, non-OK status or malformed payload keeps the current
 * local-fake behavior by resolving to `undefined`.
 */
export async function discoverSameOriginGateway(input: Readonly<{
  origin: string;
  fetchImpl?: typeof fetch;
}>): Promise<string | undefined> {
  const origin = new URL(input.origin.trim()).origin;
  try {
    const response = await (input.fetchImpl ?? fetch)(`${origin}${CAPABILITIES_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) return undefined;
    if (new URL(response.url).origin !== origin) return undefined;
    const payload: unknown = await response.json();
    return isValidSameOriginGatewayCapabilities(payload) ? origin : undefined;
  } catch {
    return undefined;
  }
}

export function isValidSameOriginGatewayCapabilities(
  value: unknown
): value is SameOriginGatewayCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (payload.schemaVersion !== 1 || payload.gateway !== GATEWAY_ID) return false;
  const recognitions = payload.recognitions;
  if (!recognitions || typeof recognitions !== "object" || Array.isArray(recognitions)) return false;
  const route = recognitions as Record<string, unknown>;
  return route.endpoint === RECOGNITIONS_ENDPOINT &&
    route.protocolVersion === 1 &&
    route.auth === "bearer";
}
