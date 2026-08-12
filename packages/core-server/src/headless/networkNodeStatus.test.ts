import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NetworkNodeConfig } from "./networkNodeConfig";
import {
  networkNodeStatusPath,
  probeNetworkNodeStatus,
  readNetworkNodeStatus,
  writeNetworkNodeStatus,
  type NetworkNodeStatusRecord
} from "./networkNodeStatus";

describe("network node status", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("atomically persists a redacted record", async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-network-status-"));
    const record = readyRecord();
    await writeNetworkNodeStatus(root, record);
    await expect(readNetworkNodeStatus(root)).resolves.toEqual({ record });
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(JSON.stringify(await readNetworkNodeStatus(root))).not.toContain("secret");
  });

  it("reports invalid state as unavailable and recovers on the next write", async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-network-status-"));
    await writeFile(networkNodeStatusPath(root), "{broken", "utf8");
    await expect(readNetworkNodeStatus(root)).resolves.toEqual({ errorCode: "status_invalid" });
    await writeNetworkNodeStatus(root, readyRecord());
    await expect(readNetworkNodeStatus(root)).resolves.toMatchObject({ record: { state: "ready" } });
  });

  it("distinguishes a healthy ready process from a stale record", async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-network-status-"));
    const config = fixtureConfig(root);
    await writeNetworkNodeStatus(root, readyRecord());
    await expect(probeNetworkNodeStatus(config, {
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    })).resolves.toMatchObject({ state: "ready", health: "ok", reasonCode: "service_ready" });
    await expect(probeNetworkNodeStatus(config, {
      fetchImpl: async () => { throw new Error("offline"); }
    })).resolves.toMatchObject({ state: "stale", health: "unreachable", reasonCode: "local_health_unreachable" });
  });

  it("marks an orphaned transitional state stale", async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-network-status-"));
    const record: NetworkNodeStatusRecord = {
      ...readyRecord(),
      state: "starting",
      pid: 2_147_483_647,
      localUrl: undefined,
      reasonCode: "service_starting"
    };
    await writeNetworkNodeStatus(root, record);
    await expect(probeNetworkNodeStatus(fixtureConfig(root))).resolves.toMatchObject({
      state: "stale",
      health: "unreachable",
      reasonCode: "process_not_running"
    });
  });

  function readyRecord(): NetworkNodeStatusRecord {
    return {
      version: 1,
      kind: "mathnotes-network-status",
      runtimeId: "runtime-1",
      state: "ready",
      pid: 123,
      exposureMode: "tailscale_serve",
      startedAt: "2026-07-25T00:00:00.000Z",
      updatedAt: "2026-07-25T00:00:01.000Z",
      localUrl: "http://127.0.0.1:1051",
      advertisedUrl: "https://mathnotes.example.ts.net",
      reasonCode: "service_ready"
    };
  }

  function fixtureConfig(userDataDir: string): NetworkNodeConfig {
    return {
      version: 2,
      host: "127.0.0.1",
      port: 1051,
      userDataDir,
      notesRootDir: join(userDataDir, "notes"),
      legacyTokenEnv: "MATHNOTES_HEADLESS_TOKEN",
      exposureMode: "tailscale_serve",
      advertisedUrlEnv: "MATHNOTES_HEADLESS_URL"
    };
  }
});
