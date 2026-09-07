import { markdownContinuationGroups, type BlockRef } from "@mathnotes/shared";

export const continuationInstructions = "continuations 是相邻可见同组片段直接拼接的完整上下文；各片段仍是独立修改目标。已锁定片段原文不可改变；不要对单个片段 trim、添加换行或补数学/代码围栏。仅按原 blockId 返回用户要求的修改。";

export function continuationContexts(blocks: readonly BlockRef[], markdownByBlockId: ReadonlyMap<string, string>, relevantIds?: ReadonlySet<string>) {
  return markdownContinuationGroups(blocks)
    .filter(group => group[0].continuationGroup && (!relevantIds || group.some(block => relevantIds.has(block.id))))
    .map(group => ({
      continuationGroup: group[0].continuationGroup!,
      blocks: group.map(block => ({ blockId: block.id, locked: block.status === "locked" || block.readonly })),
      markdown: group.map(block => markdownByBlockId.get(block.id) ?? "").join("")
    }));
}
