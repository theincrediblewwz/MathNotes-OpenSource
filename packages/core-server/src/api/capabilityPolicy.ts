export type CoreApiPrincipal = "anonymous" | "paired-device" | "trusted-local-host";

export type CoreApiCapability =
  | "service.health.read"
  | "pairing.challenge"
  | "pairing.verify"
  | "pairing.exchange"
  | "material.upload"
  | "material.upload.status"
  | "material.recognition.retry"
  | "companion.catalog.read"
  | "companion.session.read"
  | "companion.asset.read"
  | "companion.events.read"
  | "local.workspace.manage"
  | "local.provider.manage"
  | "local.filesystem.manage";

export type NetworkApiRouteId =
  | "health"
  | "pairing.challenge"
  | "pairing.verify"
  | "pairing.exchange"
  | "material.upload"
  | "material.upload.status"
  | "material.recognition.retry"
  | "companion.session.v1"
  | "companion.session.manifest.v2"
  | "companion.session.document.v2"
  | "companion.asset"
  | "companion.session.events"
  | "companion.catalog.events";

export type LocalShellApiRouteId =
  | "local.health"
  | "local.catalog"
  | "local.companion.pairing.challenge"
  | "local.notebook.create"
  | "local.session.create"
  | "local.session.manifest"
  | "local.session.block"
  | "local.session.block.save"
  | "local.session.markdown.append"
  | "local.session.block.lock"
  | "local.session.markdown.preview"
  | "local.markdown.preview"
  | "local.session.blocks.reorder"
  | "local.session.blocks.delete"
  | "local.session.blocks.transfer"
  | "local.session.conflicts"
  | "local.session.conflict"
  | "local.session.conflict.resolve"
  | "local.session.image.import"
  | "local.session.pdf.import"
  | "local.session.recognition.start"
  | "local.session.recognition.status"
  | "local.session.recognition.events"
  | "local.session.recognition.cancel"
  | "local.session.recognition.retry"
  | "local.session.recognition.rerun"
  | "local.session.companion.activity"
  | "local.session.assistant.list"
  | "local.session.assistant.preview"
  | "local.session.assistant.run"
  | "local.session.assistant.start"
  | "local.session.assistant.status"
  | "local.session.assistant.events"
  | "local.session.assistant.cancel"
  | "local.session.assistant.delete"
  | "local.session.assistant.promote"
  | "local.session.export.create"
  | "local.session.export.download"
  | "local.session.asset"
  | "local.provider.status"
  | "local.provider.configure"
  | "local.provider.clear"
  | "local.provider.test"
  | "local.ai.prompt.list"
  | "local.ai.prompt.save"
  | "local.ai.notation.list"
  | "local.ai.notation.save"
  | "local.ai.notation.preview";

export type NetworkApiRoute = Readonly<{
  id: NetworkApiRouteId;
  method: "GET" | "POST";
  path: string;
  capability: CoreApiCapability;
  audience: "public" | "paired-device" | "trusted-host";
}>;

export type LocalShellApiRoute = Readonly<{
  id: LocalShellApiRouteId;
  method: "GET" | "POST";
  path: string;
  capability: "local.workspace.manage" | "local.provider.manage";
}>;

export const NETWORK_API_ROUTES: readonly NetworkApiRoute[] = [
  route("health", "GET", "/api/v1/health", "service.health.read", "public"),
  route("pairing.challenge", "POST", "/api/v2/pairing/challenge", "pairing.challenge", "trusted-host"),
  route("pairing.exchange", "POST", "/api/v2/pairing/exchange", "pairing.exchange", "public"),
  route("pairing.verify", "GET", "/api/v1/pairing/verify", "pairing.verify", "paired-device"),
  route("material.upload", "POST", "/api/v1/uploads", "material.upload", "paired-device"),
  route("material.upload.status", "GET", "/api/v1/uploads/status", "material.upload.status", "paired-device"),
  route("material.recognition.retry", "POST", "/api/v1/uploads/retry-recognition", "material.recognition.retry", "paired-device"),
  route("companion.session.v1", "GET", "/api/v1/companion/session", "companion.session.read", "paired-device"),
  route("companion.session.manifest.v2", "GET", "/api/v2/companion/session/manifest", "companion.session.read", "paired-device"),
  route("companion.session.document.v2", "GET", "/api/v2/companion/session/document", "companion.session.read", "paired-device"),
  route("companion.asset", "GET", "/api/v1/companion/asset", "companion.asset.read", "paired-device"),
  route("companion.session.events", "GET", "/api/v1/companion/events", "companion.events.read", "paired-device"),
  route("companion.catalog.events", "GET", "/api/v1/companion/catalog-events", "companion.events.read", "paired-device")
];

