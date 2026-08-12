#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
console.log(`Usage: node test_tool/codex_app_server_probe.mjs [--thread] [--image <path>] [--timeout-ms <ms>]

Starts Codex CLI app-server through WSL, connects to its WebSocket endpoint, and sends initialize.
With --thread, it also starts a temporary ephemeral thread without calling the model.
With --image, it also starts a temporary thread and sends a localImage turn for manual protocol validation.`);
  process.exit(0);
}

const timeoutMs = Number(args.timeoutMs ?? 15_000);
const distro = process.env.MATHNOTES_CODEX_WSL_DISTRO?.trim();
const commandPath = process.env.MATHNOTES_CODEX_WSL_COMMAND?.trim() || "codex";
const child = spawn("wsl.exe", [
  ...(distro ? ["--distribution", distro] : []),
  "--exec",
  commandPath,
  "app-server",
  "--listen",
  "ws://127.0.0.1:0"
]);

let endpoint = "";
let stderr = "";
let stdout = "";

const timeout = setTimeout(() => {
  cleanup();
  fail(`Timed out after ${timeoutMs}ms waiting for Codex app-server probe.`);
}, timeoutMs);

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
  maybeConnect();
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
  maybeConnect();
});

child.on("error", (error) => {
  clearTimeout(timeout);
  fail(error.message);
});

child.on("close", (code) => {
  if (!endpoint) {
    clearTimeout(timeout);
    fail(`Codex app-server exited before endpoint was detected: ${code ?? 1}\n${stderr || stdout}`);
  }
});

function maybeConnect() {
  if (endpoint) return;
  const text = `${stdout}\n${stderr}`;
  const match = /listening on:\s*(ws:\/\/[^\s]+)/.exec(text) ?? /(ws:\/\/127\.0\.0\.1:\d+)/.exec(text);
  if (!match) return;
  endpoint = match[1];
  void runProbe(endpoint);
}

async function runProbe(url) {
  try {
    const client = await connectJsonRpc(url);
    const init = await client.request("initialize", {
      clientInfo: {
        name: "mathnotes-probe",
        title: "MathNotes Probe",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    });
    console.log(`app-server endpoint: ${url}`);
    console.log(`initialize ok: ${init.userAgent} · ${init.platformOs}`);

    if (args.thread || args.image) {
      const thread = await startProbeThread(client);
      console.log(`thread/start ok: ${thread.thread.id}`);
    }

    if (args.image) {
      await runImageTurn(client, args.image);
    }

    client.close();
    cleanup();
    clearTimeout(timeout);
    process.exit(0);
  } catch (error) {
    cleanup();
    clearTimeout(timeout);
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function runImageTurn(client, imagePath) {
  const resolvedImagePath = windowsPathToWslPath(path.resolve(imagePath));
  const threadResponse = await startProbeThread(client);
  const threadId = threadResponse.thread.id;
  let markdown = "";
  client.onNotification((message) => {
    if (message.method === "item/agentMessage/delta") {
      markdown += message.params.delta;
      process.stdout.write(message.params.delta);
    }
    if (message.method === "error") {
      console.error(`\nserver error notification: ${JSON.stringify(message.params)}`);
    }
  });
  await client.request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: "请忠实转写这张图片为 Markdown，只输出 Markdown 内容。",
        text_elements: []
      },
      {
        type: "localImage",
        path: resolvedImagePath
      }
    ],
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: true }
  });
  await client.waitForNotification((message) => message.method === "turn/completed", timeoutMs);
  console.log(`\nturn completed, markdown chars: ${markdown.length}`);
}

function windowsPathToWslPath(value) {
  const normalized = value.replace(/\\/g, "/");
  const match = /^([a-zA-Z]):\/(.*)$/.exec(normalized);
  if (!match) return normalized;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function startProbeThread(client) {
  return client.request("thread/start", {
    cwd: process.cwd(),
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
    threadSource: "mathnotes-probe"
  });
}

function connectJsonRpc(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const notificationListeners = new Set();
    let nextId = 1;

    const timer = setTimeout(() => {
      reject(new Error(`WebSocket connect timeout: ${url}`));
      socket.close();
    }, timeoutMs);

    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        request(method, params) {
          const id = nextId++;
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((requestResolve, requestReject) => {
            pending.set(id, { resolve: requestResolve, reject: requestReject });
          });
        },
        onNotification(listener) {
          notificationListeners.add(listener);
        },
        waitForNotification(predicate, waitMs) {
          return new Promise((waitResolve, waitReject) => {
            const waitTimer = setTimeout(() => {
              notificationListeners.delete(listener);
              waitReject(new Error(`Timed out waiting for notification after ${waitMs}ms.`));
            }, waitMs);
            const listener = (message) => {
              if (!predicate(message)) return;
              clearTimeout(waitTimer);
              notificationListeners.delete(listener);
              waitResolve(message);
            };
            notificationListeners.add(listener);
          });
        },
        close() {
          socket.close();
        }
      });
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if ("id" in message) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) {
          request.reject(new Error(JSON.stringify(message.error)));
        } else {
          request.resolve(message.result);
        }
        return;
      }
      for (const listener of notificationListeners) {
        listener(message);
      }
    });

    socket.addEventListener("error", () => {
      reject(new Error(`WebSocket error: ${url}`));
    });
  });
}

function cleanup() {
  if (!child.killed) {
    child.kill();
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    if (arg === "--thread") parsed.thread = true;
    if (arg === "--image") parsed.image = argv[++index];
    if (arg === "--timeout-ms") parsed.timeoutMs = argv[++index];
  }
  return parsed;
}
