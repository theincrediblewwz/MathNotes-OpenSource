import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "@mathnotes/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readReadonlySessionManifest } from "./sessionReadService";
import { SessionExportError, SessionExportService, exportSessionMarkdown } from "./sessionExportService";

describe("SessionExportService", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-core-export-"));
    sessionDir = join(root, "notebooks", "analysis", "sessions", "lecture");
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await writeFile(join(sessionDir, "blocks", "0001.md"), "行内：\\(T_n \\to T\\)。\n\n![图](../assets/embedded/graph.png)\n");
    const session: SessionRecord = {
      id: "lecture", title: "第三讲", status: "draft",
      createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T01:00:00.000Z",
      currentDraftPolicy: "append_only", exportPolicy: { includeMetadataComments: true, includeImageLinks: true },
      locks: [], blocks: [{
        id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status: "draft",
        readonly: false, editableByAi: false,
        createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T01:00:00.000Z"
      }]
    };
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("exports portable Markdown and returns path-free download metadata through the service", async () => {
    const revision = (await readReadonlySessionManifest({ rootDir: root, notebookId: "analysis", sessionId: "lecture" })).revision;
    const service = new SessionExportService(root);
    const result = await service.exportMarkdown({
      notebookId: "analysis", sessionId: "lecture", includeMetadataComments: true, baseRevision: revision
    });
    expect(result).toMatchObject({ fileName: "lecture.md", relativeExportPath: "exports/lecture.md", exportedBlocks: 1 });
    expect(await readFile(result.outPath, "utf8")).toContain("行内：$T_n \\to T$。");
    const download = await service.readMarkdownExport({ notebookId: "analysis", sessionId: "lecture" });
    expect(download.bytes.toString("utf8")).toContain("block:id=0001");
    expect(download.sha256).toBe(result.sha256);
  });

  it("rejects stale revisions and traversal before writing an export", async () => {
    await expect(exportSessionMarkdown({
      rootDir: root, notebookId: "analysis", sessionId: "lecture",
      includeMetadataComments: false, baseRevision: "a".repeat(64)
    })).rejects.toEqual(expect.objectContaining<Partial<SessionExportError>>({ code: "revision_conflict", statusCode: 409 }));
    await expect(exportSessionMarkdown({
      rootDir: root, notebookId: "../../outside", sessionId: "lecture", includeMetadataComments: false
    })).rejects.toEqual(expect.objectContaining<Partial<SessionExportError>>({ code: "path_outside_session", statusCode: 400 }));
  });

  it("recovers an interrupted file swap and removes only its named stale temporary files", async () => {
    const service = new SessionExportService(root);
    const first = await service.exportMarkdown({ notebookId: "analysis", sessionId: "lecture", includeMetadataComments: false });
    const backup = `${first.outPath}.mathnotes-backup`;
    await rename(first.outPath, backup);
    await writeFile(`${first.outPath}.mathnotes-tmp-orphan`, "partial");
    await writeFile(join(sessionDir, "exports", "unrelated.tmp"), "keep");
    const second = await service.exportMarkdown({ notebookId: "analysis", sessionId: "lecture", includeMetadataComments: false });
    expect(await readFile(second.outPath, "utf8")).toContain("行内：$T_n \\to T$。");
    expect(await readdir(join(sessionDir, "exports"))).toContain("unrelated.tmp");
    expect((await readdir(join(sessionDir, "exports"))).some((entry) => entry.includes("mathnotes-tmp"))).toBe(false);
  });

  it("stages a complete share package and restores an interrupted directory swap", async () => {
    await mkdir(join(sessionDir, "assets", "embedded"), { recursive: true });
    await writeFile(join(sessionDir, "assets", "embedded", "graph.png"), "image");
    const first = await exportSessionMarkdown({
      rootDir: root, notebookId: "analysis", sessionId: "lecture",
      includeMetadataComments: false, packageMode: "share"
    });
    expect(first.copiedAssets).toEqual(["assets/embedded/graph.png"]);
    const backup = `${first.packageDir}.mathnotes-backup`;
    await rename(first.packageDir!, backup);
    const second = await exportSessionMarkdown({
      rootDir: root, notebookId: "analysis", sessionId: "lecture",
      includeMetadataComments: false, packageMode: "share"
    });
    expect(await readFile(join(second.packageDir!, "assets", "embedded", "graph.png"), "utf8")).toBe("image");
    expect((await readdir(join(sessionDir, "exports"))).some((entry) => entry.endsWith("mathnotes-backup"))).toBe(false);
  });
});
