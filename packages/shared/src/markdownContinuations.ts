import type { BlockRef } from "./model";

/** Keep only truly adjacent pieces together; images, hidden pieces and moved blocks break a group. */
export function markdownContinuationGroups(blocks: readonly BlockRef[]): BlockRef[][] {
  const groups: BlockRef[][] = [];
  let previous: BlockRef | undefined;
  for (const block of blocks) {
    if (block.type !== "markdown" || block.renderInNote === false) { previous = undefined; continue; }
    if (block.continuationGroup && previous?.continuationGroup === block.continuationGroup) {
      groups[groups.length - 1].push(block);
    } else {
      groups.push([block]);
    }
    previous = block;
  }
  return groups;
}
