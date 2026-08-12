import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { NetworkNodeConfig } from "./networkNodeConfig";
import { readNetworkNodeConfig } from "./networkNodeConfig";
import { startHeadlessNetworkNode } from "./networkNode";
import { resolveNetworkNodeRuntime } from "./networkNodeRuntime";
import {
  probeNetworkNodeStatus,
  writeNetworkNodeStatus,
  type NetworkNodeStatusRecord
} from "./networkNodeStatus";

void main().catch((error) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const configArg = process.argv.indexOf("--config");
  if (configArg < 0 || !process.argv[configArg + 1]) {
    process.stderr.write("Usage: mathnotes-network-node --config <absolute-json-path>\n");
    process.exitCode = 2;
    return;
  }
  const config = await readNetworkNodeConfig(resolve(process.argv[configArg + 1]));
  if (process.argv.includes("--check")) {
    const runtime = resolveNetworkNodeRuntime(config);
    writeJsonLine(runtime.report);
    return;
  }
  if (process.argv.includes("--status")) {
    const status = await probeNetworkNodeStatus(config);
    writeJsonLine(status);
    if (status.state !== "ready") process.exitCode = 3;
    return;
  }
  await runNode(config);
}

async function runNode(config: NetworkNodeConfig): Promise<void> {
  const runtimeId = randomUUID();
  const startedAt = new Date().toISOString();
  const baseStatus = {
    version: 1 as const,
    kind: "mathnotes-network-status" as const,
    runtimeId,
    pid: process.pid,
    exposureMode: config.exposureMode,
    startedAt
  };
  await writeState(config, { ...baseStatus, state: "starting", updatedAt: startedAt, reasonCode: "service_starting" });
  let node: Awaited<ReturnType<typeof startHeadlessNetworkNode>> | undefined;
  try {
    node = await startHeadlessNetworkNode(config);
  } catch (error) {
    await writeState(config, {
      ...baseStatus,
      state: "failed",
      updatedAt: new Date().toISOString(),
      reasonCode: "startup_failed"
    }).catch(() => undefined);
    throw error;
  }
  if (!node) throw new Error("Network node failed to start");
  const readyStatus: NetworkNodeStatusRecord = {
    ...baseStatus,
    state: "ready",
    updatedAt: new Date().toISOString(),
    localUrl: node.localUrl,
    advertisedUrl: node.advertisedUrl,
    reasonCode: "service_ready"
  };
  try {
    await writeState(config, readyStatus);
  } catch (error) {
    await node.stop().catch(() => undefined);
    await writeState(config, {
      ...baseStatus,
      state: "failed",
      updatedAt: new Date().toISOString(),
      reasonCode: "status_persist_failed"
    }).catch(() => undefined);
    throw error;
  }
  writeJsonLine({
    version: 1,
    kind: "mathnotes-network-ready",
    host: node.started.host,
    port: node.started.port,
    url: node.advertisedUrl,
    localUrl: node.localUrl,
    advertisedUrl: node.advertisedUrl,
    exposureMode: config.exposureMode,
    status: "ready"
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await writeState(config, {
      ...readyStatus,
      state: "stopping",
      updatedAt: new Date().toISOString(),
      reasonCode: "service_stopping"
    }).catch(() => undefined);
    let failed = false;
    try {
      await node.stop();
      await writeState(config, {
        ...readyStatus,
        state: "stopped",
        updatedAt: new Date().toISOString(),
        reasonCode: "service_stopped"
      });
    } catch {
      failed = true;
      await writeState(config, {
        ...readyStatus,
        state: "failed",
        updatedAt: new Date().toISOString(),
        reasonCode: "shutdown_failed"
      }).catch(() => undefined);
    } finally {
      if (process.connected) process.disconnect();
      process.exitCode = failed ? 1 : 0;
    }
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("message", (message) => {
    if (isShutdownMessage(message)) void stop();
  });
}

async function writeState(config: NetworkNodeConfig, record: NetworkNodeStatusRecord): Promise<void> {
  await writeNetworkNodeStatus(config.userDataDir, record);
}

function writeJsonLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isShutdownMessage(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    "type" in value && (value as { type?: unknown }).type === "mathnotes-shutdown";
}

function safeErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
    return "Network node config or runtime file was not found";
  }
  const message = error instanceof Error ? error.message : String(error);
  return /[A-Za-z]:\\|\/Users\/|\/home\//.test(message)
    ? "Network node operation failed; inspect the local status file"
    : message;
}
