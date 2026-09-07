import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";

export function failureKinds(text) {
  // Never return raw stderr: it may include private paths or credential values.
  const kinds = ["EACCES", "EPERM", "EADDRINUSE", "ENOENT", "ENOSPC", "EROFS", "EMFILE",
    "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "SyntaxError"];
  return kinds.filter((kind) => new RegExp(`\\b${kind}\\b`).test(text));
}

export async function probeSidecar({ executable, script, companion, pwaRoot, timeoutMs = 15_000 }) {
  const root = await mkdtemp(path.join(tmpdir(), "mathnotes-connection-check-"));
  const token = randomBytes(32).toString("hex");
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("MATHNOTES_") || key === "NODE_OPTIONS" || key === "NODE_PATH") delete environment[key];
  }
  Object.assign(environment, {
    MATHNOTES_LOCAL_TOKEN: token,
    MATHNOTES_COMPANION_TOKEN: randomBytes(32).toString("hex"),
    MATHNOTES_COMPANION_ENABLED: companion ? "1" : "0",
    MATHNOTES_COMPANION_PORT: "1051",
    MATHNOTES_USER_DATA_DIR: path.join(root, "user-data"),
    MATHNOTES_NOTES_ROOT_DIR: path.join(root, "notes"),
    MATHNOTES_TEMP_DIR: path.join(root, "temp"),
    MATHNOTES_PARENT_PID: String(process.pid),
    MATHNOTES_APP_VERSION: "isolated-connection-diagnostic"
  });
  if (pwaRoot) environment.MATHNOTES_PWA_STATIC_ROOT_DIR = pwaRoot;
  const result = { state: "starting", errors: [] };
  let stderr = "";
  let stdout = "";
  let completed = false;
  const child = spawn(executable, [script], { env: environment, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  const finish = () => {
    if (completed) return;
    completed = true;
    child.kill("SIGTERM");
  };
  const timer = setTimeout(() => { result.state = "timeout"; finish(); }, timeoutMs);
  const forceTimer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs + 2_000);
  child.on("error", (error) => { result.state = "launch_failed"; stderr += error.code ?? ""; });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-65_536); });
  child.stdout.on("data", (chunk) => {
    if (completed || result.state !== "starting") return;
    stdout += chunk.toString();
    if (stdout.length > 16_384) { result.state = "invalid_ready"; finish(); return; }
    const newline = stdout.indexOf("\n");
    if (newline < 0) return;
    try {
      const ready = JSON.parse(stdout.slice(0, newline));
      if (ready.type !== "mathnotes.ready" || ready.host !== "127.0.0.1"
        || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65_535
        || (companion && (!Number.isInteger(ready.companionHost?.port)
          || ready.companionHost.port < 1 || ready.companionHost.port > 65_535))) {
        throw new Error("invalid_ready");
      }
      result.state = "checking_health";
      if (companion) result.portFallback = ready.companionHost.port !== 1051;
      const request = http.get({ hostname: "127.0.0.1", port: ready.port, path: "/local/v1/health",
        headers: { Authorization: `Bearer ${token}` }, timeout: 3_000 }, (response) => {
        response.resume();
        if (!completed) { result.state = response.statusCode === 200 ? "ready" : "health_rejected"; finish(); }
      });
      request.on("timeout", () => request.destroy());
      request.on("error", () => { if (!completed) { result.state = "health_failed"; finish(); } });
    } catch { result.state = "invalid_ready"; finish(); }
  });
  try {
    const exit = await closed;
    clearTimeout(timer);
    clearTimeout(forceTimer);
    if (result.state === "starting" || result.state === "checking_health") result.state = "exited_before_ready";
    result.errors = failureKinds(stderr);
    // Successful probes are terminated by this diagnostic; do not call that a crash.
    if (result.state !== "ready") { result.exitCode = exit.code; result.signal = exit.signal; }
    return result;
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
    // Only the exact temporary directory created above, after its child has exited.
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const appPath = process.argv[2];
  if (!appPath || process.platform !== "darwin") throw new Error("MACOS_APP_PATH_REQUIRED");
  const runtime = path.join(appPath, "Contents/Resources/MathNotesRuntime");
  const script = path.join(runtime, "core-server.mjs");
  const digest = createHash("sha256").update(await readFile(script)).digest("hex");
  const report = { diagnosticVersion: 1, sidecarSHA256: digest,
    matchesFc89178: digest === "c3b9ac5793bd3edf60bf64dbc417c4e63b88c435fc244e7599fc2ad47d7ee1d3",
    runtimeVersion: process.version, architecture: process.arch, isolatedTemporaryDataOnly: true };
  const options = { executable: process.execPath, script, pwaRoot: path.join(appPath, "Contents/Resources/MathNotesPWA") };
  report.localCore = await probeSidecar({ ...options, companion: false });
  report.phoneHost = await probeSidecar({ ...options, companion: true });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.log("DIAGNOSTIC_FAILED_NO_PRIVATE_DETAILS"); process.exitCode = 1; });
}
