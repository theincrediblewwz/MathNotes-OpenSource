import type { SessionSourceMarkdownBlock } from "../../common/sessionSourceDocument";

export type SourceBlockDisplay = {
  internalBlockId: string;
  displayBlockId: string;
};

export function createSourceBlockDisplays(blocks: SessionSourceMarkdownBlock[]): SourceBlockDisplay[] {
  const width = Math.max(4, String(blocks.length).length);
  return blocks.map((block, index) => ({
    internalBlockId: block.blockId,
    displayBlockId: String(index + 1).padStart(width, "0")
  }));
}
