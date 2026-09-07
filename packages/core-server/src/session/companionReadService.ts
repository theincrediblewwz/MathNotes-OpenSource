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
        `<section class="note-block pdf-block" id="mathnotes-block-${escapeAttribute(block.id)}" data-block-id="${escapeAttribute(block.id)}">` +
        `<strong>${escapeHtml(block.sourceName || "PDF 文档")}</strong>` +
        `<span>PDF · ${pageLabel}</span></section>`
      );
      continue;
    }
    if (block.type !== "markdown") continue;
    const markdownPath = resolve(sessionDir, block.path);
    assertInside(sessionDir, markdownPath);
    const markdown = await readFile(markdownPath, "utf8");
    const rendered = await renderCompanionMarkdown({ markdown, markdownPath, sessionDir, assets, blockId: block.id });
    sections.push(`<section class="note-block" id="mathnotes-block-${escapeAttribute(block.id)}" data-block-id="${escapeAttribute(block.id)}">${rendered}</section>`);
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
  blockId: string;
}): Promise<string> {
  const rendered = await renderPortableMarkdown({
    markdown: args.markdown,
    rewriteImage: async (source) => {
      let decoded: string;
      try { decoded = decodeURIComponent(source); }
      catch { return { source: "", missing: true }; }
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(decoded) || decoded.includes("\0") || isAbsolute(decoded)) return { source: "", missing: true };
      const target = resolve(dirname(args.markdownPath), decoded);
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
  const anchored = new Set<string>();
  return rendered.replace(/<img\b[^>]*>/gi, image => {
    const assetId = image.match(/\bsrc="mathnotes-companion-asset:\/\/([a-f0-9]{24})"/)?.[1];
    if (!assetId) return image;
    const anchor = anchored.has(assetId) ? "" : ` id="mathnotes-block-${escapeAttribute(args.blockId)}-asset-${assetId}"`;
    anchored.add(assetId);
    return image.replace(/^<img\b/i, `<img${anchor} data-companion-asset-id="${assetId}"`);
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
