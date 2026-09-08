import { SessionWriteCoordinator } from "../session/sessionWriteCoordinator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceSyncService } from "./workspaceSyncService";

// Model a slow filesystem: writeFile creates its directory entry before its
// asynchronous write finishes. Readers must never observe that partial identity.
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    const [path, data, options] = args;
    if (typeof path !== "string" || typeof data !== "string" || !path.includes("workspace-host-id")) return fs.writeFile(...args);
    const settings = typeof options === "string" ? { encoding: options } : options ?? {};
    const handle = await fs.open(path, settings.flag ?? "w", settings.mode);
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      await handle.writeFile(data, options);
    } finally { await handle.close(); }
  } };
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("never exposes a partially written host identity to a second service instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "mathnotes-identity-publication-")); roots.push(root);
  const services = Array.from({ length: 12 }, () => new WorkspaceSyncService(join(root, "notes"), join(root, "state"), (n, s, op) => new SessionWriteCoordinator().run(n, s, op)));
  // allSettled ensures teardown cannot race the still-writing winner on failure.
  const results = await Promise.allSettled(services.map(service => service.identity()));
  expect(results.every(result => result.status === "fulfilled"), JSON.stringify(results)).toBe(true);
  const ids = results.flatMap(result => result.status === "fulfilled" ? [result.value.hostId] : []);
  expect(new Set(ids).size).toBe(1);
  expect(ids[0]).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
});
