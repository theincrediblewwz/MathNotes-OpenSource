#!/usr/bin/env node
import { isProcessAlive, parseSidecarParentPid, startMacosSidecar } from "./macosSidecar";

const token = requiredEnvironment("MATHNOTES_LOCAL_TOKEN");
const companionEnabled = process.env.MATHNOTES_COMPANION_ENABLED?.trim() !== "0";
const running = await startMacosSidecar({
  token,
  userDataDir: requiredEnvironment("MATHNOTES_USER_DATA_DIR"),
  notesRootDir: requiredEnvironment("MATHNOTES_NOTES_ROOT_DIR"),
  tempDir: requiredEnvironment("MATHNOTES_TEMP_DIR"),
  appVersion: process.env.MATHNOTES_APP_VERSION?.trim() || "phase1a-dev",
  companionHost: companionEnabled ? {
    token: requiredEnvironment("MATHNOTES_COMPANION_TOKEN"),
    port: optionalPort(process.env.MATHNOTES_COMPANION_PORT, 1051),
    pwaStaticRootDir: process.env.MATHNOTES_PWA_STATIC_ROOT_DIR?.trim() || undefined
  } : undefined
});

process.stdout.write(`${JSON.stringify(running.ready)}\n`);

let stopping = false;
const parentPid = parseSidecarParentPid(process.env.MATHNOTES_PARENT_PID);
const parentWatchdog = parentPid === undefined ? undefined : setInterval(() => {
  if (!isProcessAlive(parentPid)) void shutdown(0);
}, 750);
async function shutdown(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (parentWatchdog) clearInterval(parentWatchdog);
  try {
    await running.stop();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`[error] macOS sidecar shutdown failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalPort(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("MATHNOTES_COMPANION_PORT must be a valid TCP port");
  }
  return port;
}
