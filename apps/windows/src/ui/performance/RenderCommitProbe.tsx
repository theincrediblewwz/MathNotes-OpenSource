import { useLayoutEffect, type ReactNode } from "react";

const renderCommitLabStorageKey = "mathnotes:render-commit-lab";

type RenderCommitMeasurement = {
  commits: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
};

export type RenderCommitLabSnapshot = Record<string, RenderCommitMeasurement>;

type RenderCommitLabApi = {
  enabled: boolean;
  reset: () => void;
  snapshot: () => RenderCommitLabSnapshot;
};

declare global {
  interface Window {
    __mathNotesRenderCommitLab?: RenderCommitLabApi;
  }
}

const measurements = new Map<string, RenderCommitMeasurement>();

function isRenderCommitLabEnabled(): boolean {
  try {
    return window.localStorage?.getItem(renderCommitLabStorageKey) === "on";
  } catch {
    return false;
  }
}

function resetMeasurements(): void {
  measurements.clear();
}

function snapshotMeasurements(): RenderCommitLabSnapshot {
  return Object.fromEntries(
    Array.from(measurements.entries(), ([id, measurement]) => [id, { ...measurement }])
  );
}

function recordMeasurement(id: string, durationMs: number): void {
  const previous = measurements.get(id);
  measurements.set(id, {
    commits: (previous?.commits ?? 0) + 1,
    totalMs: (previous?.totalMs ?? 0) + durationMs,
    maxMs: Math.max(previous?.maxMs ?? 0, durationMs),
    lastMs: durationMs
  });
}

if (typeof window !== "undefined") {
  window.__mathNotesRenderCommitLab = {
    enabled: isRenderCommitLabEnabled(),
    reset: resetMeasurements,
    snapshot: snapshotMeasurements
  };
}

export function useRenderCommitProbe(id: string): void {
  const enabled = isRenderCommitLabEnabled();
  const renderStartedAt = enabled ? performance.now() : 0;

  useLayoutEffect(() => {
    if (!enabled) return;
    recordMeasurement(id, performance.now() - renderStartedAt);
  });
}

export function RenderCommitProbe({ children, id }: { children: ReactNode; id: string }) {
  useRenderCommitProbe(id);

  return children;
}
