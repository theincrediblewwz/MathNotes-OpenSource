export type TextSelection = Readonly<{
  from: number;
  to: number;
  selectedText: string;
}>;

export type SelectionEditValidation =
  | Readonly<{ ok: true; markdown: string }>
  | Readonly<{
      ok: false;
      reason: "invalid_range" | "selection_stale" | "protected_selection";
      protectedSpanId?: string;
    }>;

export function applySelectionEdit(args: {
  markdown: string;
  selection: TextSelection;
  replacement: string;
}): SelectionEditValidation {
  const { from, to, selectedText } = args.selection;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > args.markdown.length) {
    return { ok: false, reason: "invalid_range" };
  }
  if (args.markdown.slice(from, to) !== selectedText) {
    return { ok: false, reason: "selection_stale" };
  }
  const protectedSpan = findProtectedMarkerRanges(args.markdown).find(
    (span) => from < span.to && to > span.from
  );
  if (protectedSpan) {
    return { ok: false, reason: "protected_selection", protectedSpanId: protectedSpan.id };
  }
  return {
    ok: true,
    markdown: `${args.markdown.slice(0, from)}${args.replacement}${args.markdown.slice(to)}`
  };
}

export function findProtectedMarkerRanges(markdown: string): Array<Readonly<{ id: string; from: number; to: number }>> {
  const ranges: Array<Readonly<{ id: string; from: number; to: number }>> = [];
  const pattern =
    /<!-- lock:start id="(?<id>[^"]+)" hash="[a-f0-9]{64}" -->\r?\n?[\s\S]*?\r?\n?<!-- lock:end id="\k<id>" -->/g;
  for (const match of markdown.matchAll(pattern)) {
    if (!match.groups || match.index === undefined) continue;
    ranges.push({ id: match.groups.id, from: match.index, to: match.index + match[0].length });
  }
  return ranges;
}
