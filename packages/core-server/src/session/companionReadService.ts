import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { SessionRecord } from "@mathnotes/shared";
import { CompanionAssetError, type CompanionAsset, type CompanionSessionAsset, type CompanionSessionSnapshot } from "../api/networkApiContracts";
import { renderPortableMarkdown } from "../render/portableMarkdown";
import { COMPANION_READER_STYLE } from "./companionReaderStyle";

export interface CompanionSessionStore {
  readSession(notebookId: string, sessionId: string): Promise<SessionRecord>;
  getSessionDir(notebookId: string, sessionId: string): string;
}

export async function buildCompanionSessionSnapshot(args: {
  store: CompanionSessionStore;
  notebookId: string;
  sessionId: string;
}): Promise<CompanionSessionSnapshot> {
  const session = await args.store.readSession(args.notebookId, args.sessionId);
  const sessionDir = args.store.getSessionDir(args.notebookId, args.sessionId);
  const sections: string[] = [];
  const markdownSections: string[] = [];
  const assets = new Map<string, CompanionSessionAsset>();

  for (const block of session.blocks) {
    if (block.type === "pdf") {
      const target = resolve(sessionDir, block.path);
      assertInside(resolve(sessionDir, "assets"), target);
      await stat(target);
      const assetPath = relative(sessionDir, target).replaceAll("\\", "/");
      const id = createHash("sha256").update(assetPath).digest("hex").slice(0, 24);
      assets.set(id, { id, path: assetPath, mimeType: "application/pdf" });
      const pageLabel = block.pageCount && block.pageCount > 0 ? `${block.pageCount} 页` : "页数待确认";
      sections.push(
        `<section class="note-block pdf-block" data-block-id="${escapeAttribute(block.id)}">` +
        `<strong>${escapeHtml(block.sourceName || "PDF 文档")}</strong>` +
        `<span>PDF · ${pageLabel}</span></section>`
      );
      continue;
    }
    if (block.type !== "markdown") continue;
    const markdownPath = resolve(sessionDir, block.path);
    assertInside(sessionDir, markdownPath);
    const markdown = await readFile(markdownPath, "utf8");
    const rendered = await renderCompanionMarkdown({ markdown, markdownPath, sessionDir, assets });
    sections.push(`<section class="note-block" data-block-id="${escapeAttribute(block.id)}">${rendered}</section>`);
    markdownSections.push(`<!-- block:${block.id} source:${block.source} -->\n${markdown.trimEnd()}`);
  }

  const body = sections.join("\n");
  const revision = createHash("sha256")
    .update(session.updatedAt)
    .update("\0")
    .update(body)
    .digest("hex");
  return {
    version: 1,
    notebookId: args.notebookId,
    sessionId: args.sessionId,
    title: session.title,
    revision,
    updatedAt: session.updatedAt,
    blockCount: sections.length,
    markdown: markdownSections.join("\n\n"),
    html: companionHtmlDocument(session.title, body),
    assets: [...assets.values()]
  };
}

export async function readCompanionAsset(args: {
  store: CompanionSessionStore;
  notebookId: string;
  sessionId: string;
  assetPath: string;
}): Promise<CompanionAsset> {
  if (isAbsolute(args.assetPath) || !args.assetPath.replaceAll("\\", "/").startsWith("assets/")) {
    throw new CompanionAssetError("invalid_asset_path", 400);
  }
  const sessionDir = args.store.getSessionDir(args.notebookId, args.sessionId);
  const assetsDir = resolve(sessionDir, "assets");
  const target = resolve(sessionDir, args.assetPath);
  try {
    assertInside(assetsDir, target);
  } catch {
    throw new CompanionAssetError("invalid_asset_path", 400);
  }
  try {
    return { bytes: await readFile(target), mimeType: assetMimeType(target) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CompanionAssetError("asset_not_found", 404);
    }
    throw error;
  }
}

async function renderCompanionMarkdown(args: {
  markdown: string;
  markdownPath: string;
  sessionDir: string;
  assets: Map<string, CompanionSessionAsset>;
}): Promise<string> {
  return renderPortableMarkdown({
    markdown: args.markdown,
    rewriteImage: async (source) => {
      if (/^(?:data:|https?:|\/\/|#)/i.test(source) || isAbsolute(source)) return { source: "", missing: true };
      const target = resolve(dirname(args.markdownPath), source);
      assertInside(resolve(args.sessionDir, "assets"), target);
      try {
        await stat(target);
        const assetPath = relative(args.sessionDir, target).replaceAll("\\", "/");
        const id = createHash("sha256").update(assetPath).digest("hex").slice(0, 24);
        args.assets.set(id, { id, path: assetPath, mimeType: assetMimeType(target) });
        return { source: `mathnotes-companion-asset://${id}` };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { source: "", missing: true };
      }
    }
  });
}

function companionHtmlDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta name="color-scheme" content="light dark">
<style>
${COMPANION_READER_STYLE}
</style></head><body><h1 class="session-title">${escapeHtml(title)}</h1>${body}</body></html>`;
}

function assertInside(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("Companion asset path escapes the session root");
  }
}

function assetMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".pdf": return "application/pdf";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "image/png";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
