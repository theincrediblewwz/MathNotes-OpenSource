import type { BlockSource } from "@mathnotes/shared";
import { createPortableMarkdownParser } from "../render/portableMarkdown";
import { SharePackageError, SHARE_LIMITS } from "./sharePackageArchive";

export type ImportedShareBlock = { id: string; source: BlockSource; markdown: string };
const sources = new Set<BlockSource>(["pdf_import", "android_camera", "ai_transcription", "ai_explanation", "user", "user_revision", "mixed"]);
const marker = /^ {0,3}<!--\s*block:id=([^\s]+)\s+source=([^\s]+)\s*-->[ \t]*(?:\r\n|\r|\n)?$/;

/** Only exported, top-level comment lines are boundaries. Code, math, quoted
 * examples and arbitrary HTML stay literal. Offsets refer to original text. */
export function restoreShareBlocks(markdown: string): { blocks: ImportedShareBlock[]; mergedContinuationGroups: number } {
  const parser = createPortableMarkdownParser();
  parser.options.html = true;
  const starts = [0];
  for (const line of markdown.matchAll(/\r\n|\n|\r/g)) starts.push(line.index! + line[0].length);
  const at = (line: number) => starts[line] ?? markdown.length;
  const markers: { start: number; end: number; id: string; source: BlockSource }[] = [];
  for (const token of parser.parse(markdown, {})) {
    if (token.type !== "html_block" || token.level !== 0 || !token.map) continue;
    const entries = [];
    let onlyMarkers = true;
    for (let line = token.map[0]; line < token.map[1]; line++) {
      const raw = markdown.slice(at(line), at(line + 1));
      const match = marker.exec(raw);
      if (match) entries.push({ start: at(line), end: at(line + 1), id: match[1], source: sources.has(match[2] as BlockSource) ? match[2] as BlockSource : "user" as const });
      else if (raw.trim()) { onlyMarkers = false; break; }
    }
    if (onlyMarkers) markers.push(...entries);
  }
  if (markers.length > SHARE_LIMITS.files) throw new SharePackageError("too_many_blocks", "分享包的内容块数量过多。");
  if (!markers.length) return { blocks: [{ id: "0001", source: "user", markdown }], mergedContinuationGroups: 0 };
  const groups: typeof markers = [];
  let mergedContinuationGroups = 0, inContinuation = false;
  for (const entry of markers) {
    const previous = groups.at(-1);
    // Windows writes consecutive markers before a merged continuation group,
    // without recording its internal character offsets. Keep that text intact.
    if (previous && previous.end === entry.start) {
      previous.end = entry.end;
      if (!inContinuation) mergedContinuationGroups++;
      inContinuation = true;
    } else { groups.push({ ...entry }); inContinuation = false; }
  }
  const blocks: ImportedShareBlock[] = [];
  if (markdown.slice(0, groups[0].start).trim()) blocks.push({ id: "import_preamble", source: "user", markdown: markdown.slice(0, groups[0].start) });
  for (let index = 0; index < groups.length; index++) {
    const entry = groups[index];
    blocks.push({ id: entry.id, source: entry.source, markdown: markdown.slice(entry.end, groups[index + 1]?.start ?? markdown.length) });
  }
  if (blocks.length > SHARE_LIMITS.files) throw new SharePackageError("too_many_blocks", "分享包的内容块数量过多。");
  const reserved = new Set(blocks.map(block => block.id));
  const used = new Set<string>();
  blocks.forEach((block, index) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(block.id) || used.has(block.id)) {
      let suffix = 0;
      let id = `imported_${index + 1}`;
      while (reserved.has(id) || used.has(id)) id = `imported_${index + 1}_${++suffix}`;
      block.id = id;
    }
    used.add(block.id);
  });
  return { blocks, mergedContinuationGroups };
}
