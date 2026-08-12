import { describe, expect, it } from "vitest";
import {
  providerRuntimeProgressTitle,
  providerRuntimeStateForProvider,
  providerRuntimeSummaryTitle
} from "./providerRuntimeState";

describe("provider runtime state", () => {
  it("keeps Codex-specific runtime copy for Codex CLI", () => {
    const state = providerRuntimeStateForProvider("codex_cli", {
      status: "ready",
      progress: 100,
      detail: "Codex CLI runtime 已启动。",
      updatedAt: "2026-07-02T00:00:00.000Z"
    });

    if (!state) throw new Error("Expected Codex provider runtime state");

    expect(state).toEqual({
      providerId: "codex_cli",
      status: "ready",
      progress: 100,
      detail: "Codex CLI runtime 已启动。",
      updatedAt: "2026-07-02T00:00:00.000Z"
    });
    expect(providerRuntimeSummaryTitle(state)).toBe("Codex CLI 启动成功");
    expect(providerRuntimeProgressTitle(state)).toBe("Codex CLI 已就绪");
  });

  it("uses API provider copy outside Codex CLI", () => {
    const state = {
      providerId: "mimo_2_5" as const,
      status: "ready" as const,
      progress: 100,
      detail: "Mimo API provider ready",
      updatedAt: "2026-07-02T00:00:00.000Z"
    };

    expect(providerRuntimeSummaryTitle(state)).toBe("Mimo v2.5 API 已就绪");
    expect(providerRuntimeProgressTitle(state)).toBe("Mimo v2.5 API 已就绪");
  });

  it("does not synthesize stopped API runtime noise when no local runtime exists", () => {
    const state = providerRuntimeStateForProvider("mimo_2_5", {
      status: "stopped",
      progress: 0,
      detail: "Codex CLI runtime 未启动。",
      updatedAt: "2026-07-02T00:00:00.000Z"
    });

    expect(state).toBeUndefined();
  });
});
