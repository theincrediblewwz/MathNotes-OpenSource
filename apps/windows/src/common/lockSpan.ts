export type ProtectedSpan = {
  id: string;
  hash: string;
  content: string;
};

export type ProtectedSpanRange = ProtectedSpan & {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
};

export async function wrapProtectedSpan(args: { markdown: string; id: string }): Promise<string> {
  const hash = await sha256Text(args.markdown);
  return [`<!-- lock:start id="${args.id}" hash="${hash}" -->`, args.markdown, `<!-- lock:end id="${args.id}" -->`].join("\n");
}

export function parseProtectedSpans(markdown: string): ProtectedSpan[] {
  return findProtectedSpanRanges(markdown).map(({ id, hash, content }) => ({
    id,
    hash,
    content
  }));
}

export function findProtectedSpanAtPosition(markdown: string, position: number): ProtectedSpanRange | null {
  return findProtectedSpanRanges(markdown).find((span) => position >= span.contentFrom && position <= span.contentTo) ?? null;
}

export function findProtectedSpanCoveringSelection(markdown: string, from: number, to: number): ProtectedSpanRange | null {
  const selectionFrom = Math.min(from, to);
  const selectionTo = Math.max(from, to);
  return (
    findProtectedSpanRanges(markdown).find(
      (span) => selectionFrom >= span.contentFrom && selectionTo <= span.contentTo
    ) ?? null
  );
}

export function unwrapProtectedSpan(markdown: string, span: ProtectedSpanRange): string {
  return `${markdown.slice(0, span.from)}${span.content}${markdown.slice(span.to)}`;
}

export function findProtectedSpanRanges(markdown: string): ProtectedSpanRange[] {
  const spans: ProtectedSpanRange[] = [];
  const pattern =
    /<!-- lock:start id="(?<id>[^"]+)" hash="(?<hash>[a-f0-9]{64})" -->\r?\n?(?<content>[\s\S]*?)\r?\n?<!-- lock:end id="\k<id>" -->/g;

  for (const match of markdown.matchAll(pattern)) {
    if (!match.groups) {
      continue;
    }
    const rawContent = match.groups.content;
    const content = trimOuterNewlines(rawContent);
    const rawContentOffset = match[0].indexOf(rawContent);
    const contentStart = match.index + rawContentOffset + leadingNewlineLength(rawContent);

    spans.push({
      id: match.groups.id,
      hash: match.groups.hash,
      content,
      from: match.index,
      to: match.index + match[0].length,
      contentFrom: contentStart,
      contentTo: contentStart + content.length
    });
  }

  return spans;
}

export async function sha256Text(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function trimOuterNewlines(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function leadingNewlineLength(value: string): number {
  if (value.startsWith("\r\n")) {
    return 2;
  }
  return value.startsWith("\n") ? 1 : 0;
}
