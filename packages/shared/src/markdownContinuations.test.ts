import { expect, it } from "vitest";
import { createBlockRef } from "./model";
import { markdownContinuationGroups } from "./markdownContinuations";
const block = (id: string, continuationGroup?: string) => createBlockRef({ id, continuationGroup, type: "markdown", path: id, source: "user", createdAt: "now" });
it("preserves identities and breaks continuity at assets, hidden pieces and other groups", () => {
  const blocks = [block("1", "g"), block("2", "g"), { ...block("3"), type: "image" as const }, block("4", "g"), { ...block("5", "g"), renderInNote: false }, block("6", "g"), block("7", "h"), block("8", "g"), block("9"), block("10")];
  expect(markdownContinuationGroups(blocks).map(group => group.map(item => item.id))).toEqual([["1", "2"], ["4"], ["6"], ["7"], ["8"], ["9"], ["10"]]);
  expect(markdownContinuationGroups(blocks)[0][1]).toBe(blocks[1]);
});
