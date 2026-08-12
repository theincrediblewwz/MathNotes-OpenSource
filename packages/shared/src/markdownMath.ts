export function normalizeMathForPortableMarkdown(markdown: string): string {
  const normalized = markdown
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, content: string) => `$${content.trim()}$`)
    .replace(/(^|\n)\\\[\s*\n?([\s\S]*?)\n?\\\](?=\n|$)/g, (_, prefix: string, content: string) => {
      return `${prefix}$$\n${content.trim()}\n$$`;
    });
  return separateDisplayMathDelimiters(normalized);
}

function separateDisplayMathDelimiters(markdown: string): string {
  const output: string[] = [];
  let inCodeFence = false;
  let inDisplayMath = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (line.trimStart().startsWith("```")) {
      output.push(line);
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence || !line.includes("$$")) {
      if (!inCodeFence && !inDisplayMath && output.at(-1) === "$$" && line.trim()) output.push("");
      output.push(line);
      continue;
    }

    const indentation = line.match(/^\s*/)?.[0] ?? "";
    let cursor = 0;
    for (;;) {
      const delimiterIndex = line.indexOf("$$", cursor);
      if (delimiterIndex === -1) {
        pushPortableMarkdownSegment(output, line.slice(cursor), inDisplayMath, indentation);
        break;
      }
      pushPortableMarkdownSegment(output, line.slice(cursor, delimiterIndex), inDisplayMath, indentation);
      pushDisplayMathDelimiter(output, inDisplayMath, indentation);
      inDisplayMath = !inDisplayMath;
      cursor = delimiterIndex + 2;
    }
  }

  return output.join("\n");
}

function pushPortableMarkdownSegment(
  output: string[],
  segment: string,
  inDisplayMath: boolean,
  indentation: string
): void {
  const normalized = inDisplayMath ? `${indentation}${segment.trim()}` : segment.trimEnd();
  if (!normalized.trim()) return;
  if (!inDisplayMath && output.at(-1) === "$$") output.push("");
  output.push(normalized);
}

function pushDisplayMathDelimiter(output: string[], isClosingDelimiter: boolean, indentation: string): void {
  if (!isClosingDelimiter && output.length > 0 && output.at(-1)?.trim()) output.push("");
  output.push(`${indentation}$$`);
}
