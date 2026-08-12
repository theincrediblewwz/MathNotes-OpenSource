import type { BlockRef } from "@mathnotes/shared";
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
      markdown: args.markdown,
      fromAssets: args.fromAssets,
      sourcePageNumber: args.sourcePageNumber,
      sourcePageImagePath: args.sourcePageImagePath,
      insertAfterBlockId: args.insertAfterBlockId,
      now: args.now
    });
  }

  async updateAiTranscript(args: UpdateAiTranscriptArgs): Promise<BlockRef> {
    return this.store.updateMarkdownBlock({
      notebookId: args.notebookId,
      sessionId: args.sessionId,
      blockId: args.blockId,
      markdown: args.markdown,
      now: args.now
    });
  }
}