export const LOCAL_SHELL_API_ROUTES: readonly LocalShellApiRoute[] = [
  { id: "local.health", method: "GET", path: "/local/v1/health", capability: "local.workspace.manage" },
  { id: "local.catalog", method: "GET", path: "/local/v1/catalog", capability: "local.workspace.manage" },
  { id: "local.companion.pairing.challenge", method: "POST", path: "/local/v1/companion/pairing-challenge", capability: "local.workspace.manage" },
  { id: "local.notebook.create", method: "POST", path: "/local/v1/notebooks", capability: "local.workspace.manage" },
  { id: "local.session.create", method: "POST", path: "/local/v1/sessions", capability: "local.workspace.manage" },
  { id: "local.session.manifest", method: "GET", path: "/local/v1/session/manifest", capability: "local.workspace.manage" },
  { id: "local.session.block", method: "GET", path: "/local/v1/session/block", capability: "local.workspace.manage" },
  { id: "local.session.block.save", method: "POST", path: "/local/v1/session/block", capability: "local.workspace.manage" },
  { id: "local.session.markdown.append", method: "POST", path: "/local/v1/session/markdown", capability: "local.workspace.manage" },
  { id: "local.session.block.lock", method: "POST", path: "/local/v1/session/block/lock", capability: "local.workspace.manage" },
  { id: "local.session.markdown.preview", method: "POST", path: "/local/v1/session/markdown/preview", capability: "local.workspace.manage" },
  { id: "local.markdown.preview", method: "POST", path: "/local/v1/markdown/preview", capability: "local.workspace.manage" },
  { id: "local.session.blocks.reorder", method: "POST", path: "/local/v1/session/blocks/reorder", capability: "local.workspace.manage" },
  { id: "local.session.blocks.delete", method: "POST", path: "/local/v1/session/blocks/delete", capability: "local.workspace.manage" },
  { id: "local.session.blocks.transfer", method: "POST", path: "/local/v1/session/blocks/transfer", capability: "local.workspace.manage" },
  { id: "local.session.conflicts", method: "GET", path: "/local/v1/session/conflicts", capability: "local.workspace.manage" },
  { id: "local.session.conflict", method: "GET", path: "/local/v1/session/conflict", capability: "local.workspace.manage" },
  { id: "local.session.conflict.resolve", method: "POST", path: "/local/v1/session/conflict/resolve", capability: "local.workspace.manage" },
  { id: "local.session.image.import", method: "POST", path: "/local/v1/session/image", capability: "local.workspace.manage" },
  { id: "local.session.pdf.import", method: "POST", path: "/local/v1/session/pdf", capability: "local.workspace.manage" },
  { id: "local.session.recognition.start", method: "POST", path: "/local/v1/session/recognition", capability: "local.workspace.manage" },
  { id: "local.session.recognition.status", method: "GET", path: "/local/v1/session/recognition", capability: "local.workspace.manage" },
  { id: "local.session.recognition.events", method: "GET", path: "/local/v1/session/recognition/events", capability: "local.workspace.manage" },
  { id: "local.session.recognition.cancel", method: "POST", path: "/local/v1/session/recognition/cancel", capability: "local.workspace.manage" },
  { id: "local.session.recognition.retry", method: "POST", path: "/local/v1/session/recognition/retry", capability: "local.workspace.manage" },
  { id: "local.session.recognition.rerun", method: "POST", path: "/local/v1/session/recognition/rerun", capability: "local.workspace.manage" },
  { id: "local.session.companion.activity", method: "GET", path: "/local/v1/session/companion-activity", capability: "local.workspace.manage" },
  { id: "local.session.assistant.list", method: "GET", path: "/local/v1/session/assistant", capability: "local.provider.manage" },
  { id: "local.session.assistant.preview", method: "POST", path: "/local/v1/session/assistant/preview", capability: "local.provider.manage" },
  { id: "local.session.assistant.run", method: "POST", path: "/local/v1/session/assistant", capability: "local.provider.manage" },
  { id: "local.session.assistant.start", method: "POST", path: "/local/v1/session/assistant/start", capability: "local.provider.manage" },
  { id: "local.session.assistant.status", method: "GET", path: "/local/v1/session/assistant/status", capability: "local.provider.manage" },
  { id: "local.session.assistant.events", method: "GET", path: "/local/v1/session/assistant/events", capability: "local.provider.manage" },
  { id: "local.session.assistant.cancel", method: "POST", path: "/local/v1/session/assistant/cancel", capability: "local.provider.manage" },
  { id: "local.session.assistant.delete", method: "POST", path: "/local/v1/session/assistant/delete", capability: "local.provider.manage" },
  { id: "local.session.assistant.promote", method: "POST", path: "/local/v1/session/assistant/promote", capability: "local.provider.manage" },
  { id: "local.session.export.create", method: "POST", path: "/local/v1/session/export", capability: "local.workspace.manage" },
  { id: "local.session.export.download", method: "GET", path: "/local/v1/session/export", capability: "local.workspace.manage" },
  { id: "local.session.asset", method: "GET", path: "/local/v1/session/asset", capability: "local.workspace.manage" },
  { id: "local.provider.status", method: "GET", path: "/local/v1/provider", capability: "local.provider.manage" },
  { id: "local.provider.configure", method: "POST", path: "/local/v1/provider", capability: "local.provider.manage" },
  { id: "local.provider.clear", method: "POST", path: "/local/v1/provider/clear", capability: "local.provider.manage" },
  { id: "local.provider.test", method: "POST", path: "/local/v1/provider/test", capability: "local.provider.manage" },
  { id: "local.ai.prompt.list", method: "GET", path: "/local/v1/ai/prompt-templates", capability: "local.provider.manage" },
  { id: "local.ai.prompt.save", method: "POST", path: "/local/v1/ai/prompt-templates", capability: "local.provider.manage" },
  { id: "local.ai.notation.list", method: "GET", path: "/local/v1/ai/notation-profiles", capability: "local.provider.manage" },
  { id: "local.ai.notation.save", method: "POST", path: "/local/v1/ai/notation-profiles", capability: "local.provider.manage" },
  { id: "local.ai.notation.preview", method: "POST", path: "/local/v1/ai/notation-preview", capability: "local.provider.manage" }
];

