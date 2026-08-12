import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkspaceContext, writeWorkspaceContext } from "./workspaceContextStore";

describe("workspaceContextStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-context-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("persists the last active notebook and session", async () => {
    await writeWorkspaceContext(rootDir, { notebookId: "analysis", sessionId: "lecture_03" });
    await expect(readWorkspaceContext(rootDir)).resolves.toEqual({ notebookId: "analysis", sessionId: "lecture_03" });
  });

  it("returns null when no context has been saved", async () => {
    await expect(readWorkspaceContext(rootDir)).resolves.toBeNull();
  });
});
