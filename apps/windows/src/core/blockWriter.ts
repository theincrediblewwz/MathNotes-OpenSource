import type { BlockRef } from "@mathnotes/shared";
import { bindSourceImageMarkers } from "@mathnotes/core-server";
import type { BlockStore } from "./blockStore";

export type WriteAiTranscriptArgs = {
  notebookId: string;
  sessionId: string;
  markdown: string;
  fromAssets: string[];
  sourcePageNumber?: number;
  sourcePageImagePath?: string;
  insertAfterBlockId?: string;
  now: string;
};

export type UpdateAiTranscriptArgs = {
  notebookId: string;
  sessionId: string;
  blockId: string;
  markdown: string;
  now: string;
};

export class BlockWriter {
  constructor(private readonly store: BlockStore) {}

  async writeAiTranscript(args: WriteAiTranscriptArgs): Promise<BlockRef> {
    return this.store.appendMarkdownBlock({
      notebookId: args.notebookId,
      sessionId: args.sessionId,
      source: "ai_transcription",
      markdown: bindSourceImageMarkers(args.markdown, args.sourcePageImagePath ?? (args.fromAssets.length === 1 ? args.fromAssets[0] : undefined)),
      fromAssets: args.fromAssets,
      sourcePageNumber: args.sourcePageNumber,
      sourcePageImagePath: args.sourcePageImagePath,
      insertAfterBlockId: args.insertAfterBlockId,
      now: args.now
    });
  }

  async updateAiTranscript(args: UpdateAiTranscriptArgs): Promise<BlockRef> {
    let markdown = args.markdown;
    if (markdown.includes("[[mathnotes:source-image]]")) {
      const session = await this.store.readSession(args.notebookId, args.sessionId);
      const block = session.blocks.find(candidate => candidate.id === args.blockId);
      const sourceAsset = block?.sourcePageImagePath ?? (block?.fromAssets?.length === 1 ? block.fromAssets[0] : undefined);
      markdown = bindSourceImageMarkers(markdown, sourceAsset);
    }
    return this.store.updateMarkdownBlockFromAi({
      notebookId: args.notebookId,
      sessionId: args.sessionId,
      blockId: args.blockId,
      markdown,
      now: args.now
    });
  }
}
