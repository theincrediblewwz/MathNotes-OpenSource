import { markdownToRenderBlock, type RenderBlock } from "./sessionDocument";

export const maxMarkdownDropBytes = 2 * 1024 * 1024;

export type MarkdownDropDocument = Readonly<{
  name: string;
  markdown: string;
}>;

export async function readMarkdownDropFiles(files: Iterable<File>): Promise<MarkdownDropDocument[]> {
  const accepted = Array.from(files);
  if (accepted.length === 0) throw new Error("没有检测到可导入的 Markdown 文件。");

  const result: MarkdownDropDocument[] = [];
  for (const file of accepted) {
    if (!/\.(?:md|markdown)$/i.test(file.name)) {
      throw new Error(`不支持的文件：${file.name}。请拖入 .md 或 .markdown 文件。`);
    }
    if (file.size > maxMarkdownDropBytes) {
      throw new Error(`${file.name} 超过 2 MiB，未执行导入。`);
    }
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(await readFileBytes(file));
    if (!markdown.trim()) throw new Error(`${file.name} 是空文档，未执行导入。`);
    result.push({ name: file.name, markdown });
  }
  return result;
}

function readFileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${file.name}`));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error(`无法读取 ${file.name}`));
    };
    reader.readAsArrayBuffer(file);
  });
}

export function markdownDropTitle(documents: readonly MarkdownDropDocument[]): string {
  const first = documents[0]?.name.replace(/\.(?:md|markdown)$/i, "").trim();
  return first || "导入的 Markdown";
}

export function markdownDropRenderBlocks(documents: readonly MarkdownDropDocument[]): RenderBlock[] {
  return documents.map((document, index) => markdownToRenderBlock({
    id: `temporary-preview-${index + 1}`,
    sourceId: `temporary-source-${index + 1}`,
    sourceLine: 1,
    sourceBlockId: `temporary-${index + 1}`,
    sourceLabel: document.name,
    sourceBlockLine: 1,
    sourceBlockLineCount: document.markdown.split(/\r?\n/).length,
    markdown: document.markdown
  }));
}