const routeByRequest = new Map(NETWORK_API_ROUTES.map((candidate) => [routeKey(candidate.method, candidate.path), candidate]));
const localRouteByRequest = new Map(
  LOCAL_SHELL_API_ROUTES.map((candidate) => [routeKey(candidate.method, candidate.path), candidate])
);

const grants: Readonly<Record<CoreApiPrincipal, ReadonlySet<CoreApiCapability>>> = {
  anonymous: new Set(["service.health.read", "pairing.exchange"]),
  "paired-device": new Set([
    "service.health.read",
    "pairing.verify",
    "pairing.exchange",
    "material.upload",
    "material.upload.status",
    "material.recognition.retry",
    "companion.catalog.read",
    "companion.session.read",
    "companion.asset.read",
    "companion.events.read"
  ]),
  "trusted-local-host": new Set([
    "service.health.read",
    "pairing.challenge",
    "pairing.verify",
    "pairing.exchange",
    "material.upload",
    "material.upload.status",
    "material.recognition.retry",
    "companion.catalog.read",
    "companion.session.read",
    "companion.asset.read",
    "companion.events.read",
    "local.workspace.manage",
    "local.provider.manage",
    "local.filesystem.manage"
  ])
};

export function resolveNetworkApiRoute(method: string, path: string): NetworkApiRoute | undefined {
  return routeByRequest.get(routeKey(method, path));
}

export function resolveLocalShellApiRoute(method: string, path: string): LocalShellApiRoute | undefined {
  return localRouteByRequest.get(routeKey(method, path));
}

export function authorizeCoreApiCapability(
  principal: CoreApiPrincipal,
  capability: CoreApiCapability
): boolean {
  return grants[principal].has(capability);
}

export function principalForNetworkRoute(
  routeContract: NetworkApiRoute,
  hasValidHostToken: boolean,
  hasValidDeviceToken = false
): CoreApiPrincipal {
  if (routeContract.audience === "public") return "anonymous";
  if (routeContract.audience === "trusted-host") {
    return hasValidHostToken ? "trusted-local-host" : "anonymous";
  }
  if (hasValidHostToken) return "trusted-local-host";
  return hasValidDeviceToken ? "paired-device" : "anonymous";
}

export function validateNetworkApiContracts(routes: readonly NetworkApiRoute[] = NETWORK_API_ROUTES): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const candidate of routes) {
    const key = routeKey(candidate.method, candidate.path);
    if (keys.has(key)) errors.push(`duplicate route: ${key}`);
    keys.add(key);
    if (candidate.capability.startsWith("local.")) {
      errors.push(`local-only capability exposed over network: ${candidate.capability}`);
    }
    const expectedPrincipal = candidate.audience === "public"
      ? "anonymous"
      : candidate.audience === "trusted-host" ? "trusted-local-host" : "paired-device";
    if (!authorizeCoreApiCapability(expectedPrincipal, candidate.capability)) {
      errors.push(`audience cannot use declared capability: ${candidate.id}`);
    }
    if (candidate.audience === "paired-device" && authorizeCoreApiCapability("anonymous", candidate.capability)) {
      errors.push(`paired route grants anonymous access: ${candidate.id}`);
    }
    if (candidate.audience === "trusted-host" && authorizeCoreApiCapability("paired-device", candidate.capability)) {
      errors.push(`trusted-host route grants paired-device access: ${candidate.id}`);
    }
  }
  return errors;
}

function route(
  id: NetworkApiRouteId,
  method: NetworkApiRoute["method"],
  path: string,
  capability: CoreApiCapability,
  audience: NetworkApiRoute["audience"]
): NetworkApiRoute {
  return { id, method, path, capability, audience };
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}
