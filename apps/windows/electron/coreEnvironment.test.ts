import { describe, expect, it, vi } from "vitest";
import { createMathNotesCore } from "@mathnotes/core-server";
import {
  corePlatformFromNodePlatform,
  createDesktopCoreEnvironment,
  createResilientWindowsCoreService,
  createWindowsCoreEnvironment
} from "./coreEnvironment";

describe("Windows core environment", () => {
  it("declares the Windows platform boundary and delegates provider creation", async () => {
    const recognitionProvider = { name: "recognition" } as never;
    const assistantProvider = { name: "assistant" } as never;
    const createRecognitionProvider = vi.fn(async () => recognitionProvider);
    const createAssistantProvider = vi.fn(async () => assistantProvider);
    const environment = createWindowsCoreEnvironment({
      userDataDir: "C:\\MathNotes\\UserData",
      notesRootDir: "C:\\MathNotes\\Notes",
      tempDir: "C:\\MathNotes\\Temp",
      appVersion: "0.1.6",
      createRecognitionProvider,
      createAssistantProvider
    });

    expect(environment.platform).toBe("windows");
    expect(environment.platformCapabilities).toEqual({
      canListenOnLan: true,
      canSpawnProcesses: true,
      canWatchFiles: true
    });
    await expect(environment.providerFactory.createRecognitionProvider()).resolves.toBe(recognitionProvider);
    await expect(environment.providerFactory.createAssistantProvider()).resolves.toBe(assistantProvider);
  });

  it("maps the shared desktop bridge to the actual host platform", () => {
    expect(corePlatformFromNodePlatform("win32")).toBe("windows");
    expect(corePlatformFromNodePlatform("darwin")).toBe("macos");
    expect(corePlatformFromNodePlatform("linux")).toBe("linux");

    const environment = createDesktopCoreEnvironment({
      userDataDir: "/Users/test/Library/Application Support/MathNotes",
      notesRootDir: "/Users/test/Documents/MathNotes",
      tempDir: "/private/tmp",
      appVersion: "0.1.6",
      nodePlatform: "darwin",
      createRecognitionProvider: vi.fn(),
      createAssistantProvider: vi.fn()
    });

    expect(environment.platform).toBe("macos");
    expect(environment.platformCapabilities).toEqual({
      canListenOnLan: true,
      canSpawnProcesses: true,
      canWatchFiles: true
    });
  });

  it("keeps an optional desktop service retryable when its first start fails", async () => {
    const start = vi.fn(async () => {
      throw new Error("port unavailable");
    });
    const stop = vi.fn(async () => undefined);
    const onStartError = vi.fn();
    const environment = createWindowsCoreEnvironment({
      userDataDir: "C:\\MathNotes\\UserData",
      notesRootDir: "C:\\MathNotes\\Notes",
      tempDir: "C:\\MathNotes\\Temp",
      appVersion: "0.1.6",
      createRecognitionProvider: vi.fn(),
      createAssistantProvider: vi.fn(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    });
    const core = createMathNotesCore(environment, {
      services: [
        createResilientWindowsCoreService({
          name: "ingest-server",
          start,
          stop,
          onStartError
        })
      ]
    });

    await expect(core.start()).resolves.toBeUndefined();
    expect(core.state).toBe("running");
    expect(onStartError).toHaveBeenCalledWith(expect.objectContaining({ message: "port unavailable" }));

    await core.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});
