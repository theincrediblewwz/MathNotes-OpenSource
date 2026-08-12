import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CoreEnvironment, CoreLogger } from "./environment";
import { createMathNotesCore, type CoreService } from "./mathNotesCore";

describe("createMathNotesCore", () => {
  it("starts in declaration order and stops in reverse order", async () => {
    const events: string[] = [];
    const core = createMathNotesCore(environment(), {
      services: [service("store", events), service("transport", events)]
    });

    await core.start();
    expect(core.state).toBe("running");
    await core.stop();

    expect(core.state).toBe("stopped");
    expect(events).toEqual(["start:store", "start:transport", "stop:transport", "stop:store"]);
  });

  it("rolls back services when a later service fails to start", async () => {
    const events: string[] = [];
    const core = createMathNotesCore(environment(), {
      services: [service("store", events), service("broken", events, new Error("bind failed"))]
    });

    await expect(core.start()).rejects.toThrow("bind failed");
    expect(core.state).toBe("stopped");
    expect(events).toEqual(["start:store", "start:broken", "stop:store"]);
  });

  it("preserves both the start and rollback errors", async () => {
    const core = createMathNotesCore(environment(), {
      services: [
        {
          name: "store",
          start() {},
          stop() {
            throw new Error("close failed");
          }
        },
        service("broken", [], new Error("bind failed"))
      ]
    });

    const failure = await core.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => error.message)).toEqual([
      "bind failed",
      "One or more Core services failed to stop"
    ]);
    expect(core.state).toBe("stopped");
  });

  it("coalesces concurrent starts and makes stop idempotent", async () => {
    let starts = 0;
    let stops = 0;
    const core = createMathNotesCore(environment(), {
      services: [{
        name: "single",
        async start() {
          starts += 1;
          await Promise.resolve();
        },
        stop() {
          stops += 1;
        }
      }]
    });

    await Promise.all([core.start(), core.start()]);
    await Promise.all([core.stop(), core.stop()]);
    expect(starts).toBe(1);
    expect(stops).toBe(1);
  });

  it("rejects relative data paths and duplicate services", () => {
    expect(() => createMathNotesCore({ ...environment(), notesRootDir: "notes" })).toThrow("notesRootDir");
    expect(() => createMathNotesCore(environment(), {
      services: [service("same", []), service("same", [])]
    })).toThrow("Duplicate CoreService name");
  });
});

function service(name: string, events: string[], startError?: Error): CoreService {
  return {
    name,
    start() {
      events.push(`start:${name}`);
      if (startError) throw startError;
    },
    stop() {
      events.push(`stop:${name}`);
    }
  };
}

function environment(): CoreEnvironment {
  const logger: CoreLogger = { debug() {}, info() {}, warn() {}, error() {} };
  return {
    userDataDir: path.resolve("tmp/user-data"),
    notesRootDir: path.resolve("tmp/notes"),
    tempDir: path.resolve("tmp/cache"),
    appVersion: "0.1.0-test",
    platform: "windows",
    logger,
    providerFactory: {
      async createRecognitionProvider() {
        throw new Error("not needed by this test");
      },
      async createAssistantProvider() {
        throw new Error("not needed by this test");
      }
    },
    platformCapabilities: {
      canListenOnLan: true,
      canSpawnProcesses: true,
      canWatchFiles: true
    }
  };
}
