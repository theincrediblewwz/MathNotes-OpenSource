import { describe, expect, it } from "vitest";
import type { SpawnLike } from "./codexCliRecognitionProvider";
import { CodexRuntimeManager } from "./codexRuntimeManager";
import { fakeChildProcess } from "./testHelpers/fakeChildProcess";

describe("CodexRuntimeManager", () => {
  it("starts Codex app-server once and reports ready progress", async () => {
    const calls: Array<{ command: string; args: string[]; windowsHide?: boolean }> = [];
    const states: string[] = [];
    const spawnImpl: SpawnLike = (command, args, options) => {
      calls.push({ command, args, windowsHide: options?.windowsHide });
      return fakeChildProcess({
        stdout: "listening on ws://127.0.0.1:39117\n",
        stderr: "",
        code: 0,
        close: false
      });
    };
    const manager = new CodexRuntimeManager({ spawnImpl, readyTimeoutMs: 50 });
    manager.onStateChanged((state) => states.push(`${state.status}:${state.progress}`));

    const state = await manager.ensureStarted({
      providerId: "codex_cli",
      model: "",
      apiKeyEnvVar: "",
      commandPath: "/home/mathnotes/.local/bin/codex-proxy",
      codexRuntime: "wsl",
      wslDistro: "Ubuntu-24.04",
      status: "configured"
    });
    const second = await manager.ensureStarted({
      providerId: "codex_cli",
      model: "",
      apiKeyEnvVar: "",
      commandPath: "/home/mathnotes/.local/bin/codex-proxy",
      codexRuntime: "wsl",
      wslDistro: "Ubuntu-24.04",
      status: "configured"
    });

    expect(state.status).toBe("ready");
    expect(state.progress).toBe(100);
    expect(second.status).toBe("ready");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: "wsl.exe",
      args: [
        "--distribution",
        "Ubuntu-24.04",
        "--exec",
        "/home/mathnotes/.local/bin/codex-proxy",
        "app-server",
        "--listen",
        "ws://127.0.0.1:0"
      ],
      windowsHide: true
    });
    expect(states).toContain("starting:15");
    expect(states).toContain("ready:100");
  });

  it("stops the runtime child process", async () => {
    let killed = false;
    const manager = new CodexRuntimeManager({
      spawnImpl: () =>
        fakeChildProcess({
          stdout: "listening on ws://127.0.0.1:39117\n",
          stderr: "",
          code: 0,
          close: false,
          onKill: () => {
            killed = true;
          }
        }),
      readyTimeoutMs: 50
    });

    await manager.ensureStarted({
      providerId: "codex_cli",
      model: "",
      apiKeyEnvVar: "",
      commandPath: "codex",
      codexRuntime: "windows",
      status: "configured"
    });
    manager.stop();

    expect(killed).toBe(true);
    expect(manager.getState().status).toBe("stopped");
    expect(manager.getState().progress).toBe(0);
  });

  it("does not mark a silent app-server ready without an endpoint", async () => {
    const manager = new CodexRuntimeManager({
      spawnImpl: () =>
        fakeChildProcess({
          stdout: "",
          stderr: "",
          code: 0,
          close: false
        }),
      readyTimeoutMs: 100,
      optimisticReadyMs: 1
    });

    const state = await manager.ensureStarted({
      providerId: "codex_cli",
      model: "",
      apiKeyEnvVar: "",
      commandPath: "codex",
      codexRuntime: "windows",
      status: "configured"
    });

    expect(state.status).toBe("error");
    expect(state.progress).toBe(0);
  });

  it("does not regress a ready runtime back to starting when late logs arrive", async () => {
    let child: ReturnType<typeof fakeChildProcess> | undefined;
    const states: string[] = [];
    const manager = new CodexRuntimeManager({
      spawnImpl: () => {
        child = fakeChildProcess({
          stdout: "listening on ws://127.0.0.1:39117\n",
          stderr: "",
          code: 0,
          close: false
        });
        return child;
      },
      readyTimeoutMs: 100,
      optimisticReadyMs: 50
    });
    manager.onStateChanged((state) => states.push(`${state.status}:${state.progress}`));

    const state = await manager.ensureStarted({
      providerId: "codex_cli",
      model: "",
      apiKeyEnvVar: "",
      commandPath: "codex",
      codexRuntime: "windows",
      status: "configured"
    });
    expect(state.status).toBe("ready");

    child?.stderr.emit("data", Buffer.from("Reading prompt from stdin...\n", "utf8"));

    expect(manager.getState().status).toBe("ready");
    expect(manager.getState().progress).toBe(100);
    expect(states).not.toContain("starting:100");
  });

  it("keeps stopped state when a starting runtime is stopped", async () => {
    const manager = new CodexRuntimeManager({
      spawnImpl: () =>
        fakeChildProcess({
          stdout: "",
          stderr: "",
          code: 0,
          close: false
        }),
      readyTimeoutMs: 100,
      optimisticReadyMs: 50
    });

    const startPromise = manager.ensureStarted({
      providerId: "codex_cli",
      model: "",
      apiKeyEnvVar: "",
      commandPath: "codex",
      codexRuntime: "windows",
      status: "configured"
    });
    manager.stop();
    await startPromise;

    expect(manager.getState().status).toBe("stopped");
    expect(manager.getState().progress).toBe(0);
  });
});
