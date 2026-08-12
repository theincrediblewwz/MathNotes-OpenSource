import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreEnvironment, CoreService } from "./index";
import { readWorkspaceContext, startMathNotesCoreHeadless, writeWorkspaceContext } from "./index";

describe("startMathNotesCoreHeadless", () => {
  let rootDir: string | undefined;

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("starts real Node persistence without Electron and leaves shutdown to the host", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-headless-"));
    const stop = vi.fn(async () => undefined);
    const service: CoreService = {
      name: "workspace-context",
      async start({ environment }) {
        await writeWorkspaceContext(environment.notesRootDir, {
          notebookId: "analysis",
          sessionId: "lecture_03"
        });
      },
      stop
    };

    const coreEnvironment = environment(rootDir);
    const core = await startMathNotesCoreHeadless(coreEnvironment, { services: [service] });

    expect(core.state).toBe("running");
    await expect(readWorkspaceContext(coreEnvironment.notesRootDir)).resolves.toEqual({
      notebookId: "analysis",
      sessionId: "lecture_03"
    });
    await core.stop();
    expect(core.state).toBe("stopped");
    expect(stop).toHaveBeenCalledOnce();
  });
});

function environment(rootDir: string): CoreEnvironment {
  return {
    userDataDir: join(rootDir, "user-data"),
    notesRootDir: join(rootDir, "notes"),
    tempDir: join(rootDir, "temp"),
    appVersion: "test",
    platform: "linux",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    providerFactory: {
      createRecognitionProvider: vi.fn(),
      createAssistantProvider: vi.fn()
    },
    platformCapabilities: {
      canListenOnLan: true,
      canSpawnProcesses: true,
      canWatchFiles: true
    }
  };
}
