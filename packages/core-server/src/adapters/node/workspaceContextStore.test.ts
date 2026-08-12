import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkspaceContext, writeWorkspaceContext } from "./workspaceContextStore";

describe("workspaceContextStore", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "mathnotes-core-context-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("preserves the existing active context file contract", async () => {
    await writeWorkspaceContext(rootDir, { notebookId: "analysis", sessionId: "lecture_03" });

    await expect(readWorkspaceContext(rootDir)).resolves.toEqual({
      notebookId: "analysis",
      sessionId: "lecture_03"
    });
    await expect(readFile(join(rootDir, ".mathnotes", "active-context.json"), "utf8")).resolves.toBe(
      '{\n  "notebookId": "analysis",\n  "sessionId": "lecture_03"\n}\n'
    );
  });

  it("returns null for missing, malformed or incomplete context", async () => {
    await expect(readWorkspaceContext(rootDir)).resolves.toBeNull();
    await writeWorkspaceContext(rootDir, { notebookId: "analysis", sessionId: "lecture_03" });
    const file = join(rootDir, ".mathnotes", "active-context.json");
    await writeFile(file, "{broken", "utf8");
    await expect(readWorkspaceContext(rootDir)).resolves.toBeNull();
    await writeFile(file, '{"notebookId":"analysis"}', "utf8");
    await expect(readWorkspaceContext(rootDir)).resolves.toBeNull();
  });
});
