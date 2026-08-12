import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantProvider, SessionRecord } from "@mathnotes/shared";
import { SessionEditService } from "./sessionEditService";
import { readReadonlySessionBlock } from "./sessionReadService";
import { SessionSelectionEditService } from "./sessionSelectionEditService";
import { sha256Text } from "./sessionRevision";

describe("SessionSelectionEditService", () => {
  let root: string;
  let sessionDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mathnotes-selection-edit-"));
    sessionDir = join(root, "notebooks", "book", "sessions", "lesson");
    await mkdir(join(sessionDir, "blocks"), { recursive: true });
    await writeFile(join(sessionDir, "blocks", "0001.md"), "原句重复；原句重复");
    await writeSession([]);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("persists a proposal without changing the note and applies it only after explicit approval", async () => {
    const provider: AssistantProvider = {
      name: "mock-assistant",
      async assist(input) {
        expect(input.intent).toBe("selection_edit");
        expect(input.question).toBe("改得更简洁");
        return { markdown: "```markdown\n精简句\n```" };
      }
    };
    const editor = new SessionEditService(root, () => "2026-08-13T04:20:02.000Z");
    let tick = 0;
    const service = new SessionSelectionEditService(
      root,
      async () => provider,
      editor,
      () => `2026-08-13T04:20:0${tick++}.000Z`
    );
    const markdown = await readFile(join(sessionDir, "blocks", "0001.md"), "utf8");
    const from = markdown.lastIndexOf("原句重复");
    const proposal = await service.propose({
      notebookId: "book", sessionId: "lesson", blockId: "0001",
      selection: { from, to: from + 4, selectedText: "原句重复" },
      instruction: "改得更简洁"
    });
    expect(proposal).toMatchObject({ status: "proposed", replacementMarkdown: "精简句", providerName: "mock-assistant" });
    expect(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8")).toBe(markdown);
    expect(JSON.parse(await readFile(join(sessionDir, ".mathnotes", "selection-edits", `${proposal.id}.json`), "utf8")))
      .toMatchObject({ id: proposal.id, status: "proposed" });

    const applied = await service.apply({ notebookId: "book", sessionId: "lesson", proposalId: proposal.id });
    expect(applied.proposal.status).toBe("applied");
    expect(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8")).toBe("原句重复；精简句");
    await expect(service.apply({ notebookId: "book", sessionId: "lesson", proposalId: proposal.id }))
      .rejects.toMatchObject({ code: "proposal_not_pending", statusCode: 409 });
  });

  it("rejects stale proposals instead of moving the edit to matching text elsewhere", async () => {
    const service = makeService("候选");
    const proposal = await service.propose({
      notebookId: "book", sessionId: "lesson", blockId: "0001",
      selection: { from: 0, to: 4, selectedText: "原句重复" }, instruction: "修改"
    });
    const before = await readReadonlySessionBlock({ rootDir: root, notebookId: "book", sessionId: "lesson", blockId: "0001" });
    if (before.content.kind !== "markdown") throw new Error("expected markdown");
    await new SessionEditService(root).saveMarkdownBlock({
      notebookId: "book", sessionId: "lesson", blockId: "0001",
      markdown: `新增：${before.content.markdown}`, baseRevision: before.content.baseRevision
    });
    await expect(service.apply({ notebookId: "book", sessionId: "lesson", proposalId: proposal.id }))
      .rejects.toMatchObject({ code: "revision_conflict", statusCode: 409 });
  });

  it("cancels a proposal without writing anything to the note", async () => {
    const service = makeService("候选");
    const markdown = await readFile(join(sessionDir, "blocks", "0001.md"), "utf8");
    const proposal = await service.propose({
      notebookId: "book", sessionId: "lesson", blockId: "0001",
      selection: { from: 0, to: 4, selectedText: "原句重复" }, instruction: "修改"
    });
    const cancelled = await service.cancel({ notebookId: "book", sessionId: "lesson", proposalId: proposal.id });
    expect(cancelled).toMatchObject({ id: proposal.id, status: "cancelled" });
    expect(await readFile(join(sessionDir, "blocks", "0001.md"), "utf8")).toBe(markdown);
    expect(JSON.parse(await readFile(join(sessionDir, ".mathnotes", "selection-edits", `${proposal.id}.json`), "utf8")))
      .toMatchObject({ id: proposal.id, status: "cancelled" });
    await expect(service.apply({ notebookId: "book", sessionId: "lesson", proposalId: proposal.id }))
      .rejects.toMatchObject({ code: "proposal_not_pending", statusCode: 409 });
  });

  it("refuses to generate a proposal for protected content", async () => {
    const protectedText = "确认公式";
    const hash = sha256Text(protectedText);
    const markdown = `前\n<!-- lock:start id="span" hash="${hash}" -->\n${protectedText}\n<!-- lock:end id="span" -->\n后`;
    await writeFile(join(sessionDir, "blocks", "0001.md"), markdown);
    await writeSession([{ id: "span", blockId: "0001", kind: "span", contentHash: hash,
      createdAt: "2026-08-13T04:00:00.000Z", createdBy: "user", aiEditable: false }]);
    const from = markdown.indexOf(protectedText);
    await expect(makeService("不会调用").propose({
      notebookId: "book", sessionId: "lesson", blockId: "0001",
      selection: { from, to: from + protectedText.length, selectedText: protectedText }, instruction: "修改"
    })).rejects.toMatchObject({ code: "protected_selection", statusCode: 423 });
  });

  function makeService(replacement: string) {
    return new SessionSelectionEditService(root, async () => ({
      name: "mock",
      async assist() { return { markdown: replacement }; }
    }), new SessionEditService(root));
  }

  async function writeSession(locks: SessionRecord["locks"]) {
    const session: SessionRecord = {
      id: "lesson", title: "Lesson", status: "draft",
      createdAt: "2026-08-13T04:00:00.000Z", updatedAt: "2026-08-13T04:00:00.000Z",
      blocks: [{
        id: "0001", type: "markdown", path: "blocks/0001.md", source: "user", status: "draft",
        readonly: false, editableByAi: false,
        createdAt: "2026-08-13T04:00:00.000Z", updatedAt: "2026-08-13T04:00:00.000Z"
      }],
      locks,
      currentDraftPolicy: "append_only",
      exportPolicy: { includeMetadataComments: true, includeImageLinks: true }
    };
    await writeFile(join(sessionDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  }
});
