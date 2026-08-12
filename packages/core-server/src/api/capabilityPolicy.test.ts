import { describe, expect, it } from "vitest";
import {
  NETWORK_API_ROUTES,
  LOCAL_SHELL_API_ROUTES,
  authorizeCoreApiCapability,
  principalForNetworkRoute,
  resolveNetworkApiRoute,
  resolveLocalShellApiRoute,
  validateNetworkApiContracts,
  type NetworkApiRoute
} from "./capabilityPolicy";

describe("Core API capability policy", () => {
  it("keeps the network inventory explicit and valid", () => {
    expect(NETWORK_API_ROUTES.map((route) => route.id)).toEqual([
      "health",
      "pairing.challenge",
      "pairing.exchange",
      "pairing.verify",
      "material.upload",
      "material.upload.status",
      "material.recognition.retry",
      "companion.session.v1",
      "companion.session.manifest.v2",
      "companion.session.document.v2",
      "companion.asset",
      "companion.session.events",
      "companion.catalog.events"
    ]);
    expect(validateNetworkApiContracts()).toEqual([]);
  });

  it("denies unknown method/path combinations by default", () => {
    expect(resolveNetworkApiRoute("DELETE", "/api/v1/companion/session")).toBeUndefined();
    expect(resolveNetworkApiRoute("GET", "/api/v1/provider/config")).toBeUndefined();
  });

  it("requires a paired device for every non-public network capability", () => {
    for (const route of NETWORK_API_ROUTES) {
      const principal = principalForNetworkRoute(route, false, false);
      expect(authorizeCoreApiCapability(principal, route.capability)).toBe(route.audience === "public");
    }
  });

  it("reserves local management capabilities for the trusted host", () => {
    const challengeRoute = resolveNetworkApiRoute("POST", "/api/v2/pairing/challenge");
    expect(challengeRoute).toBeDefined();
    expect(principalForNetworkRoute(challengeRoute!, false, true)).toBe("anonymous");
    expect(principalForNetworkRoute(challengeRoute!, true, false)).toBe("trusted-local-host");
    expect(authorizeCoreApiCapability("paired-device", "pairing.challenge")).toBe(false);
    expect(authorizeCoreApiCapability("trusted-local-host", "pairing.challenge")).toBe(true);
    expect(authorizeCoreApiCapability("paired-device", "local.workspace.manage")).toBe(false);
    expect(authorizeCoreApiCapability("paired-device", "local.provider.manage")).toBe(false);
    expect(authorizeCoreApiCapability("trusted-local-host", "local.workspace.manage")).toBe(true);
    expect(authorizeCoreApiCapability("trusted-local-host", "local.provider.manage")).toBe(true);
  });

  it("keeps local shell routes on a separate inventory", () => {
    expect(LOCAL_SHELL_API_ROUTES.map((route) => route.id)).toEqual([
      "local.health",
      "local.catalog",
      "local.companion.pairing.challenge",
      "local.notebook.create",
      "local.session.create",
      "local.session.manifest",
      "local.session.block",
      "local.session.block.save",
      "local.session.markdown.append",
      "local.session.block.lock",
      "local.session.markdown.preview",
      "local.markdown.preview",
      "local.session.blocks.reorder",
      "local.session.blocks.delete",
      "local.session.blocks.transfer",
      "local.session.conflicts",
      "local.session.conflict",
      "local.session.conflict.resolve",
      "local.session.image.import",
      "local.session.pdf.import",
      "local.session.recognition.start",
      "local.session.recognition.status",
      "local.session.recognition.events",
      "local.session.recognition.cancel",
      "local.session.recognition.retry",
      "local.session.recognition.rerun",
      "local.session.companion.activity",
      "local.session.assistant.list",
      "local.session.assistant.preview",
      "local.session.assistant.run",
      "local.session.assistant.start",
      "local.session.assistant.status",
      "local.session.assistant.events",
      "local.session.assistant.cancel",
      "local.session.assistant.delete",
      "local.session.assistant.promote",
      "local.session.selection-edit.propose",
      "local.session.selection-edit.apply",
      "local.session.selection-edit.cancel",
      "local.session.export.create",
      "local.session.export.download",
      "local.session.asset",
      "local.provider.status",
      "local.provider.configure",
      "local.provider.clear",
      "local.provider.test",
      "local.ai.prompt.list",
      "local.ai.prompt.save",
      "local.ai.notation.list",
      "local.ai.notation.save",
      "local.ai.notation.preview"
    ]);
    expect(resolveLocalShellApiRoute("GET", "/local/v1/health")?.capability).toBe("local.workspace.manage");
    expect(resolveLocalShellApiRoute("GET", "/local/v1/catalog")?.capability).toBe("local.workspace.manage");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/companion/pairing-challenge")?.id)
      .toBe("local.companion.pairing.challenge");
    expect(resolveLocalShellApiRoute("GET", "/local/v1/session/manifest")?.capability).toBe("local.workspace.manage");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/conflict/resolve")?.id)
      .toBe("local.session.conflict.resolve");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/blocks/reorder")?.id)
      .toBe("local.session.blocks.reorder");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/blocks/delete")?.id)
      .toBe("local.session.blocks.delete");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/markdown/preview")?.id)
      .toBe("local.session.markdown.preview");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/markdown")?.id)
      .toBe("local.session.markdown.append");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/markdown/preview")?.id)
      .toBe("local.markdown.preview");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/blocks/transfer")?.id)
      .toBe("local.session.blocks.transfer");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/image")?.id).toBe("local.session.image.import");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/pdf")?.id).toBe("local.session.pdf.import");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/recognition")?.id).toBe("local.session.recognition.start");
    expect(resolveLocalShellApiRoute("GET", "/local/v1/session/recognition/events")?.id).toBe("local.session.recognition.events");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/recognition/rerun")?.id)
      .toBe("local.session.recognition.rerun");
    expect(resolveLocalShellApiRoute("GET", "/local/v1/session/companion-activity")?.id)
      .toBe("local.session.companion.activity");
    expect(resolveLocalShellApiRoute("GET", "/local/v1/session/assistant")?.id).toBe("local.session.assistant.list");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/assistant")?.id).toBe("local.session.assistant.run");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/assistant/start")?.id)
      .toBe("local.session.assistant.start");
    expect(resolveLocalShellApiRoute("GET", "/local/v1/session/assistant/status")?.id)
      .toBe("local.session.assistant.status");
    expect(resolveLocalShellApiRoute("GET", "/local/v1/session/assistant/events")?.id)
      .toBe("local.session.assistant.events");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/assistant/cancel")?.id)
      .toBe("local.session.assistant.cancel");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/assistant/preview")?.id)
      .toBe("local.session.assistant.preview");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/selection-edit")?.id)
      .toBe("local.session.selection-edit.propose");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/selection-edit/apply")?.id)
      .toBe("local.session.selection-edit.apply");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/selection-edit/cancel")?.id)
      .toBe("local.session.selection-edit.cancel");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/session/export")?.id).toBe("local.session.export.create");
    expect(resolveLocalShellApiRoute("GET", "/local/v1/session/export")?.id).toBe("local.session.export.download");
    expect(resolveLocalShellApiRoute("GET", "/local/v1/provider")?.capability).toBe("local.provider.manage");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/provider/test")?.id).toBe("local.provider.test");
    expect(resolveLocalShellApiRoute("GET", "/local/v1/ai/prompt-templates")?.id).toBe("local.ai.prompt.list");
    expect(resolveLocalShellApiRoute("POST", "/local/v1/ai/notation-preview")?.capability).toBe("local.provider.manage");
    expect(resolveNetworkApiRoute("GET", "/local/v1/health")).toBeUndefined();
    expect(resolveLocalShellApiRoute("GET", "/api/v1/health")).toBeUndefined();
  });

  it("rejects accidental network exposure of a local-only capability", () => {
    const invalid: NetworkApiRoute = {
      id: "health",
      method: "GET",
      path: "/api/v1/provider/config",
      capability: "local.provider.manage",
      audience: "public"
    };
    expect(validateNetworkApiContracts([invalid])).toContain(
      "local-only capability exposed over network: local.provider.manage"
    );
  });
});
