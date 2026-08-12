import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import {
  CodexCliRecognitionProvider,
  checkCodexCliAvailability,
  windowsPathToWslPath,
  type SpawnLike
} from "./codexCliRecognitionProvider";
import { fakeChildProcess } from "./testHelpers/fakeChildProcess";

describe("CodexCliRecognitionProvider", () => {
  it("runs codex exec with image attachments and returns stdout markdown", async () => {
    const calls: Array<{ command: string; args: string[]; windowsHide?: boolean }> = [];
    const stdinWrites: string[] = [];
    const spawnImpl: SpawnLike = (command, args, options) => {
      calls.push({ command, args, windowsHide: options?.windowsHide });
      return fakeChildProcess({
        stdout: "## 忠实转写\n\n$T_n \\to T$",
        stderr: "progress",
        code: 0,
        onStdinWrite: (text) => stdinWrites.push(text)
      });
    };
    const provider = new CodexCliRecognitionProvider({
      commandPath: "codex",
      model: "gpt-5.2",
      spawnImpl
    });

    const result = await provider.transcribe({
      imagePaths: ["E:/photos/001.jpg", "E:/photos/002.png"],
      mode: "faithful",
      outputFormat: "markdown",
      context: "泛函分析"
    });

    expect(result.markdown).toContain("## 忠实转写");
    expect(calls).toEqual([
      {
        command: "codex",
        args: expect.arrayContaining(["exec", "--sandbox", "read-only", "--model", "gpt-5.2", "--image", "E:/photos/001.jpg,E:/photos/002.png"]),
        windowsHide: true
      }
    ]);
    expect(calls[0].args.at(-1)).not.toMatch(/只输出 Markdown 草稿内容/);
    expect(stdinWrites.join("")).toMatch(/只输出 Markdown 草稿内容/);
  });

  it("omits --model when model is blank so Codex can use the signed-in default", async () => {
    const calls: Array<{ command: string; args: string[]; windowsHide?: boolean }> = [];
    const spawnImpl: SpawnLike = (command, args, options) => {
      calls.push({ command, args, windowsHide: options?.windowsHide });
      return fakeChildProcess({ stdout: "ok", stderr: "", code: 0 });
    };
    const provider = new CodexCliRecognitionProvider({
      commandPath: "codex",
      model: "",
      spawnImpl
    });

    await provider.transcribe({
      imagePaths: ["E:/photos/001.jpg"],
      mode: "faithful",
      outputFormat: "markdown"
    });

    expect(calls[0].args).not.toContain("--model");
    expect(calls[0].windowsHide).toBe(true);
  });

  it("raises a readable error when the Codex command exits non-zero", async () => {
    const provider = new CodexCliRecognitionProvider({
      commandPath: "codex",
      model: "",
      spawnImpl: () => fakeChildProcess({ stdout: "", stderr: "Access is denied", code: 1 })
    });

    await expect(
      provider.transcribe({
        imagePaths: ["E:/photos/001.jpg"],
        mode: "faithful",
        outputFormat: "markdown"
      })
    ).rejects.toThrow(/Codex CLI transcription failed: 1 Access is denied/);
  });

  it("decodes non-utf8 Windows and WSL stderr without replacement-character noise", async () => {
    const provider = new CodexCliRecognitionProvider({
      commandPath: "codex",
      model: "",
      spawnImpl: () => fakeChildProcessWithBuffers({ stdout: Buffer.from(""), stderr: Buffer.from([0xb3, 0xac, 0xca, 0xb1]), code: 1 })
    });

    await expect(
      provider.transcribe({
        imagePaths: ["E:/photos/001.jpg"],
        mode: "faithful",
        outputFormat: "markdown"
      })
    ).rejects.toThrow(/超时/);
  });

  it("decodes utf16le WSL stderr without null-character noise", async () => {
    const provider = new CodexCliRecognitionProvider({
      commandPath: "codex",
      model: "",
      spawnImpl: () =>
        fakeChildProcessWithBuffers({
          stdout: Buffer.from(""),
          stderr: Buffer.from("wsl: 检测到 localhost 代理配置\n", "utf16le"),
          code: 1
        })
    });

    await expect(
      provider.transcribe({
        imagePaths: ["E:/photos/001.jpg"],
        mode: "faithful",
        outputFormat: "markdown"
      })
    ).rejects.toThrow(/检测到 localhost 代理配置/);
  });

  it("times out and kills a stuck Codex process so the queue can retry later", async () => {
    let killed = false;
    const provider = new CodexCliRecognitionProvider({
      commandPath: "codex",
      model: "",
      timeoutMs: 5,
      spawnImpl: () =>
        fakeChildProcess({
          stdout: "",
          stderr: "still running",
          code: 0,
          close: false,
          onKill: () => {
            killed = true;
          }
        })
    });

    await expect(
      provider.transcribe({
        imagePaths: ["E:/photos/001.jpg"],
        mode: "faithful",
        outputFormat: "markdown"
      })
    ).rejects.toThrow(/timed out/);
    expect(killed).toBe(true);
  });

  it("kills a running Codex process when the recognition task is cancelled", async () => {
    let killed = false;
    const abortController = new AbortController();
    const provider = new CodexCliRecognitionProvider({
      commandPath: "codex",
      model: "",
      timeoutMs: 0,
      spawnImpl: () =>
        fakeChildProcess({
          stdout: "",
          stderr: "still running",
          code: 0,
          close: false,
          onKill: () => {
            killed = true;
          }
        })
    });

    const running = provider.transcribe({
      imagePaths: ["E:/photos/001.jpg"],
      mode: "faithful",
      outputFormat: "markdown",
      abortSignal: abortController.signal
    });
    abortController.abort();

    await expect(running).rejects.toThrow(/cancelled/);
    expect(killed).toBe(true);
  });

  it("runs codex through WSL with converted image paths", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnImpl: SpawnLike = (command, args) => {
      calls.push({ command, args });
      return fakeChildProcess({ stdout: "## WSL 转写", stderr: "", code: 0 });
    };
    const provider = new CodexCliRecognitionProvider({
      runtime: "wsl",
      commandPath: "codex",
      wslCommandPath: "wsl.exe",
      wslDistro: "Ubuntu-24.04",
      model: "",
      spawnImpl
    });

    await provider.transcribe({
      imagePaths: ["E:\\notes\\photos\\001.jpg", "D:/math/photo 002.png"],
      mode: "faithful",
      outputFormat: "markdown"
    });

    expect(calls).toEqual([
      {
        command: "wsl.exe",
        args: expect.arrayContaining([
          "--distribution",
          "Ubuntu-24.04",
          "--exec",
          "codex",
          "exec",
          "--sandbox",
          "read-only",
          "--image",
          "/mnt/e/notes/photos/001.jpg,/mnt/d/math/photo 002.png"
        ])
      }
    ]);
  });

  it("converts Windows drive paths to WSL mount paths", () => {
    expect(windowsPathToWslPath("E:\\notes\\photos\\001.jpg")).toBe("/mnt/e/notes/photos/001.jpg");
    expect(windowsPathToWslPath("D:/math/photo 002.png")).toBe("/mnt/d/math/photo 002.png");
    expect(windowsPathToWslPath("/home/user/photo.png")).toBe("/home/user/photo.png");
  });

  it("checks WSL Codex CLI availability through --version", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnImpl: SpawnLike = (command, args) => {
      calls.push({ command, args });
      return fakeChildProcess({ stdout: "codex 1.0.0", stderr: "", code: 0 });
    };

    const result = await checkCodexCliAvailability({
      runtime: "wsl",
      commandPath: "codex",
      wslCommandPath: "wsl.exe",
      wslDistro: "Ubuntu",
      spawnImpl
    });

    expect(result).toEqual({ ok: true, detail: "codex 1.0.0" });
    expect(calls).toEqual([
      {
        command: "wsl.exe",
        args: ["--distribution", "Ubuntu", "--exec", "codex", "--version"]
      }
    ]);
  });
});

function fakeChildProcessWithBuffers(result: { stdout: Buffer; stderr: Buffer; code: number }) {
  const process = new EventEmitter() as ReturnType<SpawnLike>;
  process.stdout = new EventEmitter() as ReturnType<SpawnLike>["stdout"];
  process.stderr = new EventEmitter() as ReturnType<SpawnLike>["stderr"];
  process.stdin = {
    write: () => true,
    end: () => undefined
  } as unknown as ReturnType<SpawnLike>["stdin"];
  process.kill = (() => {
    process.emit("close", 1);
    return true;
  }) as ReturnType<SpawnLike>["kill"];

  queueMicrotask(() => {
    process.stdout.emit("data", result.stdout);
    process.stderr.emit("data", result.stderr);
    process.emit("close", result.code);
  });

  return process;
}
