import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RevisionEventLog } from "./revisionEventLog";

describe("RevisionEventLog", () => {
  let rootDir: string;
  let filePath: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-revisions-"));
    filePath = join(rootDir, "revision-events.json");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("persists monotonic IDs and replays matching events after restart", async () => {
    const first = new RevisionEventLog({ filePath });
    await first.start();
    const catalog = await first.append({ scope: "catalog", kind: "renamed", at: "2026-07-24T04:00:00.000Z" });
    const session = await first.append({
      scope: "session",
      kind: "changed",
      notebookId: "analysis",
      sessionId: "lecture",
      revision: "rev-2",
      at: "2026-07-24T04:00:01.000Z"
    });
    expect([catalog.id, session.id]).toEqual(["1", "2"]);
    await first.close();

    const restarted = new RevisionEventLog({ filePath });
    await restarted.start();
    await expect(restarted.replay("0", { scope: "session", notebookId: "analysis", sessionId: "lecture" }))
      .resolves.toEqual({ status: "ok", events: [session], latestId: "2" });
    const next = await restarted.append({ scope: "catalog", kind: "changed", at: "2026-07-24T04:00:02.000Z" });
    expect(next.id).toBe("3");
  });

  it("requires a full resync when the cursor is outside the retained window", async () => {
    const log = new RevisionEventLog({ filePath, maxEvents: 2 });
    await log.start();
    for (let index = 0; index < 3; index += 1) {
      await log.append({ scope: "catalog", kind: "changed", at: `2026-07-24T04:00:0${index}.000Z` });
    }
    await expect(log.replay("0", { scope: "catalog" })).resolves.toEqual({
      status: "resync-required",
      events: [],
      latestId: "3"
    });
    await expect(log.replay("1", { scope: "catalog" })).resolves.toMatchObject({
      status: "ok",
      latestId: "3",
      events: [{ id: "2" }, { id: "3" }]
    });
    await expect(log.replay("99", { scope: "catalog" })).resolves.toMatchObject({
      status: "resync-required",
      latestId: "3"
    });
  });

  it("publishes only after durable persistence and fails closed on corrupt state", async () => {
    const log = new RevisionEventLog({ filePath });
    await log.start();
    const seen: string[] = [];
    log.subscribe((event) => seen.push(event.id));
    await log.append({ scope: "catalog", kind: "created", at: "2026-07-24T04:00:00.000Z" });
    expect(seen).toEqual(["1"]);
    await log.close();

    await writeFile(filePath, "{broken", "utf8");
    const corrupt = new RevisionEventLog({ filePath });
    await expect(corrupt.start()).rejects.toBeInstanceOf(SyntaxError);
  });
});
